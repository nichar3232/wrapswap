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

/// @notice Reproduces the §10 demo narrative under the final fee model (base 2 bps + skew fee only on |skew|-increasing
///         trades, fees stay in inventory; dark cross fee 1 bp to the protocol) for both currency orderings. The fee does
///         not depend on market hours, so there is one variant.
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
    /// @dev Post-trade skew as the fee model sees it (the trade's shares move one-for-one, fee excluded) ...
    int256 constant POST_SKEW_FILL = -190000000000000000;
    /// @dev ... and the actual inventory skew afterwards (the fee stays in inventory).
    int256 constant SKEW_AFTER_FILL = -190000809999190000;
    int256 constant SKEW_AFTER_DARK = -189000892099018691;
    int256 constant FILL_SPECIFIED = -100000000;
    uint256 constant FILL_IN = 100000000;
    uint256 constant FILL_SHARES = 101250000000000000000;
    uint256 constant FILL_GROSS = 101250000000000000000;
    uint24 constant BASE_PIPS = 200;
    uint256 constant FILL_FEE = 20250000000000000;
    uint256 constant FILL_OUT = 101229750000000000000;
    uint256 constant A_AMOUNT = 60000000;
    uint256 constant A_LIMIT = 1010000000000000000;
    uint256 constant B_AMOUNT = 50625000000000000000;
    uint256 constant B_LIMIT = 1015000000000000000;
    uint256 constant CROSSED_BASE = 50000000;
    uint256 constant CROSSED_QUOTE = 50625000000000000000;
    uint256 constant CROSS_FEE_A = 5062500000000000;
    uint256 constant CROSS_FEE_B = 5000;
    uint256 constant CROSS_OUT_A = 50619937500000000000;
    uint256 constant CROSS_OUT_B = 49995000;
    uint256 constant MATCHED_SHARES = 50625000000000000000;
    uint256 constant PROTOCOL_FEE_SHARES = 10125000000000000;
    uint256 constant RESIDUAL_IN = 10000000;
    uint256 constant RESIDUAL_SHARES = 10125000000000000000;
    uint256 constant RESIDUAL_FEE = 2025000000000000;
    uint256 constant RESIDUAL_OUT = 10122975000000000000;
    uint256 constant END_DEMO_MAAPLX = 601229750000000000000;
    uint256 constant END_A_ESCROW_MAAPLX = 60742912500000000000;

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

    function _run() internal {
        _seedSection10();

        // ---- Step 1: parity fill, demo exact-input 100 mcbAAPL -> mAAPLx. The book is long mAAPLx (skew -0.2), so
        //      the fill reduces |skew|: base fee only.
        IParityHook.FeeBreakdown memory f = hook.feeBreakdown(key);
        assertEq(f.skewX18, _skew(SKEW_INITIAL), "skew initial");
        assertEq(f.skewPips, 300, "trade-less view: marginal skew-increasing fee ceil(1500 * 0.2)");
        IParityHook.Quote memory q = quoteOf(true, FILL_SPECIFIED);
        assertTrue(q.fillable);
        assertTrue(q.fee.reducesImbalance);
        assertEq(q.fee.skewPips, 0);
        assertEq(q.fee.totalPips, BASE_PIPS);
        assertEq(q.amountIn, FILL_IN);
        assertEq(q.shares, FILL_SHARES);
        assertEq(q.grossOut, FILL_GROSS);
        assertEq(q.feeAmount, FILL_FEE);
        assertEq(q.amountOut, FILL_OUT);
        (uint256 sharesOut, uint256 baseFee, uint256 skewFee, int256 postSkew, bool reduces) =
            hook.quote(AAPL, address(mcb), address(maaplx), FILL_IN);
        assertEq(sharesOut, FILL_OUT);
        assertEq(baseFee, FILL_FEE);
        assertEq(skewFee, 0);
        assertEq(postSkew, _skew(POST_SKEW_FILL));
        assertTrue(reduces);

        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.InventoryFill(
            poolId, demo, address(swapRouter), zfo(true), true, FILL_IN, FILL_OUT, FILL_SHARES, FILL_FEE, BASE_PIPS
        );
        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.Converted(
            AAPL, address(mcb), address(maaplx), demo, demo, FILL_IN, FILL_OUT, FILL_FEE, 0, _skew(POST_SKEW_FILL)
        );
        BalanceDelta d = swapAs(demo, true, FILL_SPECIFIED);
        (uint256 paid, uint256 got) = inOut(d, true);
        assertEq(paid, FILL_IN);
        assertEq(got, FILL_OUT);
        assertEq(hook.inventory(cur(mcb)), 8100000000);
        assertEq(hook.inventory(cur(maaplx)), 12048770250000000000000, "fee stays in inventory");
        assertEq(hook.inventoryShares(cur(mcb)), 8201250000000000000000);
        assertEq(hook.feeBreakdown(key).skewX18, _skew(SKEW_AFTER_FILL), "skew after fill");

        // ---- Step 2: dark batch at the parity mid; A's residual falls through into the ParityHook pool.
        oracle.setMid(address(mcb), address(maaplx), PARITY_MID);
        vm.prank(alice);
        dark.fund(address(mcb), A_AMOUNT);
        vm.prank(bob);
        dark.fund(address(maaplx), B_AMOUNT);
        (uint256 batchId,,) = dark.currentBatch();
        bytes32 hA = dark.commitHashOf(batchId, alice, true, A_AMOUNT, A_LIMIT, address(0), "saltA");
        bytes32 hB = dark.commitHashOf(batchId, bob, false, B_AMOUNT, B_LIMIT, address(0), "saltB");
        vm.prank(alice);
        assertTrue(dark.commit(hA, address(mcb), A_AMOUNT, 0));
        vm.prank(bob);
        assertTrue(dark.commit(hB, address(maaplx), B_AMOUNT, 0));
        vm.roll(dark.batchOrigin() + batchId * 20 + 12);
        vm.prank(alice);
        dark.reveal(true, A_AMOUNT, A_LIMIT, address(0), "saltA");
        vm.prank(bob);
        dark.reveal(false, B_AMOUNT, B_LIMIT, address(0), "saltB");
        vm.roll(dark.batchOrigin() + batchId * 20 + 18);

        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.CrossFilled(batchId, alice, alice, true, CROSSED_BASE, CROSS_OUT_A, CROSS_FEE_A);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.CrossFilled(batchId, bob, bob, false, CROSSED_QUOTE, CROSS_OUT_B, CROSS_FEE_B);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.Crossed(batchId, AAPL, MATCHED_SHARES, PARITY_MID, PROTOCOL_FEE_SHARES);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IParityHook.InventoryFill(
            poolId, alice, address(dark), zfo(true), true, RESIDUAL_IN, RESIDUAL_OUT, RESIDUAL_SHARES, RESIDUAL_FEE, BASE_PIPS
        );
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.ResidualFilled(batchId, alice, RESIDUAL_SHARES, RESIDUAL_FEE, 0);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.BatchSettled(
            batchId, PARITY_MID, uint64(block.timestamp), CROSSED_BASE, CROSSED_QUOTE, RESIDUAL_IN, 0, 2
        );
        dark.settle(batchId);

        IDarkCrossHook.Order memory oa = dark.order(batchId, alice);
        assertEq(oa.crossedIn, CROSSED_BASE);
        assertEq(oa.residualIn, RESIDUAL_IN);
        assertGe(RESIDUAL_OUT, 10100000000000000000, "minOut");
        assertEq(hook.inventory(cur(mcb)), 8110000000);
        assertEq(hook.inventory(cur(maaplx)), 12038647275000000000000);
        assertEq(hook.feeBreakdown(key).skewX18, _skew(SKEW_AFTER_DARK), "skew after dark");

        // ---- End state.
        assertEq(maaplx.balanceOf(demo), END_DEMO_MAAPLX);
        assertEq(mcb.balanceOf(demo), 400000000);
        (uint256 aAvail, uint256 aLocked) = dark.balances(alice, address(maaplx));
        assertEq(aAvail, END_A_ESCROW_MAAPLX);
        assertEq(aLocked, 0);
        (uint256 aMcb, uint256 aMcbLocked) = dark.balances(alice, address(mcb));
        assertEq(aMcb + aMcbLocked, 0);
        (uint256 bAvail,) = dark.balances(bob, address(mcb));
        assertEq(bAvail, CROSS_OUT_B);
        (uint256 tQuote,) = dark.balances(treasury, address(maaplx));
        (uint256 tBase,) = dark.balances(treasury, address(mcb));
        assertEq(tQuote, CROSS_FEE_A, "1 bp cross fee to the protocol");
        assertEq(tBase, CROSS_FEE_B);
    }
}

contract DemoNarrative_McbC0Test is DemoNarrativeBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function test_section10_mcbC0() public {
        _run();
    }
}

contract DemoNarrative_MaaplxC0Test is DemoNarrativeBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function test_section10_maaplxC0() public {
        _run();
    }
}
