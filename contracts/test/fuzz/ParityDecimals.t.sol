// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IssuerRegistry} from "../../src/IssuerRegistry.sol";
import {NyseCalendar} from "../../src/NyseCalendar.sol";
import {EASEligibility} from "../../src/EASEligibility.sol";
import {ParityHook} from "../../src/ParityHook.sol";
import {StaticAdapter} from "../../src/adapters/StaticAdapter.sol";
import {MockIssuerToken} from "../../src/mocks/MockIssuerToken.sol";
import {IParityHook} from "../../src/interfaces/IParityHook.sol";

/// @notice Fuzzes token decimals (6/18, then 0-18), ratios, both currency orderings, both swap modes: rounding favours
///         the hook, deltas are exact and settle to zero, and quote() equals execution.
contract ParityDecimalsTest is Test {
    using TransientStateLibrary for IPoolManager;

    address constant LOW = address(uint160(0x1000) << 144);
    address constant HIGH = address(uint160(0x2000) << 144);
    address constant HOOK_ADDR = address(uint160(0x20C8) | (uint160(0x4444) << 144));

    IPoolManager manager;
    PoolSwapTest router;
    IssuerRegistry registry;
    NyseCalendar calendar;
    EASEligibility eligibility;

    function setUp() public {
        vm.warp(1790692200);
        manager = IPoolManager(address(new PoolManager(address(this))));
        router = new PoolSwapTest(manager);
        registry = new IssuerRegistry(address(this));
        calendar = new NyseCalendar(address(this));
        eligibility = new EASEligibility(address(this), address(0), address(0), bytes32(0), address(0), "US");
        eligibility.setDemoMode(true);
    }

    struct Case {
        MockIssuerToken a;
        MockIssuerToken b;
        ParityHook hook;
        PoolKey key;
    }

    function _deploy(uint8 decA, uint8 decB, uint256 sptA, uint256 sptB, bool aIsC0) internal returns (Case memory c) {
        (address atA, address atB) = aIsC0 ? (LOW, HIGH) : (HIGH, LOW);
        deployCodeTo("MockIssuerToken.sol:MockIssuerToken", abi.encode("A", "A", decA, uint256(1e18)), atA);
        deployCodeTo("MockIssuerToken.sol:MockIssuerToken", abi.encode("B", "B", decB, uint256(1e18)), atB);
        c.a = MockIssuerToken(atA);
        c.b = MockIssuerToken(atB);
        registry.add(address(new StaticAdapter(atA, "X", "static", sptA, address(this))));
        registry.add(address(new StaticAdapter(atB, "X", "static", sptB, address(this))));
        deployCodeTo(
            "ParityHook.sol:ParityHook",
            abi.encode(address(manager), address(registry), address(calendar), address(eligibility), address(this)),
            HOOK_ADDR
        );
        c.hook = ParityHook(HOOK_ADDR);
        c.key = PoolKey(Currency.wrap(LOW), Currency.wrap(HIGH), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(HOOK_ADDR));
        (uint256 spt0, uint8 d0, uint256 spt1, uint8 d1) = aIsC0 ? (sptA, decA, sptB, decB) : (sptB, decB, sptA, decA);
        uint160 sqrtP = uint160(Math.sqrt(FullMath.mulDiv(spt0 * 10 ** d1, 1 << 192, spt1 * 10 ** d0)));
        manager.initialize(c.key, sqrtP);
        // Deep inventory on both sides (1e9 whole tokens), with a mild skew.
        uint256 invA = 1e9 * 10 ** decA;
        uint256 invB = 7e8 * 10 ** decB;
        c.a.mint(address(this), invA);
        c.b.mint(address(this), invB);
        c.a.approve(HOOK_ADDR, type(uint256).max);
        c.b.approve(HOOK_ADDR, type(uint256).max);
        c.hook.depositInventory(Currency.wrap(atA), invA);
        c.hook.depositInventory(Currency.wrap(atB), invB);
        c.a.approve(address(router), type(uint256).max);
        c.b.approve(address(router), type(uint256).max);
    }

    function _check(Case memory c, bool aIn, int256 amt, uint256 sptA, uint256 sptB) internal {
        (MockIssuerToken tIn, MockIssuerToken tOut) = aIn ? (c.a, c.b) : (c.b, c.a);
        (uint256 sptIn, uint256 sptOut) = aIn ? (sptA, sptB) : (sptB, sptA);
        bool z = address(tIn) == LOW;
        IParityHook.Quote memory q = c.hook.quote(c.key, z, amt);
        if (!q.fillable) return;
        uint256 pips = q.fee.totalPips;
        // Hook-favouring rounding, exact rationals: out * sptOut * 10^decIn * 1e6 <= in * sptIn * 10^decOut * (1e6-pips)
        uint256 lhsHi;
        uint256 lhsLo;
        (lhsHi, lhsLo) = _mul512(q.amountOut * sptOut, 10 ** tIn.decimals() * 1e6);
        (uint256 rhsHi, uint256 rhsLo) = _mul512(q.amountIn * sptIn, 10 ** tOut.decimals() * (1e6 - pips));
        assertTrue(lhsHi < rhsHi || (lhsHi == rhsHi && lhsLo <= rhsLo), "rounding favours hook");
        assertGe(q.feeAmount * 1e6, q.grossOut * pips, "fee ceil");

        tIn.mint(address(this), q.amountIn);
        uint256 feesBefore = c.hook.feesAccrued(Currency.wrap(address(tOut)));
        BalanceDelta d = router.swap(
            c.key,
            SwapParams(z, amt, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(z ? d.amount0() : d.amount1(), -int128(int256(q.amountIn)), "exact in delta");
        assertEq(z ? d.amount1() : d.amount0(), int128(int256(q.amountOut)), "exact out delta");
        assertEq(c.hook.feesAccrued(Currency.wrap(address(tOut))) - feesBefore, q.feeAmount);
        assertEq(manager.getNonzeroDeltaCount(), 0);
        for (uint256 i; i < 2; i++) {
            Currency cc = i == 0 ? c.key.currency0 : c.key.currency1;
            assertEq(manager.balanceOf(HOOK_ADDR, cc.toId()), c.hook.inventory(cc) + c.hook.feesAccrued(cc));
        }
    }

    function _mul512(uint256 x, uint256 y) internal pure returns (uint256 hi, uint256 lo) {
        assembly {
            let mm := mulmod(x, y, not(0))
            lo := mul(x, y)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
    }

    function _amount(int256 raw, bool exactIn, uint8 decIn, uint8 decOut) internal pure returns (int256) {
        uint256 unit = 10 ** (exactIn ? decIn : decOut);
        uint256 mag = bound(uint256(raw < 0 ? -(raw + 1) : raw), 1, 1e6 * unit);
        return exactIn ? -int256(mag) : int256(mag);
    }

    function testFuzz_bothOrderingsAndDecimals(
        uint8 decA,
        uint8 decB,
        uint256 sptA,
        uint256 sptB,
        bool aIsC0,
        int256 amt,
        bool exactIn
    ) public {
        decA = decA % 2 == 0 ? 6 : 18;
        decB = decB % 2 == 0 ? 6 : 18;
        sptA = bound(sptA, 1e15, 1e21);
        sptB = bound(sptB, 1e15, 1e21);
        Case memory c = _deploy(decA, decB, sptA, sptB, aIsC0);
        bool aIn = uint256(keccak256(abi.encode(amt))) % 2 == 0;
        _check(c, aIn, _amount(amt, exactIn, aIn ? decA : decB, aIn ? decB : decA), sptA, sptB);
    }

    function testFuzz_decimalsSweep0to18(
        uint8 decA,
        uint8 decB,
        uint256 sptA,
        uint256 sptB,
        bool aIsC0,
        int256 amt,
        bool exactIn
    ) public {
        decA = uint8(bound(decA, 0, 18));
        decB = uint8(bound(decB, 0, 18));
        sptA = bound(sptA, 1e16, 1e20);
        sptB = bound(sptB, 1e16, 1e20);
        // Keep price * 2^192 inside 256 bits for the parity sqrt (price < 2^64): |decA - decB| <= 12 with spt ratio
        // <= 1e4 bounds the raw price ratio by 1e16.
        if (decA > decB + 12) decA = decB + 12;
        if (decB > decA + 12) decB = decA + 12;
        Case memory c = _deploy(decA, decB, sptA, sptB, aIsC0);
        bool aIn = uint256(keccak256(abi.encode(amt))) % 2 == 0;
        _check(c, aIn, _amount(amt, exactIn, aIn ? decA : decB, aIn ? decB : decA), sptA, sptB);
    }
}
