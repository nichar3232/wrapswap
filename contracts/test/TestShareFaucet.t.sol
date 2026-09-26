// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestShareFaucet} from "../src/mocks/TestShareFaucet.sol";
import {MockIssuerToken} from "../src/mocks/MockIssuerToken.sol";

contract TestShareFaucetTest is Test {
    TestShareFaucet faucet;
    MockIssuerToken a6;
    MockIssuerToken b18;
    address judge = makeAddr("judge");

    function setUp() public {
        vm.warp(1790424000);
        a6 = new MockIssuerToken("Mock Coinbase Apple", "mcbAAPL", 6, 1.0125e18);
        b18 = new MockIssuerToken("Mock Apple xStock", "mAAPLx", 18, 1e18);
        address[] memory ts = new address[](2);
        ts[0] = address(a6);
        ts[1] = address(b18);
        faucet = new TestShareFaucet(address(this), ts);
        a6.mint(address(faucet), 5000e6);
        b18.mint(address(faucet), 5000e18);
    }

    function test_claimSendsThousandOfEachAtTokenDecimals() public {
        vm.prank(judge);
        faucet.claim();
        assertEq(a6.balanceOf(judge), 1000e6);
        assertEq(b18.balanceOf(judge), 1000e18);
        assertEq(faucet.lastClaimAt(judge), block.timestamp);
    }

    function test_oncePer24h() public {
        vm.prank(judge);
        faucet.claim();
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(TestShareFaucet.CooldownActive.selector, block.timestamp + 1));
        faucet.claim();
        vm.warp(block.timestamp + 1);
        assertEq(faucet.nextClaimAt(judge), 0);
        vm.prank(judge);
        faucet.claim();
        assertEq(a6.balanceOf(judge), 2000e6);
    }

    function test_cooldownIsPerAddress() public {
        vm.prank(judge);
        faucet.claim();
        address other = makeAddr("other");
        vm.prank(other);
        faucet.claim();
        assertEq(b18.balanceOf(other), 1000e18);
    }

    function test_allOrNothingWhenUnderfunded() public {
        faucet.withdraw(address(b18), address(this), 4500e18); // 500 left < 1000
        vm.prank(judge);
        vm.expectRevert();
        faucet.claim();
        assertEq(a6.balanceOf(judge), 0);
        assertEq(faucet.lastClaimAt(judge), 0);
    }

    function test_listAndWithdrawAreOwnerOnly() public {
        MockIssuerToken c = new MockIssuerToken("Mock Coinbase NVIDIA", "mcbNVDA", 6, 1.02e18);
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, judge));
        faucet.list(address(c));
        faucet.list(address(c));
        assertEq(faucet.tokens().length, 3);
        vm.expectRevert(abi.encodeWithSelector(TestShareFaucet.AlreadyListed.selector, address(c)));
        faucet.list(address(c));
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, judge));
        faucet.withdraw(address(a6), judge, 1);
    }
}
