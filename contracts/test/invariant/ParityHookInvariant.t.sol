// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {Fixture} from "../utils/Fixture.sol";
import {RevertDecoder} from "../utils/Helpers.sol";
import {ParityHook} from "../../src/ParityHook.sol";
import {IParityHook} from "../../src/interfaces/IParityHook.sol";
import {MockIssuerToken} from "../../src/mocks/MockIssuerToken.sol";

/// @notice Drives ParityHook through PoolSwapTest / PoolModifyLiquidityTest with fixed adapter ratios.
/// @dev Value unit W = raw * spt * 10^(18 - decimals): exact integer share value scaled by 1e36, so comparisons
///      between tokens of different decimals are exact rationals by construction.
contract ParityHandler is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint256 constant OPEN_TS = 1790692200;
    uint256 constant CLOSED_TS = 1790424000;

    IPoolManager public manager;
    ParityHook public hook;
    PoolSwapTest public swapRouter;
    PoolModifyLiquidityTest public lpRouter;
    MockIssuerToken public mcb;
    MockIssuerToken public maaplx;
    PoolKey public key;
    address[] public actors;

    // Ghosts.
    int256 public depositedW;
    int256 public withdrawnW;
    int256 public fillGainW; // sum over fills of W(out) + W(fee) - W(in); must stay <= 0
    uint256 public fills;
    uint256 public fallThroughs;
    uint256 public pegRejections;
    bool public unsettledSeen;
    bool public pegViolationAfterFallThrough;
    bool public unexpectedRevert;
    bytes public lastUnexpected;

    struct Position {
        int24 lower;
        int24 upper;
        uint128 liquidity;
    }

    Position[] public positions;

    constructor(
        IPoolManager m,
        ParityHook h,
        PoolSwapTest sr,
        PoolModifyLiquidityTest lr,
        MockIssuerToken a,
        MockIssuerToken b,
        PoolKey memory k
    ) {
        manager = m;
        hook = h;
        swapRouter = sr;
        lpRouter = lr;
        mcb = a;
        maaplx = b;
        key = k;
        a.approve(address(h), type(uint256).max);
        b.approve(address(h), type(uint256).max);
        a.approve(address(lr), type(uint256).max);
        b.approve(address(lr), type(uint256).max);
        for (uint256 i; i < 3; i++) {
            address actor = address(uint160(0xAC7000 + i));
            actors.push(actor);
            vm.startPrank(actor);
            a.approve(address(sr), type(uint256).max);
            b.approve(address(sr), type(uint256).max);
            vm.stopPrank();
        }
    }

    function w(MockIssuerToken t, uint256 raw) public view returns (int256) {
        return int256(raw * t.multiplier() * 10 ** (18 - t.decimals()));
    }

    function inventoryW() public view returns (int256) {
        return w(mcb, hook.inventory(Currency.wrap(address(mcb)))) + w(maaplx, hook.inventory(Currency.wrap(address(maaplx))));
    }

    function _tok(bool isMcb) internal view returns (MockIssuerToken) {
        return isMcb ? mcb : maaplx;
    }

    function _zfo(bool mcbIn) internal view returns (bool) {
        return (Currency.unwrap(key.currency0) == address(mcb)) == mcbIn;
    }

    function _record(bytes memory err) internal {
        bytes4 sel = RevertDecoder.selectorOf(err);
        if (sel == IPoolManager.CurrencyNotSettled.selector) unsettledSeen = true;
    }

    // ---------------------------------------------------------------- actions

    function swap(uint256 actorSeed, bool mcbIn, bool exactIn, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        MockIssuerToken tIn = _tok(mcbIn);
        MockIssuerToken tOut = _tok(!mcbIn);
        amount = bound(amount, 1, 3000 * (exactIn ? 10 ** tIn.decimals() : 10 ** tOut.decimals()));
        int256 amt = exactIn ? -int256(amount) : int256(amount);
        bool z = _zfo(mcbIn);
        IParityHook.Quote memory q = hook.quote(key, z, amt);
        uint256 need = exactIn ? amount : (q.fillable ? q.amountIn : amount * 2 + 10 ** tIn.decimals());
        tIn.mint(actor, need);
        vm.prank(actor);
        try swapRouter.swap(
            key,
            SwapParams(z, amt, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            abi.encode(uint8(1), actor, bytes32(0))
        ) returns (BalanceDelta d) {
            int128 dIn = z ? d.amount0() : d.amount1();
            int128 dOut = z ? d.amount1() : d.amount0();
            uint256 paid = uint256(uint128(-dIn));
            uint256 got = uint256(uint128(dOut));
            if (q.fillable) {
                fills++;
                assertEq(paid, q.amountIn);
                assertEq(got, q.amountOut);
                fillGainW += w(tOut, got) + w(tOut, q.feeAmount) - w(tIn, paid);
            } else {
                fallThroughs++;
                if (hook.pegStatus(key).tripped) pegViolationAfterFallThrough = true;
            }
        } catch (bytes memory err) {
            _record(err);
            bool expected;
            if (!q.fillable && RevertDecoder.selectorOf(err) == bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)"))) {
                (,,, bytes memory inner) = RevertDecoder.unwrap(err);
                if (RevertDecoder.selectorOf(inner) == IParityHook.PegGuardTripped.selector) {
                    pegRejections++;
                    expected = true;
                }
            }
            // Fall-through swaps that exhaust liquidity or hit the price limit are legitimate rejections.
            if (!q.fillable) expected = true;
            if (!expected) {
                unexpectedRevert = true;
                lastUnexpected = err;
            }
        }
    }

    function deposit(bool isMcb, uint256 amount) external {
        MockIssuerToken t = _tok(isMcb);
        amount = bound(amount, 1, 5000 * 10 ** t.decimals());
        t.mint(address(this), amount);
        try hook.depositInventory(Currency.wrap(address(t)), amount) {
            depositedW += w(t, amount);
        } catch (bytes memory err) {
            _record(err);
            unexpectedRevert = true;
            lastUnexpected = err;
        }
    }

    function withdraw(bool isMcb, uint256 amount) external {
        MockIssuerToken t = _tok(isMcb);
        uint256 inv = hook.inventory(Currency.wrap(address(t)));
        if (inv == 0) return;
        amount = bound(amount, 1, inv);
        try hook.withdrawInventory(Currency.wrap(address(t)), amount, address(this)) {
            withdrawnW += w(t, amount);
        } catch (bytes memory err) {
            _record(err);
            unexpectedRevert = true;
            lastUnexpected = err;
        }
    }

    /// @dev The owner re-prices the base fee within bounds (replaces the removed fee sweep).
    function setBaseFee(uint24 pips) external {
        pips = uint24(bound(pips, 0, hook.MAX_BASE_FEE_PIPS()));
        vm.prank(hook.owner());
        hook.setBaseFeePips(pips);
    }

    function addLiquidity(uint256 halfWidthSeed, uint256 liquiditySeed) external {
        (, int24 tick,,) = manager.getSlot0(key.toId());
        int24 half = int24(int256(bound(halfWidthSeed, 1, 30))) * 10;
        int24 lower = _floor(tick - half);
        int24 upper = _floor(tick + half) + 10;
        uint128 liq = uint128(bound(liquiditySeed, 1e9, 1e15));
        mcb.mint(address(this), 1e30);
        maaplx.mint(address(this), 1e30);
        try lpRouter.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(uint256(liq)), 0), "") {
            positions.push(Position(lower, upper, liq));
        } catch (bytes memory err) {
            _record(err);
        }
    }

    function removeLiquidity(uint256 idx) external {
        if (positions.length == 0) return;
        idx = idx % positions.length;
        Position memory p = positions[idx];
        try lpRouter.modifyLiquidity(key, ModifyLiquidityParams(p.lower, p.upper, -int256(uint256(p.liquidity)), 0), "") {
            positions[idx] = positions[positions.length - 1];
            positions.pop();
        } catch (bytes memory err) {
            _record(err);
            unexpectedRevert = true;
            lastUnexpected = err;
        }
    }

    function warp(bool open, uint256 offset) external {
        offset = bound(offset, 0, 5 hours);
        vm.warp((open ? OPEN_TS : CLOSED_TS) + offset);
    }

    function _floor(int24 t) internal pure returns (int24) {
        int24 c = t / 10;
        if (t < 0 && t % 10 != 0) c--;
        return c * 10;
    }
}

