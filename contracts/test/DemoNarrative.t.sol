// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Fixture} from "./utils/Fixture.sol";
import {IParityHook} from "../src/interfaces/IParityHook.sol";
import {IDarkCrossHook} from "../src/interfaces/IDarkCrossHook.sol";

/// @notice Reproduces INTERFACES.md §10 exactly: every `wrapswap:demo` constant is hardcoded and asserted, for both
///         variants (ANVIL at the warped open, UNICHAIN-SEPOLIA with the calendar closed) and both currency orderings.
abstract contract DemoNarrativeBase is Fixture {
    using StateLibrary for IPoolManager;

    // Shared §10 constants.
    uint256 constant SPT_MCB = 1012500000000000000;
    uint256 constant SPT_MAAPLX = 1000000000000000000;
    uint256 constant PARITY_MID = 1012500000000000000;
    uint160 constant SQRT_MCB_C0 = 79721800701433069633245772272326702;
    uint160 constant SQRT_MAAPLX_C0 = 78737580939686982353822;
    int24 constant TICK_MCB_C0 = 276448;
    int24 constant TICK_MAAPLX_C0 = -276449;
    uint256 constant INV_MCB = 8000000000;
    uint256 constant INV_MAAPLX = 12150000000000000000000;
    uint256 constant LP_MCB_MAX = 1000000000;
    uint256 constant LP_MAAPLX_MAX = 1012500000000000000000;
    int256 constant SKEW_INITIAL = -200000000000000000;
    int256 constant SKEW_AFTER_FILL = -190000000000000000;
    int256 constant SKEW_AFTER_DARK = -189000000000000000;
    int256 constant FILL_SPECIFIED = -100000000;
    uint256 constant FILL_IN = 100000000;
    uint256 constant FILL_SHARES = 101250000000000000000;
    uint256 constant FILL_GROSS = 101250000000000000000;
    uint24 constant FILL_SKEW_PIPS = 260;
    uint256 constant A_AMOUNT = 60000000;
    uint256 constant A_LIMIT = 1010000000000000000;
    uint256 constant B_AMOUNT = 50625000000000000000;
    uint256 constant B_LIMIT = 1015000000000000000;
    uint256 constant CROSSED_BASE = 50000000;
    uint256 constant CROSSED_QUOTE = 50625000000000000000;
    uint256 constant CROSS_FEE_A = 25312500000000000;
    uint256 constant CROSS_FEE_B = 25000;
    uint256 constant CROSS_OUT_A = 50599687500000000000;
    uint256 constant CROSS_OUT_B = 49975000;
    uint256 constant RESIDUAL_IN = 10000000;
    uint256 constant RESIDUAL_SHARES = 10125000000000000000;
    uint24 constant RESIDUAL_SKEW_PIPS = 247;

    struct Variant {
        uint256 warp;
        bool marketOpen;
        uint24 fillPips;
        uint256 fillFee;
        uint256 fillOut;
        uint24 residualPips;
        uint256 residualFee;
        uint256 residualOut;
        uint256 endDemoMaaplx;
        uint256 endDemoMcb;
        uint256 endAEscrowMaaplx;
        uint256 endBEscrowMcb;
        uint256 endHookFees;
    }

    function anvilVariant() internal pure returns (Variant memory) {
        return Variant({
            warp: 1790692200,
            marketOpen: true,
            fillPips: 460,
            fillFee: 46575000000000000,
            fillOut: 101203425000000000000,
            residualPips: 447,
            residualFee: 4525875000000000,
            residualOut: 10120474125000000000,
            endDemoMaaplx: 601203425000000000000,
            endDemoMcb: 400000000,
            endAEscrowMaaplx: 60720161625000000000,
            endBEscrowMcb: 49975000,
            endHookFees: 51100875000000000
        });
    }

    /// @dev Closed market, same numbers as ANVIL: the parity fill and the dark residual both sell mcbAAPL into a book
    ///      long mAAPLx, reducing |skew|, so neither pays the off-hours premium.
    function unichainSepoliaVariant() internal pure returns (Variant memory v) {
        v = anvilVariant();
        v.warp = 1790424000;
        v.marketOpen = false;
    }

    function _skew(int256 mcbMinusMaaplx) internal view returns (int256) {
        return c0IsMcb() ? mcbMinusMaaplx : -mcbMinusMaaplx;
    }

    function _seedSection10() internal {
        // Pool initialised at parity with the §10 constants.
        (uint160 sqrtP, int24 tick,,) = manager.getSlot0(poolId);
        assertEq(sqrtP, c0IsMcb() ? SQRT_MCB_C0 : SQRT_MAAPLX_C0, "sqrtPriceX96");
        assertEq(tick, c0IsMcb() ? TICK_MCB_C0 : TICK_MAAPLX_C0, "tick");
        assertEq(mcbAdapter.sharesPerToken(), SPT_MCB);
        assertEq(maaplxAdapter.sharesPerToken(), SPT_MAAPLX);
        assertEq(hook.pegStatus(key).parityPriceX18, c0IsMcb() ? PARITY_MID : 1e36 / PARITY_MID);

        fund(demo, 500000000, 500000000000000000000);
        fund(alice, 200000000, 0);
        fund(bob, 0, 200000000000000000000);
        seedInventory(INV_MCB, INV_MAAPLX);
        (int24 lower, int24 upper) = c0IsMcb() ? (int24(276320), int24(276570)) : (int24(-276570), int24(-276320));
        (uint256 a0, uint256 a1) = c0IsMcb() ? (LP_MCB_MAX, LP_MAAPLX_MAX) : (LP_MAAPLX_MAX, LP_MCB_MAX);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), a0, a1
        );
        mcb.mint(address(this), LP_MCB_MAX);
        maaplx.mint(address(this), LP_MAAPLX_MAX);
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(uint256(liq)), 0), "");
    }

    function _run(Variant memory v) internal {
        _seedSection10();
        vm.warp(v.warp);
        assertEq(calendar.isOpen(block.timestamp), v.marketOpen, "calendar");
        if (!v.marketOpen) assertEq(calendar.nextTransition(block.timestamp), 1790602200, "nextOpen");

        // ---- Step 1: parity fill, demo exact-input 100 mcbAAPL -> mAAPLx.
        IParityHook.FeeBreakdown memory f = hook.feeBreakdown(key);
        assertEq(f.skewX18, _skew(SKEW_INITIAL), "skew initial");
        assertEq(f.skewPips, FILL_SKEW_PIPS);
        assertEq(f.marketOpen, v.marketOpen);
        // The trade-less view quotes a marginal skew-increasing trade: ceil(1500 * 0.2) = 300 pips when closed.
        assertEq(f.closedPips, v.marketOpen ? 0 : 300);
        IParityHook.Quote memory q = quoteOf(true, FILL_SPECIFIED);
        assertTrue(q.fillable);
        assertEq(q.fee.closedPips, 0, "rebalancing fill pays no off-hours premium");
        assertEq(q.fee.totalPips, v.fillPips);
        assertEq(q.amountIn, FILL_IN);
        assertEq(q.shares, FILL_SHARES);
        assertEq(q.grossOut, FILL_GROSS);
        assertEq(q.feeAmount, v.fillFee);
        assertEq(q.amountOut, v.fillOut);

        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.InventoryFill(
            poolId, demo, address(swapRouter), zfo(true), true, FILL_IN, v.fillOut, FILL_SHARES, v.fillFee, v.fillPips
        );
        BalanceDelta d = swapAs(demo, true, FILL_SPECIFIED);
        (uint256 paid, uint256 got) = inOut(d, true);
        assertEq(paid, FILL_IN);
        assertEq(got, v.fillOut);
        assertEq(hook.inventory(cur(mcb)), 8100000000);
        assertEq(hook.inventory(cur(maaplx)), 12048750000000000000000);
        assertEq(hook.inventoryShares(cur(mcb)), 8201250000000000000000);
        assertEq(hook.feeBreakdown(key).skewX18, _skew(SKEW_AFTER_FILL), "skew after fill");
        assertEq(hook.feeBreakdown(key).skewPips, RESIDUAL_SKEW_PIPS);

        // ---- Step 2: dark batch at the parity mid; A's residual routes into the ParityHook pool.
        oracle.setMid(address(mcb), address(maaplx), PARITY_MID);
        vm.prank(alice);
        dark.fund(address(mcb), A_AMOUNT);
        vm.prank(bob);
        dark.fund(address(maaplx), B_AMOUNT);
        (uint256 batchId,,) = dark.currentBatch();
        bytes32 hA = dark.commitHashOf(batchId, alice, true, A_AMOUNT, A_LIMIT, true, "saltA");
        bytes32 hB = dark.commitHashOf(batchId, bob, false, B_AMOUNT, B_LIMIT, false, "saltB");
        vm.prank(alice);
        assertTrue(dark.commit(hA, address(mcb), A_AMOUNT, 0));
        vm.prank(bob);
        assertTrue(dark.commit(hB, address(maaplx), B_AMOUNT, 0));
        vm.roll(dark.batchOrigin() + batchId * 20 + 12);
        vm.prank(alice);
        dark.reveal(true, A_AMOUNT, A_LIMIT, true, "saltA");
        vm.prank(bob);
        dark.reveal(false, B_AMOUNT, B_LIMIT, false, "saltB");
        vm.roll(dark.batchOrigin() + batchId * 20 + 18);

        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.Crossed(batchId, alice, true, CROSSED_BASE, CROSS_OUT_A, CROSS_FEE_A, PARITY_MID);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.Crossed(batchId, bob, false, CROSSED_QUOTE, CROSS_OUT_B, CROSS_FEE_B, PARITY_MID);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.InventoryFill(
            poolId,
            alice,
            address(dark),
            zfo(true),
            true,
            RESIDUAL_IN,
            v.residualOut,
            RESIDUAL_SHARES,
            v.residualFee,
            v.residualPips
        );
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.ResidualRouted(batchId, alice, poolId, true, RESIDUAL_IN, v.residualOut);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.BatchSettled(
            batchId, PARITY_MID, uint64(block.timestamp), CROSSED_BASE, CROSSED_QUOTE, RESIDUAL_IN, 0, 2
        );
        dark.settle(batchId);

        IDarkCrossHook.Order memory oa = dark.order(batchId, alice);
        assertEq(oa.crossedIn, CROSSED_BASE);
        assertEq(oa.residualIn, RESIDUAL_IN);
        assertGe(v.residualOut, 10100000000000000000, "minOut");
        assertEq(hook.inventory(cur(mcb)), 8110000000);
        assertEq(hook.inventory(cur(maaplx)), 12038625000000000000000);
        assertEq(hook.feeBreakdown(key).skewX18, _skew(SKEW_AFTER_DARK), "skew after dark");

        // ---- End state.
        assertEq(maaplx.balanceOf(demo), v.endDemoMaaplx);
        assertEq(mcb.balanceOf(demo), v.endDemoMcb);
        (uint256 aAvail, uint256 aLocked) = dark.balances(alice, address(maaplx));
        assertEq(aAvail, v.endAEscrowMaaplx);
        assertEq(aLocked, 0);
        (uint256 aMcb, uint256 aMcbLocked) = dark.balances(alice, address(mcb));
        assertEq(aMcb + aMcbLocked, 0);
        (uint256 bAvail,) = dark.balances(bob, address(mcb));
        assertEq(bAvail, v.endBEscrowMcb);
        assertEq(hook.feesAccrued(cur(maaplx)), v.endHookFees);
        assertEq(hook.feesAccrued(cur(mcb)), 0);
        (uint256 tQuote,) = dark.balances(treasury, address(maaplx));
        (uint256 tBase,) = dark.balances(treasury, address(mcb));
        assertEq(tQuote, CROSS_FEE_A);
        assertEq(tBase, CROSS_FEE_B);
    }
}

contract DemoNarrative_McbC0Test is DemoNarrativeBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function test_section10_anvil_mcbC0() public {
        _run(anvilVariant());
    }

    function test_section10_unichainSepolia_mcbC0() public {
        _run(unichainSepoliaVariant());
    }
}

contract DemoNarrative_MaaplxC0Test is DemoNarrativeBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function test_section10_anvil_maaplxC0() public {
        _run(anvilVariant());
    }

    function test_section10_unichainSepolia_maaplxC0() public {
        _run(unichainSepoliaVariant());
    }
}
