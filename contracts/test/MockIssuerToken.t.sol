// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMockIssuerToken} from "../src/interfaces/IMockIssuerToken.sol";
import {MockIssuerToken} from "../src/mocks/MockIssuerToken.sol";

contract MockIssuerTokenTest is Test {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    MockIssuerToken token;

    event MultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);
    event TransfersPaused(bool paused);

    function setUp() public {
        token = new MockIssuerToken("Mock cbAAPL", "mcbAAPL", 6, 1.0125e18);
        token.mint(alice, 1000e6);
    }

    function test_pausedTransfersRevertTokenPaused() public {
        vm.prank(alice);
        token.approve(bob, type(uint256).max);

        vm.expectEmit(false, false, false, true, address(token));
        emit TransfersPaused(true);
        token.setTransfersPaused(true);
        assertTrue(token.transfersPaused());

        vm.prank(alice);
        vm.expectRevert(IMockIssuerToken.TokenPaused.selector);
        token.transfer(bob, 1e6);

        vm.prank(bob);
        vm.expectRevert(IMockIssuerToken.TokenPaused.selector);
        token.transferFrom(alice, bob, 1e6);

        vm.expectRevert(IMockIssuerToken.TokenPaused.selector);
        token.mint(bob, 1e6);

        // Approvals are not transfers and still work.
        vm.prank(alice);
        token.approve(bob, 5);
        assertEq(token.allowance(alice, bob), 5);

        vm.expectEmit(false, false, false, true, address(token));
        emit TransfersPaused(false);
        token.setTransfersPaused(false);
        assertFalse(token.transfersPaused());

        vm.prank(alice);
        token.transfer(bob, 1e6);
        assertEq(token.balanceOf(bob), 1e6);
        assertEq(token.balanceOf(alice), 999e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.setTransfersPaused(true);
    }

    function test_setMultiplierEventsAndZero() public {
        assertEq(token.multiplier(), 1.0125e18);

        vm.expectEmit(false, false, false, true, address(token));
        emit MultiplierUpdated(1.0125e18, 2.025e18);
        token.setMultiplier(2.025e18);
        assertEq(token.multiplier(), 2.025e18);

        vm.expectRevert(abi.encodeWithSelector(IMockIssuerToken.InvalidMultiplier.selector, 0));
        token.setMultiplier(0);
        assertEq(token.multiplier(), 2.025e18);

        vm.expectRevert(abi.encodeWithSelector(IMockIssuerToken.InvalidMultiplier.selector, 0));
        new MockIssuerToken("X", "X", 18, 0);

        // Constructor announces the initial multiplier.
        vm.expectEmit(false, false, false, true);
        emit MultiplierUpdated(0, 1e18);
        MockIssuerToken t2 = new MockIssuerToken("X", "X", 18, 1e18);
        assertEq(t2.multiplier(), 1e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.setMultiplier(1e18);
    }

    function test_mintOnlyOwner() public {
        assertEq(token.owner(), address(this));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.mint(alice, 1);

        uint256 supply = token.totalSupply();
        token.mint(bob, 42);
        assertEq(token.balanceOf(bob), 42);
        assertEq(token.totalSupply(), supply + 42);
    }

    function test_decimalsConfigurable() public {
        uint8[4] memory ds = [uint8(0), 6, 8, 18];
        for (uint256 i; i < ds.length; i++) {
            MockIssuerToken t = new MockIssuerToken("T", "T", ds[i], 1e18);
            assertEq(t.decimals(), ds[i]);
        }
        assertEq(token.decimals(), 6);
        assertEq(token.name(), "Mock cbAAPL");
        assertEq(token.symbol(), "mcbAAPL");
    }
}