abstract contract ParityHookInvariantBase is Fixture {
    using TransientStateLibrary for IPoolManager;

    ParityHandler internal handler;

    function setUp() public virtual override {
        super.setUp();
        handler = new ParityHandler(manager, hook, swapRouter, lpRouter, mcb, maaplx, key);
        hook.setKeeper(address(handler), true);
        mcb.transferOwnership(address(handler));
        maaplx.transferOwnership(address(handler));
        eligibility.setTrustedRouter(address(swapRouter), true);
        // Initial inventory and liquidity through the handler, so ghosts include them.
        handler.deposit(true, 8000 * one(mcb));
        handler.deposit(false, 12150 * one(maaplx));
        handler.addLiquidity(12, 1e14);
        targetContract(address(handler));
    }

    function invariant_inventorySharesNonDecreasing() public view {
        // Share value held as inventory, net of keeper flows, never decreases (fills are at parity minus fee).
        assertGe(handler.inventoryW() + handler.withdrawnW() - handler.depositedW(), 0);
    }

    function invariant_noExtractionBeyondFee() public view {
        // For fills, value out plus the fee charged never exceeds value in: no sequence gains vs parity.
        assertLe(handler.fillGainW(), 0);
    }

    function invariant_poolManagerDeltasSettled() public view {
        assertEq(manager.getNonzeroDeltaCount(), 0);
        assertFalse(handler.unsettledSeen());
        assertFalse(handler.unexpectedRevert());
    }

    function invariant_claimsEqualInventory() public view {
        for (uint256 i; i < 2; i++) {
            Currency c = i == 0 ? cur(mcb) : cur(maaplx);
            uint256 claims = manager.balanceOf(address(hook), c.toId());
            assertEq(claims, hook.inventory(c), "fees stay in inventory");
            assertGe(MockIssuerToken(Currency.unwrap(c)).balanceOf(address(manager)), claims);
        }
    }

    function invariant_pegWithinBandAfterAnySuccessfulFallThrough() public view {
        assertFalse(handler.pegViolationAfterFallThrough());
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 50
/// forge-config: default.invariant.fail-on-revert = true
contract ParityHookInvariant_McbC0Test is ParityHookInvariantBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 50
/// forge-config: default.invariant.fail-on-revert = true
contract ParityHookInvariant_MaaplxC0Test is ParityHookInvariantBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
