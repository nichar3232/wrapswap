// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceOracle, IMockPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";

contract MockPriceOracleTest is Test {
    address owner = makeAddr("owner");
    address pusher = makeAddr("pusher");
    address stranger = makeAddr("stranger");
    address base = makeAddr("base");
    address quote = makeAddr("quote");
    MockPriceOracle oracle;

    event MidUpdated(address indexed base, address indexed quote, uint256 midX18, uint64 updatedAt);
    event PusherSet(address indexed pusher, bool allowed);

    function setUp() public {
        vm.warp(1_790_000_000);
        oracle = new MockPriceOracle(owner);
        vm.prank(owner);
        oracle.setPusher(pusher, true);
    }

    function test_setMidOnlyPusher() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IMockPriceOracle.NotPusher.selector, stranger));
        oracle.setMid(base, quote, 1e18);
        // Owner is not implicitly a pusher.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMockPriceOracle.NotPusher.selector, owner));
        oracle.setMid(base, quote, 1e18);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit MidUpdated(base, quote, 1.0125e18, 1_790_000_000);
        vm.prank(pusher);
        oracle.setMid(base, quote, 1.0125e18);
        (uint256 mid, uint64 at) = oracle.getMid(base, quote);
        assertEq(mid, 1.0125e18);
        assertEq(at, 1_790_000_000);

        vm.warp(1_790_000_500);
        vm.prank(pusher);
        oracle.setMid(base, quote, 1.02e18);
        (mid, at) = oracle.getMid(base, quote);
        assertEq(mid, 1.02e18);
        assertEq(at, 1_790_000_500);

        // Revoked pusher can no longer set.
        vm.prank(owner);
        oracle.setPusher(pusher, false);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(IMockPriceOracle.NotPusher.selector, pusher));
        oracle.setMid(base, quote, 1e18);
    }

    function test_zeroMidReverts() public {
        vm.prank(pusher);
        vm.expectRevert(IMockPriceOracle.ZeroMid.selector);
        oracle.setMid(base, quote, 0);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.NoPrice.selector, base, quote));
        oracle.getMid(base, quote);
    }

    function test_inverseMidFloor() public {
        vm.prank(pusher);
        oracle.setMid(quote, base, 3e18);
        (uint256 mid, uint64 at) = oracle.getMid(base, quote);
        assertEq(mid, uint256(1e36) / 3e18);
        assertEq(mid, 333333333333333333);
        assertEq(at, 1_790_000_000);

        // §10 parity: inverse of 1.0125 floors to 0.987654320987654320.
        vm.warp(1_790_000_100);
        vm.prank(pusher);
        oracle.setMid(quote, base, 1.0125e18);
        (mid, at) = oracle.getMid(base, quote);
        assertEq(mid, 987654320987654320);
        assertEq(at, 1_790_000_100);

        // A direct entry takes precedence over the inverse.
        vm.prank(pusher);
        oracle.setMid(base, quote, 0.5e18);
        (mid,) = oracle.getMid(base, quote);
        assertEq(mid, 0.5e18);
        (mid,) = oracle.getMid(quote, base);
        assertEq(mid, 1.0125e18);
    }

    function test_noPrice() public {
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.NoPrice.selector, base, quote));
        oracle.getMid(base, quote);
        vm.prank(pusher);
        oracle.setMid(base, quote, 1e18);
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.NoPrice.selector, base, other));
        oracle.getMid(base, other);
    }

    function test_setPusherOnlyOwnerEmits() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.setPusher(stranger, true);
        assertFalse(oracle.isPusher(stranger));

        vm.expectEmit(true, false, false, true, address(oracle));
        emit PusherSet(stranger, true);
        vm.prank(owner);
        oracle.setPusher(stranger, true);
        assertTrue(oracle.isPusher(stranger));

        vm.expectEmit(true, false, false, true, address(oracle));
        emit PusherSet(stranger, false);
        vm.prank(owner);
        oracle.setPusher(stranger, false);
        assertFalse(oracle.isPusher(stranger));
        assertEq(oracle.owner(), owner);
    }
}
