// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Fixture} from "./utils/Fixture.sol";
import {SwapRouterMulti} from "./utils/SwapRouterMulti.sol";
import {ForeignUnlocker, ClaimDonor, RevertDecoder} from "./utils/Helpers.sol";
import {Attestation} from "../src/EASEligibility.sol";
import {IParityHook} from "../src/interfaces/IParityHook.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {IIssuerRegistry} from "../src/interfaces/IIssuerRegistry.sol";
import {MockIssuerToken} from "../src/mocks/MockIssuerToken.sol";
import {StaticAdapter} from "../src/adapters/StaticAdapter.sol";
import {CanonicalShares} from "../src/libraries/CanonicalShares.sol";

/// @notice Every test runs under both currency orderings (concrete suites at the bottom).
abstract contract ParityHookBase is Fixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint256 internal INV_MCB;
    uint256 internal INV_MAAPLX;
    uint256 internal ONE_MCB;
    uint256 internal ONE_MAAPLX;

    function setUp() public virtual override {
        super.setUp();
        ONE_MCB = one(mcb);
        ONE_MAAPLX = one(maaplx);
        INV_MCB = 8000 * one(mcb);
        INV_MAAPLX = 12150 * one(maaplx);
        seedInventory(INV_MCB, INV_MAAPLX);
        fund(demo, 1_000_000 * one(mcb), 1_000_000 * one(maaplx));
    }

    // ---------------------------------------------------------------- helpers

    function _wrapped(bytes4 hookSelector, bytes memory inner) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookSelector,
            inner,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _swapErr(address who, bool mcbIn, int256 amt, bytes memory data) internal returns (bytes memory err) {
        bool z = zfo(mcbIn);
        vm.prank(who);
        try swapRouter.swap(
            key,
            SwapParams(z, amt, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            data
        ) {
            revert("expected revert");
        } catch (bytes memory e) {
            err = e;
        }
    }

    function _innerSelector(bytes memory err) internal pure returns (bytes4 hookSel, bytes4 innerSel) {
        (bytes4 outer,, bytes4 sel, bytes memory reason) = RevertDecoder.unwrap(err);
        assertEq(outer, CustomRevert.WrappedError.selector, "not wrapped");
        return (sel, RevertDecoder.selectorOf(reason));
    }

    /// @dev A third registered AAPL token (18 decimals, spt 1e18) for fresh-pool initialisation tests.
    function _thirdToken(bytes32 underlying, bool pausedInRegistry) internal returns (MockIssuerToken t) {
        t = new MockIssuerToken("Third", "T3", 18, 1e18);
        StaticAdapter a = new StaticAdapter(address(t), underlying, "static", 1e18, address(this));
        registry.add(address(a));
        if (pausedInRegistry) registry.setPaused(address(t), true);
    }

    function _keyWith(address a, address b, uint24 fee, int24 spacing) internal view returns (PoolKey memory k) {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        k = PoolKey(Currency.wrap(lo), Currency.wrap(hi), fee, spacing, IHooks(address(hook)));
    }

    function _attest(address who, string memory country) internal returns (bytes32 uid) {
        uid = keccak256(abi.encode(who, country));
        eas.set(
            Attestation({
                uid: uid,
                schema: SCHEMA,
                time: uint64(block.timestamp),
                expirationTime: 0,
                revocationTime: 0,
                refUID: 0,
                recipient: who,
                attester: ATTESTER,
                revocable: true,
                data: abi.encode(country)
            })
        );
    }

    function _removeInventory(MockIssuerToken t) internal {
        uint256 inv = hook.inventory(cur(t));
        if (inv > 0) hook.withdrawInventory(cur(t), inv, address(this));
    }

    // ---------------------------------------------------------------- initialisation

    function test_hookFlags0x20C8() public view {
        assertEq(uint160(address(hook)) & 0x3fff, 0x20C8);
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize && p.beforeSwap && p.afterSwap && p.beforeSwapReturnDelta);
        assertFalse(p.afterInitialize || p.beforeAddLiquidity || p.afterSwapReturnDelta || p.beforeDonate);
        assertEq(hook.DEFAULT_BASE_FEE_PIPS(), 200);
        assertEq(hook.baseFeePips(), 200);
        assertEq(hook.MAX_BASE_FEE_PIPS(), 5000);
        assertEq(hook.SKEW_FEE_PIPS(), 1500);
        assertEq(hook.SKEW_FEE_CAP_PIPS(), 5000);
        assertEq(hook.PEG_GUARD_BPS(), 50);
        assertEq(hook.HOOK_DATA_VERSION(), 2);
        assertEq(address(hook.poolManager()), address(manager));
        assertEq(address(hook.registry()), address(registry));
        assertEq(address(hook.eligibility()), address(eligibility));
        assertTrue(hook.isKeeper(address(this)));
    }

    function test_beforeInitializeDynamicFeeRequired() public {
        PoolKey memory k = _keyWith(address(mcb), address(maaplx), 3000, 10);
        uint160 sqrtP = paritySqrtPriceX96();
        vm.expectRevert(
            _wrapped(IHooks.beforeInitialize.selector, abi.encodeWithSelector(IParityHook.DynamicFeeRequired.selector, 3000))
        );
        manager.initialize(k, sqrtP);
        // The frozen PoolKey itself was accepted and stores lpFee 0 (dynamic).
        (,,, uint24 lpFee) = manager.getSlot0(poolId);
        assertEq(lpFee, 0);
    }

    function test_beforeInitializeUnsupportedPool_differentUnderlying() public {
        MockIssuerToken t = _thirdToken("MSFT", false);
        PoolKey memory k = _keyWith(address(t), address(maaplx), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(
                    IParityHook.UnsupportedPool.selector, Currency.unwrap(k.currency0), Currency.unwrap(k.currency1)
                )
            )
        );
        manager.initialize(k, uint160(1 << 96));
    }

    function test_beforeInitializeUnsupportedPool_inactive() public {
        MockIssuerToken t = _thirdToken(AAPL, true);
        PoolKey memory k = _keyWith(address(t), address(maaplx), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(
                    IParityHook.UnsupportedPool.selector, Currency.unwrap(k.currency0), Currency.unwrap(k.currency1)
                )
            )
        );
        manager.initialize(k, uint160(1 << 96));
        // Unregistered token: also unsupported.
        MockIssuerToken stray = new MockIssuerToken("Stray", "S", 18, 1e18);
        PoolKey memory k2 = _keyWith(address(stray), address(maaplx), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(
                    IParityHook.UnsupportedPool.selector, Currency.unwrap(k2.currency0), Currency.unwrap(k2.currency1)
                )
            )
        );
        manager.initialize(k2, uint160(1 << 96));
    }

    function test_beforeInitializeRejectsOffParityPrice() public {
        MockIssuerToken t = _thirdToken(AAPL, false);
        PoolKey memory k = _keyWith(address(t), address(maaplx), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10);
        // Parity is 1:1 (both 18 decimals, spt 1e18). sqrt(1.01) * 2^96 is ~100 bps off.
        uint160 off = uint160(uint256(79623317895830914510639640423) * 1004987562 / 1e9);
        vm.expectRevert();
        manager.initialize(k, off);
        (bool ok, bytes memory err) = address(manager).call(abi.encodeCall(IPoolManager.initialize, (k, off)));
        assertFalse(ok);
        (bytes4 hs, bytes4 inner) = _innerSelector(err);
        assertEq(hs, IHooks.beforeInitialize.selector);
        assertEq(inner, IParityHook.PegGuardTripped.selector);
        // ~20 bps off initialises fine.
        manager.initialize(k, uint160(uint256(79228162514264337593543950336) * 1001 / 1000));
    }

    function test_beforeInitializeRejectsTickSpacing() public {
        PoolKey memory k = _keyWith(address(mcb), address(maaplx), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60);
        uint160 sqrtP = paritySqrtPriceX96();
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(
                    IParityHook.UnsupportedPool.selector, Currency.unwrap(k.currency0), Currency.unwrap(k.currency1)
                )
            )
        );
        manager.initialize(k, sqrtP);
    }

    function test_poolRegisteredEvent() public {
        MockIssuerToken t = _thirdToken(AAPL, false);
        PoolKey memory k = _keyWith(address(t), address(maaplx), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.PoolRegistered(
            k.toId(), Currency.unwrap(k.currency0), Currency.unwrap(k.currency1), AAPL, 10
        );
        manager.initialize(k, uint160(1 << 96));
    }

    function test_callbacksOnlyManager() public {
        SwapParams memory p = SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1);
        vm.expectRevert(IParityHook.NotPoolManager.selector);
        hook.beforeInitialize(address(this), key, uint160(1 << 96));
        vm.expectRevert(IParityHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, p, "");
        vm.expectRevert(IParityHook.NotPoolManager.selector);
        hook.afterSwap(address(this), key, p, BalanceDelta.wrap(0), "");
    }

    // ---------------------------------------------------------------- keepers and fees

    function test_setKeeperOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hook.setKeeper(alice, true);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.KeeperSet(alice, true);
        hook.setKeeper(alice, true);
        assertTrue(hook.isKeeper(alice));
        hook.setKeeper(alice, false);
        assertFalse(hook.isKeeper(alice));
    }

    function test_depositWithdrawKeeperOnlyAndEvents() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IParityHook.NotKeeper.selector, alice));
        hook.depositInventory(cur(mcb), 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IParityHook.NotKeeper.selector, alice));
        hook.withdrawInventory(cur(mcb), 1, alice);

        vm.expectRevert(IParityHook.ZeroAmount.selector);
        hook.depositInventory(cur(mcb), 0);
        vm.expectRevert(IParityHook.ZeroAmount.selector);
        hook.withdrawInventory(cur(mcb), 0, alice);
        MockIssuerToken stray = new MockIssuerToken("Stray", "S", 18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.UnknownIssuer.selector, address(stray)));
        hook.depositInventory(cur(stray), 1);

        mcb.mint(address(this), 5 * ONE_MCB);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.InventoryChanged(address(mcb), address(this), 0, int256(5 * ONE_MCB), INV_MCB + 5 * ONE_MCB);
        hook.depositInventory(cur(mcb), 5 * ONE_MCB);
        assertEq(hook.inventory(cur(mcb)), INV_MCB + 5 * ONE_MCB);

        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.InventoryChanged(address(mcb), address(this), 1, -int256(3 * ONE_MCB), INV_MCB + 2 * ONE_MCB);
        hook.withdrawInventory(cur(mcb), 3 * ONE_MCB, alice);
        assertEq(mcb.balanceOf(alice), 3 * ONE_MCB);

        uint256 inv = hook.inventory(cur(mcb));
        vm.expectRevert(
            abi.encodeWithSelector(IParityHook.InsufficientInventory.selector, address(mcb), inv, inv + 1)
        );
        hook.withdrawInventory(cur(mcb), inv + 1, alice);
    }

    function test_feesStayInInventoryForTheLP() public {
        IParityHook.Quote memory q = quoteOf(true, -int256(100 * ONE_MCB));
        assertGt(q.feeAmount, 0);
        swapAs(demo, true, -int256(100 * ONE_MCB));
        // Only the net output left: the fee is part of the keeper's (LP's) inventory, withdrawable in full.
        uint256 inv = hook.inventory(cur(maaplx));
        assertEq(inv, INV_MAAPLX - q.amountOut);
        assertEq(manager.balanceOf(address(hook), cur(maaplx).toId()), inv);
        hook.withdrawInventory(cur(maaplx), inv, address(this));
        assertEq(hook.inventory(cur(maaplx)), 0);
    }

    function test_setBaseFeePipsOwnerOnlyAndBounded() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hook.setBaseFeePips(100);
        vm.expectRevert(abi.encodeWithSelector(IParityHook.BaseFeeTooHigh.selector, 5001, 5000));
        hook.setBaseFeePips(5001);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.BaseFeeSet(0);
        hook.setBaseFeePips(0);
        // A rebalancing trade then pays nothing at all.
        IParityHook.Quote memory q = quoteOf(true, -int256(100 * ONE_MCB));
        assertEq(q.fee.totalPips, 0);
        assertEq(q.feeAmount, 0);
        hook.setBaseFeePips(350);
        assertEq(quoteOf(true, -int256(100 * ONE_MCB)).fee.totalPips, 350);
    }

    function test_inventorySharesView() public {
        assertEq(hook.inventoryShares(cur(mcb)), CanonicalShares.toSharesDown(INV_MCB, mcb.multiplier(), mcb.decimals()));
        assertEq(hook.inventoryShares(cur(maaplx)), 12150e18);
        MockIssuerToken stray = new MockIssuerToken("Stray", "S", 18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.UnknownIssuer.selector, address(stray)));
        hook.inventoryShares(cur(stray));
    }

    // ---------------------------------------------------------------- swaps and fills

    function _assertFill(bool mcbIn, int256 amt) internal {
        IParityHook.Quote memory q = quoteOf(mcbIn, amt);
        assertTrue(q.fillable, "fillable");
        MockIssuerToken tOut = mcbIn ? maaplx : mcb;
        uint256 invOutBefore = hook.inventory(cur(tOut));
        BalanceDelta d = swapAs(demo, mcbIn, amt);
        (uint256 paid, uint256 got) = inOut(d, mcbIn);
        assertEq(paid, q.amountIn, "paid");
        assertEq(got, q.amountOut, "received");
        if (amt < 0) assertEq(paid, uint256(-amt));
        else assertEq(got, uint256(amt));
        assertEq(q.grossOut - q.amountOut, q.feeAmount, "fee");
        assertEq(invOutBefore - hook.inventory(cur(tOut)), q.amountOut, "only the net output leaves inventory");
        assertEq(manager.getNonzeroDeltaCount(), 0);
    }

    function test_exactInBothDirections() public {
        _assertFill(true, -int256(100 * ONE_MCB));
        _assertFill(false, -int256(50 * ONE_MAAPLX));
    }

    function test_exactOutBothDirections() public {
        _assertFill(true, int256(77 * ONE_MAAPLX));
        _assertFill(false, int256(33 * ONE_MCB));
    }

    function test_sixEighteenDecimalExactInOut() public {
        assertEq(mcb.decimals(), 6);
        assertEq(maaplx.decimals(), 18);
        // 1 raw mcbAAPL (1e-6) -> 1.0125e12 raw mAAPLx gross.
        IParityHook.Quote memory q = quoteOf(true, -1);
        assertEq(q.shares, 1012500000000);
        assertEq(q.grossOut, 1012500000000);
        _assertFill(true, -1);
        // Exact-out 1 wei of mAAPLx still costs one whole raw mcbAAPL (ceil).
        q = quoteOf(true, 1);
        assertEq(q.amountIn, 1);
        _assertFill(true, 1);
        // Exact-out 1e12 wei mcbAAPL side: buying 1 raw mcbAAPL costs ceil(1.0125e12 * grossFactor) wei.
        q = quoteOf(false, 1);
        assertGt(q.amountIn, 1012500000000);
        _assertFill(false, 1);
    }

    function test_quoteMatchesExecution(uint256 amount, bool mcbIn, bool exactIn) public {
        MockIssuerToken tIn = mcbIn ? mcb : maaplx;
        MockIssuerToken tOut = mcbIn ? maaplx : mcb;
        uint256 cap = exactIn ? 900 * one(tIn) : 900 * one(tOut);
        amount = bound(amount, 1, cap);
        int256 amt = exactIn ? -int256(amount) : int256(amount);
        IParityHook.Quote memory q = quoteOf(mcbIn, amt);
        if (!q.fillable) {
            assertTrue(q.amountOut == 0 || q.amountIn == 0);
            return;
        }
        _assertFill(mcbIn, amt);
    }

    function test_eventsOrderFill() public {
        vm.recordLogs();
        swapAs(demo, true, -int256(10 * ONE_MCB));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32[] memory seen = new bytes32[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook)) seen[n++] = logs[i].topics[0];
        }
        assertEq(n, 4);
        assertEq(seen[0], IParityHook.InventoryFill.selector);
        assertEq(seen[1], IParityHook.InventoryChanged.selector);
        assertEq(seen[2], IParityHook.InventoryChanged.selector);
        assertEq(seen[3], IParityHook.Converted.selector);
    }

    // ---------------------------------------------------------------- fall-through

    function test_insufficientInventoryFallsThroughReason1() public {
        seedLiquidity(1000 * ONE_MCB, 1012 * ONE_MAAPLX, 120);
        _removeInventory(maaplx);
        uint256 amt = 1 * ONE_MCB;
        IParityHook.Quote memory q = quoteOf(true, -int256(amt));
        assertFalse(q.fillable);
        assertGt(q.amountOut, 0);
        uint24 pips = hook.feeBreakdown(key).totalPips;
        vm.expectEmit(true, true, true, false, address(hook));
        emit IParityHook.FallThrough(poolId, demo, address(swapRouter), zfo(true), 1, 0, 0, pips, 0);
        BalanceDelta d = swapAs(demo, true, -int256(amt));
        (uint256 paid, uint256 got) = inOut(d, true);
        assertEq(paid, amt);
        assertGt(got, 0);
        assertEq(hook.inventory(cur(mcb)), INV_MCB, "inventory untouched");
    }

    function testFuzz_dustFallsThroughReason2(uint256 wei_) public {
        seedLiquidity(1000 * ONE_MCB, 1012 * ONE_MAAPLX, 120);
        // mAAPLx -> mcbAAPL below one raw mcbAAPL of shares: grossOut rounds to 0.
        wei_ = bound(wei_, 1, 1012499999999);
        IParityHook.Quote memory q = quoteOf(false, -int256(wei_));
        assertFalse(q.fillable);
        assertEq(q.amountOut, 0);
        vm.recordLogs();
        swapAs(demo, false, -int256(wei_));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == IParityHook.FallThrough.selector) {
                (, uint8 reason,,,,) = abi.decode(logs[i].data, (bool, uint8, int128, int128, uint24, uint256));
                assertEq(reason, 2);
                found = true;
            }
        }
        assertTrue(found);
        assertEq(hook.inventory(cur(mcb)), INV_MCB);
    }

    function test_fallThroughChargesOverrideFee() public {
        seedLiquidity(1000 * ONE_MCB, 1012 * ONE_MAAPLX, 120);
        _removeInventory(maaplx);
        // The trade's own fee (mcbAAPL into a one-sided mcbAAPL book cannot grow |skew|: base only).
        uint24 pips = quoteOf(true, -int256(1 * ONE_MCB)).fee.totalPips;
        assertEq(pips, 200);
        vm.recordLogs();
        swapAs(demo, true, -int256(1 * ONE_MCB));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(manager) && logs[i].topics[0] == IPoolManager.Swap.selector) {
                (,,,,, uint24 fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                assertEq(fee, pips);
                found = true;
            }
        }
        assertTrue(found);
        (,,, uint24 lpFee) = manager.getSlot0(poolId);
        assertEq(lpFee, 0, "override is per-swap");
    }

    function test_fallThroughEventDeltas() public {
        seedLiquidity(1000 * ONE_MCB, 1012 * ONE_MAAPLX, 120);
        _removeInventory(mcb);
        vm.recordLogs();
        BalanceDelta d = swapAs(demo, false, -int256(2 * ONE_MAAPLX));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == IParityHook.FallThrough.selector) {
                (bool z, uint8 reason, int128 a0, int128 a1,, uint256 dev) =
                    abi.decode(logs[i].data, (bool, uint8, int128, int128, uint24, uint256));
                assertEq(z, zfo(false));
                assertEq(reason, 1);
                assertEq(a0, d.amount0());
                assertEq(a1, d.amount1());
                assertLe(dev, 50);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), demo);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), address(swapRouter));
                found = true;
            }
        }
        assertTrue(found);
    }

    function test_pegGuardRevertsInAfterSwap() public {
        seedLiquidity(10 * ONE_MCB, 10 * ONE_MAAPLX, 120);
        _removeInventory(maaplx);
        bytes memory err = _swapErr(demo, true, -int256(50 * ONE_MCB), hookData(demo, 0));
        (bytes4 hs, bytes4 inner) = _innerSelector(err);
        assertEq(hs, IHooks.afterSwap.selector);
        assertEq(inner, IParityHook.PegGuardTripped.selector);
    }

    function test_pegGuardAllowsCorrectiveSwap() public {
        seedLiquidity(1000 * ONE_MCB, 1012 * ONE_MAAPLX, 120);
        _removeInventory(mcb);
        _removeInventory(maaplx);
        // mcbAAPL multiplier +0.8%: the pool now under-prices mcbAAPL by ~80 bps.
        mcb.setMultiplier(mcb.multiplier() * 1008 / 1000);
        assertTrue(hook.pegStatus(key).tripped);
        // Selling more mcbAAPL moves further away: reverts.
        bytes memory err = _swapErr(demo, true, -int256(1 * ONE_MCB), hookData(demo, 0));
        (, bytes4 inner) = _innerSelector(err);
        assertEq(inner, IParityHook.PegGuardTripped.selector);
        // Buying mcbAAPL moves the price back inside the band: succeeds.
        swapAs(demo, false, -int256(600 * ONE_MAAPLX));
        assertFalse(hook.pegStatus(key).tripped);
    }

    // ---------------------------------------------------------------- fees

    function test_feeBreakdownViewIsMarginalSkewIncreasingTrade() public {
        // §10 inventory: 8,100 vs 12,150 shares => |skew| 0.2 => a marginal skew-increasing trade pays ceil(1500 * 0.2).
        IParityHook.FeeBreakdown memory f = hook.feeBreakdown(key);
        assertEq(f.basePips, 200);
        assertEq(f.skewPips, 300);
        assertEq(f.totalPips, 500);
        assertEq(f.skewX18, c0IsMcb() ? -0.2e18 : int256(0.2e18));
        assertEq(f.postSkewX18, f.skewX18);
        assertFalse(f.reducesImbalance);
        // Balanced: no skew fee.
        mcb.mint(address(this), 4000 * ONE_MCB);
        hook.depositInventory(cur(mcb), 4000 * ONE_MCB);
        f = hook.feeBreakdown(key);
        assertEq(f.skewPips, 0);
        assertEq(f.totalPips, 200);
        assertTrue(f.reducesImbalance);
        // One-sided => |skew| = 1 => 1500 (15 bps).
        _removeInventory(mcb);
        f = hook.feeBreakdown(key);
        assertEq(f.skewPips, 1500);
        assertEq(f.totalPips, 1700);
        _removeInventory(maaplx);
        assertEq(hook.feeBreakdown(key).totalPips, 200);
    }

    function test_baseFeeOnly_rebalancingTrade() public {
        // 100 mcbAAPL in reduces |skew| 0.20 -> 0.19 (the book is long mAAPLx): base 2 bps only.
        IParityHook.Quote memory q = quoteOf(true, -int256(100 * ONE_MCB));
        assertTrue(q.fee.reducesImbalance);
        assertEq(q.fee.skewPips, 0);
        assertEq(q.fee.totalPips, 200);
        assertEq(q.feeAmount, 20250000000000000);
        assertEq(q.amountOut, 101229750000000000000);
        (uint256 sharesOut, uint256 baseFee, uint256 skewFee, int256 postSkew, bool reduces) =
            hook.quote(AAPL, address(mcb), address(maaplx), 100 * ONE_MCB);
        assertEq(sharesOut, 101229750000000000000);
        assertEq(baseFee, 20250000000000000);
        assertEq(skewFee, 0);
        assertEq(sharesOut + baseFee + skewFee, 101.25e18, "shares conserved");
        assertEq(postSkew, q.fee.postSkewX18);
        assertTrue(reduces);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.Converted(
            AAPL, address(mcb), address(maaplx), demo, demo, 100 * ONE_MCB, sharesOut, baseFee, 0, postSkew
        );
        BalanceDelta d = swapAs(demo, true, -int256(100 * ONE_MCB));
        (, uint256 got) = inOut(d, true);
        assertEq(got, q.amountOut);
    }

    function test_skewFee_imbalanceIncreasingTrade() public {
        // 100 mAAPLx in: shares 12,150 -> 12,250 vs 8,100 -> 8,000; |post skew| = 4,250 / 20,250 -> ceil(314.8) = 315.
        IParityHook.Quote memory q = quoteOf(false, -int256(100 * ONE_MAAPLX));
        assertTrue(q.fillable);
        assertFalse(q.fee.reducesImbalance);
        assertEq(q.fee.skewPips, 315);
        assertEq(q.fee.totalPips, 515);
        assertEq(q.feeAmount, CanonicalShares.feeOnGross(q.grossOut, 515));
        (uint256 sharesOut, uint256 baseFee, uint256 skewFee,, bool reduces) =
            hook.quote(AAPL, address(maaplx), address(mcb), 100 * ONE_MAAPLX);
        assertFalse(reduces);
        assertEq(sharesOut + baseFee + skewFee, 100e18);
        assertGt(skewFee, baseFee);
        // Exact output of the same net amount lands in the same tier.
        IParityHook.Quote memory qo = quoteOf(false, int256(q.amountOut));
        assertEq(qo.fee.totalPips, 515);
        assertLe(qo.amountIn, q.amountIn);
        BalanceDelta d = swapAs(demo, false, -int256(100 * ONE_MAAPLX));
        (, uint256 got) = inOut(d, false);
        assertEq(got, q.amountOut);
    }

    function test_skewFee_balancedPoolNearBase() public {
        mcb.mint(address(this), 4000 * ONE_MCB);
        hook.depositInventory(cur(mcb), 4000 * ONE_MCB); // 12,150 vs 12,150 shares
        // 100 mcbAAPL (101.25 shares): |post skew| = 202.5 / 24,300 -> ceil(12.5) = 13 pips; 2.13 bps.
        assertEq(quoteOf(true, -int256(100 * ONE_MCB)).fee.totalPips, 213);
        assertEq(quoteOf(false, -int256(100 * ONE_MAAPLX)).fee.totalPips, 213);
    }

    function test_noOffHoursCodePath() public {
        // Same quote on a weekend and at the open: the fee has no market-hours input.
        vm.warp(CLOSED_TS);
        IParityHook.Quote memory closed = quoteOf(false, -int256(100 * ONE_MAAPLX));
        vm.warp(OPEN_TS);
        IParityHook.Quote memory open = quoteOf(false, -int256(100 * ONE_MAAPLX));
        assertEq(closed.fee.totalPips, open.fee.totalPips);
        assertEq(closed.amountOut, open.amountOut);
        // No calendar, off-hours constant or protocol fee sweep exists on the hook.
        string[6] memory gone = [
            "calendar()",
            "OFF_HOURS_MAX_FEE_PIPS()",
            "CLOSED_FEE_PIPS()",
            "MAX_FEE_PIPS()",
            "feesAccrued(address)",
            "sweepFees(address,address)"
        ];
        for (uint256 i; i < gone.length; i++) {
            (bool ok,) = address(hook).staticcall(abi.encodeWithSignature(gone[i], address(0), address(0)));
            assertFalse(ok, gone[i]);
        }
    }

    function test_skewFeeCappedAndFallThroughOverride() public {
        seedLiquidity(1000 * ONE_MCB, 1012 * ONE_MAAPLX, 120);
        // Nearly one-sided (0.5 mcbAAPL vs 12,150 mAAPLx shares): a 1 mAAPLx trade cannot fill, would empty the mcbAAPL
        // side (|post skew| = 1) and falls through at base + the maximum skew fee 1500 (<= the 5000 cap).
        _removeInventory(mcb);
        mcb.mint(address(this), ONE_MCB / 2);
        hook.depositInventory(cur(mcb), ONE_MCB / 2);
        IParityHook.Quote memory q = quoteOf(false, -int256(1 * ONE_MAAPLX));
        assertFalse(q.fillable);
        assertEq(q.fee.skewPips, 1500);
        assertLe(q.fee.skewPips, hook.SKEW_FEE_CAP_PIPS());
        assertEq(q.fee.totalPips, 1700);
        vm.recordLogs();
        swapAs(demo, false, -int256(1 * ONE_MAAPLX));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(manager) && logs[i].topics[0] == IPoolManager.Swap.selector) {
                (,,,,, uint24 fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                assertEq(fee, 1700);
            }
        }
    }

    function test_quoteByAssetRejectsMismatchedWrappers() public {
        vm.expectRevert(abi.encodeWithSelector(IParityHook.UnsupportedPool.selector, address(mcb), address(maaplx)));
        hook.quote(bytes32("NVDA"), address(mcb), address(maaplx), 1);
        vm.expectRevert(abi.encodeWithSelector(IParityHook.UnsupportedPool.selector, address(mcb), address(mcb)));
        hook.quote(AAPL, address(mcb), address(mcb), 1);
        vm.expectRevert(IParityHook.ZeroAmount.selector);
        hook.quote(AAPL, address(mcb), address(maaplx), 0);
    }

    function test_hookDataV2ReportsRecipient() public {
        address payee = makeAddr("payee");
        vm.expectEmit(true, true, true, false, address(hook));
        emit IParityHook.Converted(AAPL, address(mcb), address(maaplx), demo, payee, 0, 0, 0, 0, 0);
        vm.recordLogs();
        swapAsWith(demo, true, -int256(ONE_MCB), abi.encode(uint8(2), demo, bytes32(0), payee));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == IParityHook.Converted.selector) {
                (address sender, address recipient,,,,,) =
                    abi.decode(logs[i].data, (address, address, uint256, uint256, uint256, uint256, int256));
                assertEq(sender, demo);
                assertEq(recipient, payee);
            }
        }
    }

    // ---------------------------------------------------------------- peg status

    function test_checkPegEmitsOnlyOnChange() public {
        vm.recordLogs();
        assertFalse(hook.checkPeg(key));
        assertEq(vm.getRecordedLogs().length, 0);
        mcb.setMultiplier(mcb.multiplier() * 101 / 100);
        IParityHook.PegStatus memory p = hook.pegStatus(key);
        assertTrue(p.tripped);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.PegGuardStatus(poolId, true, p.poolPriceX18, p.parityPriceX18, p.deviationBps);
        assertTrue(hook.checkPeg(key));
        assertTrue(hook.pegTripped(poolId));
        vm.recordLogs();
        assertTrue(hook.checkPeg(key));
        assertEq(vm.getRecordedLogs().length, 0);
        mcb.setMultiplier(1.0125e18);
        vm.expectEmit(true, true, true, false, address(hook));
        emit IParityHook.PegGuardStatus(poolId, false, 0, 0, 0);
        assertFalse(hook.checkPeg(key));
        assertFalse(hook.pegTripped(poolId));
    }

    function test_pegStatusBothOrderings() public view {
        IParityHook.PegStatus memory p = hook.pegStatus(key);
        uint256 parity = c0IsMcb() ? uint256(1.0125e18) : uint256(1e36) / 1.0125e18;
        assertEq(p.parityPriceX18, parity);
        assertLe(p.deviationBps, 1);
        assertFalse(p.tripped);
        (uint160 s,,,) = manager.getSlot0(poolId);
        assertEq(p.poolPriceX18, CanonicalShares.poolPriceX18(s, c0IsMcb() ? 6 : 18, c0IsMcb() ? 18 : 6));
    }

    // ---------------------------------------------------------------- ratios and health

    function test_multiplierRepricesQuote() public {
        IParityHook.Quote memory q0 = quoteOf(true, -int256(100 * ONE_MCB));
        assertEq(q0.shares, 101.25e18);
        mcb.setMultiplier(1.02e18);
        IParityHook.Quote memory q1 = quoteOf(true, -int256(100 * ONE_MCB));
        assertEq(q1.shares, 102e18);
        assertGt(q1.grossOut, q0.grossOut);
        _assertFill(true, -int256(100 * ONE_MCB));
    }

    function test_beforeSwapRevertsAdapterUnhealthy() public {
        mcb.setTransfersPaused(true);
        vm.expectRevert(abi.encodeWithSelector(IParityHook.AdapterUnhealthy.selector, address(mcb)));
        quoteOf(true, -1000);
        bytes memory err = _swapErr(demo, false, -int256(1 * ONE_MAAPLX), hookData(demo, 0));
        assertEq(
            keccak256(err),
            keccak256(
                _wrapped(
                    IHooks.beforeSwap.selector,
                    abi.encodeWithSelector(IParityHook.AdapterUnhealthy.selector, address(mcb))
                )
            )
        );
        // Out-of-bounds multiplier also makes the adapter unhealthy.
        mcb.setTransfersPaused(false);
        mcb.setMultiplier(2e24);
        vm.expectRevert(abi.encodeWithSelector(IParityHook.AdapterUnhealthy.selector, address(mcb)));
        quoteOf(true, -1000);
    }

    function test_registryPauseBlocksSwaps() public {
        registry.setPaused(address(maaplx), true);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(IParityHook.AdapterUnhealthy.selector, address(maaplx))
            )
        );
        swapAs(demo, true, -int256(1 * ONE_MCB));
        registry.setPaused(address(maaplx), false);
        _assertFill(true, -int256(1 * ONE_MCB));
    }

    function test_multiplierJumpArbBoundedAndStoppedByPause() public {
        uint256 size = 1000 * ONE_MAAPLX;
        uint256 startMaaplx = maaplx.balanceOf(demo);
        // Leg 1: buy mcbAAPL with mAAPLx at the old parity.
        BalanceDelta d1 = swapAs(demo, false, -int256(size));
        (, uint256 mcbGot) = inOut(d1, false);
        // Announced +0.4% corporate action on mcbAAPL.
        mcb.setMultiplier(mcb.multiplier() * 1004 / 1000);
        // Leg 2: sell the mcbAAPL back at the new parity.
        IParityHook.Quote memory q2 = quoteOf(true, -int256(mcbGot));
        BalanceDelta d2 = swapAs(demo, true, -int256(mcbGot));
        (, uint256 maaplxBack) = inOut(d2, true);
        assertEq(maaplxBack, q2.amountOut);
        uint256 profit = maaplxBack > size ? maaplxBack - size : 0;
        // Profit is bounded by delta * size minus the fees charged on the way.
        assertLe(profit, size * 4 / 1000 - q2.feeAmount);
        assertEq(maaplx.balanceOf(demo), startMaaplx - size + maaplxBack);

        // With the ops pause across the announced action, the second leg cannot execute.
        BalanceDelta d3 = swapAs(demo, false, -int256(size));
        (, uint256 mcbGot2) = inOut(d3, false);
        registry.setPaused(address(mcb), true);
        mcb.setMultiplier(mcb.multiplier() * 1004 / 1000);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeSwap.selector, abi.encodeWithSelector(IParityHook.AdapterUnhealthy.selector, address(mcb))
            )
        );
        swapAs(demo, true, -int256(mcbGot2));
    }

    // ---------------------------------------------------------------- eligibility and hookData

    function test_demoModeOffBlocksIneligibleSwap() public {
        eligibility.setDemoMode(false);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeSwap.selector, abi.encodeWithSelector(IEligibility.NotEligible.selector, demo, uint8(1))
            )
        );
        swapAs(demo, true, -int256(1 * ONE_MCB));
        bytes32 us = _attest(demo, "US");
        vm.expectRevert(
            _wrapped(
                IHooks.beforeSwap.selector, abi.encodeWithSelector(IEligibility.NotEligible.selector, demo, uint8(7))
            )
        );
        swapAsWith(demo, true, -int256(1 * ONE_MCB), hookData(demo, us));
        bytes32 fr = _attest(demo, "FR");
        swapAsWith(demo, true, -int256(1 * ONE_MCB), hookData(demo, fr));
    }

    function test_untrustedSenderClaimIgnored() public {
        eligibility.setDemoMode(false);
        bytes32 uid = _attest(alice, "FR");
        PoolSwapTest untrusted = new PoolSwapTest(manager);
        vm.startPrank(demo);
        mcb.approve(address(untrusted), type(uint256).max);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(IEligibility.NotEligible.selector, address(untrusted), uint8(4))
            )
        );
        untrusted.swap(
            key,
            SwapParams(zfo(true), -int256(ONE_MCB), zfo(true) ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            hookData(alice, uid)
        );
        vm.stopPrank();
    }

    function test_invalidHookDataReverts(uint256 len, uint256 version, uint256 dirty) public {
        bytes memory bad;
        uint256 mode = len % 3;
        if (mode == 0) {
            len = bound(len, 1, 200);
            if (len == 96 || len == 128) len = 97;
            bad = new bytes(len);
        } else if (mode == 1) {
            version = bound(version, 0, type(uint256).max);
            if (version == 1) version = 2;
            bad = abi.encode(version, demo, bytes32(0));
        } else {
            dirty = bound(dirty, 1, type(uint96).max);
            bad = abi.encode(uint256(1), (dirty << 160) | uint256(uint160(demo)), bytes32(0));
        }
        vm.expectRevert(_wrapped(IHooks.beforeSwap.selector, abi.encodeWithSelector(IParityHook.InvalidHookData.selector)));
        swapAsWith(demo, true, -int256(ONE_MCB), bad);
    }

    function test_invalidHookDataFixedCases() public {
        uint256[4] memory lens = [uint256(64), 95, 97, 32];
        for (uint256 i; i < lens.length; i++) {
            vm.expectRevert(
                _wrapped(IHooks.beforeSwap.selector, abi.encodeWithSelector(IParityHook.InvalidHookData.selector))
            );
            swapAsWith(demo, true, -int256(ONE_MCB), new bytes(lens[i]));
        }
        vm.expectRevert(_wrapped(IHooks.beforeSwap.selector, abi.encodeWithSelector(IParityHook.InvalidHookData.selector)));
        swapAsWith(demo, true, -int256(ONE_MCB), abi.encode(uint8(2), demo, bytes32(0)));
        // Empty hookData through a router makes the router the swapper.
        vm.expectEmit(true, true, true, false, address(hook));
        emit IParityHook.InventoryFill(poolId, address(swapRouter), address(swapRouter), zfo(true), true, 0, 0, 0, 0, 0);
        swapAsWith(demo, true, -int256(ONE_MCB), "");
    }

    function test_trustedRouterClaimHonoured() public {
        eligibility.setDemoMode(false);
        bytes32 uid = _attest(demo, "FR");
        vm.expectEmit(true, true, true, false, address(hook));
        emit IParityHook.InventoryFill(poolId, demo, address(swapRouter), zfo(true), true, 0, 0, 0, 0, 0);
        swapAsWith(demo, true, -int256(ONE_MCB), hookData(demo, uid));
        // uid 0 resolves through the indexer.
        indexer.set(demo, SCHEMA, uid);
        swapAsWith(demo, true, -int256(ONE_MCB), hookData(demo, 0));
    }

    /// @dev SCOPING S9(b) / erratum E1, unresolved in the frozen interface: an allowlisted public router honours
    ///      any claimed swapper, so an unattested caller can name an attested address. This test pins the known gap.
    function test_publicRouterClaimIsUnauthenticated_KNOWN() public {
        eligibility.setDemoMode(false);
        bytes32 uid = _attest(alice, "FR");
        // bob is unattested but names alice through the trusted router: accepted.
        fund(bob, 10 * ONE_MCB, 0);
        vm.expectEmit(true, true, true, false, address(hook));
        emit IParityHook.InventoryFill(poolId, alice, address(swapRouter), zfo(true), true, 0, 0, 0, 0, 0);
        swapAsWith(bob, true, -int256(ONE_MCB), hookData(alice, uid));
    }

    // ---------------------------------------------------------------- callbacks and transient state

    function test_unlockCallbackRejectsNonManager() public {
        bytes memory payload = abi.encode(uint8(1), cur(maaplx), uint256(1), alice);
        vm.expectRevert(IParityHook.NotPoolManager.selector);
        hook.unlockCallback(payload);
        // Even the PoolManager cannot drive it outside the hook's own deposit/withdraw/sweep.
        vm.prank(address(manager));
        vm.expectRevert(IParityHook.NotPoolManager.selector);
        hook.unlockCallback(payload);
    }

    function test_depositInsideForeignUnlockReverts() public {
        ForeignUnlocker f = new ForeignUnlocker(manager, hook);
        hook.setKeeper(address(f), true);
        mcb.mint(address(f), ONE_MCB);
        vm.expectRevert(IPoolManager.AlreadyUnlocked.selector);
        f.run(cur(mcb), ONE_MCB);
    }

    function test_transientStateClearedBetweenSwapsInOneUnlock() public {
        seedLiquidity(1000 * ONE_MCB, 1012 * ONE_MAAPLX, 120);
        _removeInventory(mcb);
        SwapRouterMulti multi = new SwapRouterMulti(manager);
        mcb.mint(address(multi), 1000 * ONE_MCB);
        maaplx.mint(address(multi), 1000 * ONE_MAAPLX);
        SwapParams[] memory ps = new SwapParams[](2);
        // Swap 1 fills 1 mcbAAPL from mAAPLx inventory; swap 2 exceeds the 1 mcbAAPL now in inventory, so it must
        // fall through and trip the guard. A leaked FILL flag would skip the guard.
        ps[0] = SwapParams(zfo(true), -int256(ONE_MCB), zfo(true) ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        ps[1] = SwapParams(zfo(false), -int256(900 * ONE_MAAPLX), zfo(false) ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        try multi.swaps(key, ps, "") {
            revert("expected peg guard");
        } catch (bytes memory err) {
            (bytes4 hs, bytes4 inner) = _innerSelector(err);
            assertEq(hs, IHooks.afterSwap.selector);
            assertEq(inner, IParityHook.PegGuardTripped.selector);
        }
        // Control: a fill then a small fall-through in one unlock emits exactly one InventoryFill then one FallThrough.
        ps[1] = SwapParams(zfo(false), -int256(2 * ONE_MAAPLX), zfo(false) ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        vm.recordLogs();
        multi.swaps(key, ps, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 fills;
        uint256 falls;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(hook)) continue;
            if (logs[i].topics[0] == IParityHook.InventoryFill.selector) fills++;
            if (logs[i].topics[0] == IParityHook.FallThrough.selector) falls++;
        }
        assertEq(fills, 1);
        assertEq(falls, 1);
        assertEq(manager.getNonzeroDeltaCount(), 0);
    }

    // ---------------------------------------------------------------- donation

    function test_donatedClaimsCountAsInventory() public {
        ClaimDonor donor = new ClaimDonor(manager);
        maaplx.mint(address(donor), 5 * ONE_MAAPLX);
        vm.recordLogs();
        donor.donate(cur(maaplx), address(hook), 5 * ONE_MAAPLX);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].emitter != address(hook), "no hook event on donation");
        }
        assertEq(hook.inventory(cur(maaplx)), INV_MAAPLX + 5 * ONE_MAAPLX);
        assertEq(manager.balanceOf(address(hook), cur(maaplx).toId()), hook.inventory(cur(maaplx)));
        // The keeper can withdraw donated claims.
        hook.withdrawInventory(cur(maaplx), INV_MAAPLX + 5 * ONE_MAAPLX, address(this));
    }

    function testFuzz_donationCannotReduceFeeProfitably(uint256 donation, uint256 size) public {
        // Scarce side is mcbAAPL (8,100 vs 12,150 shares). Donating mcbAAPL claims lowers |skew|.
        donation = bound(donation, 1, 4000 * ONE_MCB);
        size = bound(size, ONE_MAAPLX, 5000 * ONE_MAAPLX);
        IParityHook.Quote memory before = quoteOf(false, -int256(size));
        ClaimDonor donor = new ClaimDonor(manager);
        mcb.mint(address(donor), donation);
        donor.donate(cur(mcb), address(hook), donation);
        IParityHook.Quote memory afterDonation = quoteOf(false, -int256(size));
        // Fee saving (in mcbAAPL raw, same output token) never exceeds what was donated, up to one pip of the output: the
        // skew fee is ceil-rounded to whole pips at the post-trade skew, so a dust donation that moves |post skew| across
        // a pip boundary saves one pip. That grants nothing beyond choosing the trade size, which moves |post skew| too.
        uint256 saving = afterDonation.amountOut > before.amountOut ? afterDonation.amountOut - before.amountOut : 0;
        assertLe(saving, donation + before.amountOut / 1e6 + 1);
    }

    // ---------------------------------------------------------------- rounding and deltas

    function testFuzz_exactInRoundsForHook(uint256 amount, bool mcbIn) public view {
        MockIssuerToken tIn = mcbIn ? mcb : maaplx;
        MockIssuerToken tOut = mcbIn ? maaplx : mcb;
        amount = bound(amount, 1, 1_000_000 * one(tIn));
        IParityHook.Quote memory q = quoteOf(mcbIn, -int256(amount));
        uint256 pips = q.fee.totalPips;
        // out * sptOut * 10^decIn * 1e6 <= in * sptIn * 10^decOut * (1e6 - pips)
        uint256 lhs = q.amountOut * tOut.multiplier() * one(tIn) * 1e6;
        uint256 rhs = amount * tIn.multiplier() * one(tOut) * (1e6 - pips);
        assertLe(lhs, rhs);
        assertLe(q.amountOut + q.feeAmount, q.grossOut + 0);
        assertGe(q.feeAmount * 1e6, q.grossOut * pips);
    }

    function testFuzz_exactOutRoundsForHook(uint256 amount, bool mcbIn) public view {
        MockIssuerToken tIn = mcbIn ? mcb : maaplx;
        MockIssuerToken tOut = mcbIn ? maaplx : mcb;
        amount = bound(amount, 1, 1_000_000 * one(tOut));
        IParityHook.Quote memory q = quoteOf(mcbIn, int256(amount));
        uint256 pips = q.fee.totalPips;
        assertEq(q.amountOut, amount);
        // in * sptIn * 10^decOut * (1e6 - pips) >= out * sptOut * 10^decIn * 1e6
        uint256 lhs = q.amountIn * tIn.multiplier() * one(tOut) * (1e6 - pips);
        uint256 rhs = amount * tOut.multiplier() * one(tIn) * 1e6;
        assertGe(lhs, rhs);
        assertGe(q.feeAmount * 1e6, q.grossOut * pips);
    }

    function testFuzz_fillDeltasExact(uint256 amount, bool mcbIn, bool exactIn) public {
        MockIssuerToken tIn = mcbIn ? mcb : maaplx;
        MockIssuerToken tOut = mcbIn ? maaplx : mcb;
        amount = bound(amount, 1, 1000 * (exactIn ? one(tIn) : one(tOut)));
        int256 amt = exactIn ? -int256(amount) : int256(amount);
        IParityHook.Quote memory q = quoteOf(mcbIn, amt);
        vm.assume(q.fillable);
        BalanceDelta d = swapAs(demo, mcbIn, amt);
        bool z = zfo(mcbIn);
        assertEq(z ? d.amount0() : d.amount1(), -int128(int256(q.amountIn)));
        assertEq(z ? d.amount1() : d.amount0(), int128(int256(q.amountOut)));
        assertEq(manager.getNonzeroDeltaCount(), 0);
    }
}

contract ParityHook_McbC0Test is ParityHookBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract ParityHook_MaaplxC0Test is ParityHookBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
