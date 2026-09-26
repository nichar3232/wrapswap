// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Fixture} from "./utils/Fixture.sol";
import {WrapSwapRouter} from "../src/WrapSwapRouter.sol";
import {IWrapSwapRouter} from "../src/interfaces/IWrapSwapRouter.sol";
import {IParityHook} from "../src/interfaces/IParityHook.sol";

abstract contract WrapSwapRouterBase is Fixture {
    WrapSwapRouter internal router;

    uint128 constant MCB_IN = 100e6;

    function setUp() public override {
        super.setUp();
        router = new WrapSwapRouter(manager);
        eligibility.setTrustedRouter(address(router), true);
        seedInventory(8000e6, 12150e18);
        mcb.mint(demo, 1000e6);
        maaplx.mint(demo, 1000e18);
        vm.startPrank(demo);
        mcb.approve(address(router), type(uint256).max);
        maaplx.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function exactIn(bool mcbIn, uint128 amountIn, uint128 minOut, bytes memory data)
        internal
        view
        returns (IWrapSwapRouter.ExactInputParams memory)
    {
        return IWrapSwapRouter.ExactInputParams(key, zfo(mcbIn), amountIn, minOut, demo, block.timestamp, data);
    }

    function exactOut(bool mcbIn, uint128 amountOut, uint128 maxIn)
        internal
        view
        returns (IWrapSwapRouter.ExactOutputParams memory)
    {
        return IWrapSwapRouter.ExactOutputParams(key, zfo(mcbIn), amountOut, maxIn, demo, block.timestamp, "");
    }

    function test_exactIn_parityFillMatchesQuote() public {
        IParityHook.Quote memory q = quoteOf(true, -int256(uint256(MCB_IN)));
        assertTrue(q.fillable);
        uint256 mcbBefore = mcb.balanceOf(demo);
        uint256 maaplxBefore = maaplx.balanceOf(demo);
        vm.prank(demo);
        uint256 out = router.swapExactIn(exactIn(true, MCB_IN, uint128(q.amountOut), ""));
        assertEq(out, q.amountOut);
        assertEq(mcbBefore - mcb.balanceOf(demo), MCB_IN);
        assertEq(maaplx.balanceOf(demo) - maaplxBefore, q.amountOut);
        assertEq(mcb.balanceOf(address(router)), 0);
        assertEq(maaplx.balanceOf(address(router)), 0);
    }

    function test_exactIn_revertsBelowMinOut() public {
        IParityHook.Quote memory q = quoteOf(true, -int256(uint256(MCB_IN)));
        vm.prank(demo);
        vm.expectRevert(
            abi.encodeWithSelector(IWrapSwapRouter.TooLittleReceived.selector, q.amountOut, q.amountOut + 1)
        );
        router.swapExactIn(exactIn(true, MCB_IN, uint128(q.amountOut + 1), ""));
    }

    function test_exactIn_fallThroughRevertsBelowMinOut() public {
        seedLiquidity(1000e6, 1012.5e18, 200);
        // Larger than mcb inventory in the reverse direction forces the concentrated-liquidity path.
        hook.withdrawInventory(cur(mcb), 8000e6, address(this));
        uint128 amountIn = 1e18;
        IParityHook.Quote memory q = quoteOf(false, -int256(uint256(amountIn)));
        assertFalse(q.fillable);
        uint256 snap = vm.snapshotState();
        vm.prank(demo);
        uint256 out = router.swapExactIn(exactIn(false, amountIn, 0, ""));
        assertGt(out, 0);
        vm.revertToState(snap);
        vm.prank(demo);
        vm.expectRevert(abi.encodeWithSelector(IWrapSwapRouter.TooLittleReceived.selector, out, out + 1));
        router.swapExactIn(exactIn(false, amountIn, uint128(out + 1), ""));
    }

    function test_exactOut_parityFillMatchesQuote() public {
        uint128 want = 50e18;
        IParityHook.Quote memory q = quoteOf(true, int256(uint256(want)));
        assertTrue(q.fillable);
        uint256 mcbBefore = mcb.balanceOf(demo);
        uint256 maaplxBefore = maaplx.balanceOf(demo);
        vm.prank(demo);
        uint256 paid = router.swapExactOut(exactOut(true, want, uint128(q.amountIn)));
        assertEq(paid, q.amountIn);
        assertEq(mcbBefore - mcb.balanceOf(demo), q.amountIn);
        assertEq(maaplx.balanceOf(demo) - maaplxBefore, want);
    }

    function test_exactOut_revertsAboveMaxIn() public {
        uint128 want = 50e18;
        IParityHook.Quote memory q = quoteOf(true, int256(uint256(want)));
        vm.prank(demo);
        vm.expectRevert(
            abi.encodeWithSelector(IWrapSwapRouter.TooMuchRequested.selector, q.amountIn, q.amountIn - 1)
        );
        router.swapExactOut(exactOut(true, want, uint128(q.amountIn - 1)));
    }

    function test_revertsAfterDeadline() public {
        IWrapSwapRouter.ExactInputParams memory p = exactIn(true, MCB_IN, 0, "");
        p.deadline = block.timestamp - 1;
        vm.prank(demo);
        vm.expectRevert(
            abi.encodeWithSelector(IWrapSwapRouter.DeadlineExpired.selector, p.deadline, block.timestamp)
        );
        router.swapExactIn(p);
        IWrapSwapRouter.ExactOutputParams memory o = exactOut(true, 1e18, type(uint128).max);
        o.deadline = block.timestamp - 1;
        vm.prank(demo);
        vm.expectRevert(
            abi.encodeWithSelector(IWrapSwapRouter.DeadlineExpired.selector, o.deadline, block.timestamp)
        );
        router.swapExactOut(o);
    }

    function test_hookDataPassThroughForCaller() public {
        vm.prank(demo);
        uint256 out = router.swapExactIn(exactIn(true, MCB_IN, 1, hookData(demo, bytes32(uint256(7)))));
        assertGt(out, 0);
    }

    function test_rejectsHookDataNamingAnotherSwapper() public {
        vm.prank(demo);
        vm.expectRevert(abi.encodeWithSelector(IWrapSwapRouter.SwapperMismatch.selector, alice, demo));
        router.swapExactIn(exactIn(true, MCB_IN, 0, hookData(alice, 0)));
    }

    function test_rejectsMalformedHookData() public {
        vm.startPrank(demo);
        vm.expectRevert(IWrapSwapRouter.InvalidHookData.selector);
        router.swapExactIn(exactIn(true, MCB_IN, 0, hex"01"));
        vm.expectRevert(IWrapSwapRouter.InvalidHookData.selector);
        router.swapExactIn(exactIn(true, MCB_IN, 0, abi.encode(uint8(2), demo, bytes32(0))));
        vm.stopPrank();
    }

    function test_eligibilityAppliesToCallerNotRouter() public {
        eligibility.setDemoMode(false);
        vm.prank(demo);
        vm.expectRevert();
        router.swapExactIn(exactIn(true, MCB_IN, 0, ""));
        (bool eligible,) = eligibility.check(demo, bytes32(0));
        assertFalse(eligible);
        // The router's own trust does not make an ineligible caller's swap go through.
        assertTrue(eligibility.isTrustedRouter(address(router)));
    }

    function test_unlockCallbackOnlyPoolManager() public {
        vm.expectRevert(IWrapSwapRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }
}

contract WrapSwapRouterMcbC0Test is WrapSwapRouterBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract WrapSwapRouterMaaplxC0Test is WrapSwapRouterBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
