// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IWrapperAdapter} from "../src/interfaces/IWrapperAdapter.sol";
import {StaticAdapter} from "../src/adapters/StaticAdapter.sol";
import {B20MultiplierAdapter} from "../src/adapters/B20MultiplierAdapter.sol";
import {XStocksMultiplierAdapter} from "../src/adapters/XStocksMultiplierAdapter.sol";
import {MultiplierAdapterBase} from "../src/adapters/MultiplierAdapterBase.sol";
import {MockIssuerToken} from "../src/mocks/MockIssuerToken.sol";

/// @notice Issuer token whose multiplier() and transfersPaused() can be made to revert.
contract BrokenIssuerToken {
    bool public broken;
    uint256 public mult = 1e18;

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function multiplier() external view returns (uint256) {
        require(!broken, "multiplier down");
        return mult;
    }

    function transfersPaused() external view returns (bool) {
        require(!broken, "paused down");
        return false;
    }
}

contract AdaptersTest is Test {
    bytes32 constant AAPL = bytes32("AAPL");
    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");

    MockIssuerToken mcb;
    MockIssuerToken maaplx;
    StaticAdapter stat;
    B20MultiplierAdapter b20;
    XStocksMultiplierAdapter xs;

    event RatioUpdated(address indexed token, uint256 oldSharesPerToken, uint256 newSharesPerToken);
    event AdapterPaused(address indexed token, bool paused);

    function setUp() public {
        vm.warp(1_790_000_000);
        mcb = new MockIssuerToken("Mock cbAAPL", "mcbAAPL", 6, 1.0125e18);
        maaplx = new MockIssuerToken("Mock AAPLx", "mAAPLx", 18, 1e18);
        stat = new StaticAdapter(address(mcb), AAPL, "Static", 1.0125e18, owner);
        b20 = new B20MultiplierAdapter(address(mcb), AAPL);
        xs = new XStocksMultiplierAdapter(address(maaplx), AAPL);
    }

    function test_staticAdapter_interface() public view {
        IWrapperAdapter a = IWrapperAdapter(address(stat));
        assertEq(a.token(), address(mcb));
        assertEq(a.underlying(), AAPL);
        assertEq(a.name(), "Static");
        assertEq(a.tokenDecimals(), 6);
        assertEq(a.sharesPerToken(), 1.0125e18);
        (uint256 spt, bool healthy) = a.ratio();
        assertEq(spt, 1.0125e18);
        assertTrue(healthy);
        IWrapperAdapter.Health memory hl = a.health();
        assertFalse(hl.paused);
        assertFalse(hl.stale);
        assertEq(hl.updatedAt, 1_790_000_000);
        assertEq(stat.owner(), owner);
    }

    function test_staticAdapter_zeroRatioReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IWrapperAdapter.InvalidRatio.selector, 0));
        new StaticAdapter(address(mcb), AAPL, "Static", 0, owner);
        vm.expectRevert(abi.encodeWithSelector(IWrapperAdapter.InvalidRatio.selector, 1e24 + 1));
        new StaticAdapter(address(mcb), AAPL, "Static", 1e24 + 1, owner);
        // Upper bound inclusive.
        StaticAdapter big = new StaticAdapter(address(mcb), AAPL, "Static", 1e24, owner);
        assertEq(big.sharesPerToken(), 1e24);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IWrapperAdapter.InvalidRatio.selector, 0));
        stat.setSharesPerToken(0);
        vm.expectRevert(abi.encodeWithSelector(IWrapperAdapter.InvalidRatio.selector, 1e24 + 1));
        stat.setSharesPerToken(1e24 + 1);
        stat.setSharesPerToken(1e24);
        vm.stopPrank();
        assertEq(stat.sharesPerToken(), 1e24);
    }

    function test_staticAdapter_eventsAndHealth() public {
        vm.warp(1_790_000_100);
        vm.expectEmit(true, false, false, true, address(stat));
        emit RatioUpdated(address(mcb), 1.0125e18, 2.025e18);
        vm.prank(owner);
        stat.setSharesPerToken(2.025e18);
        assertEq(stat.sharesPerToken(), 2.025e18);
        assertEq(stat.health().updatedAt, 1_790_000_100);
        assertEq(stat.updatedAt(), 1_790_000_100);

        vm.expectEmit(true, false, false, true, address(stat));
        emit AdapterPaused(address(mcb), true);
        vm.prank(owner);
        stat.setPaused(true);
        (uint256 spt, bool healthy) = stat.ratio();
        assertEq(spt, 2.025e18);
        assertFalse(healthy);
        assertTrue(stat.health().paused);
        // Pausing does not bump updatedAt.
        assertEq(stat.health().updatedAt, 1_790_000_100);

        vm.expectEmit(true, false, false, true, address(stat));
        emit AdapterPaused(address(mcb), false);
        vm.prank(owner);
        stat.setPaused(false);
        (, healthy) = stat.ratio();
        assertTrue(healthy);
        assertFalse(stat.health().paused);

        // onlyOwner.
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        stat.setSharesPerToken(1e18);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        stat.setPaused(true);
        vm.stopPrank();
    }

    function test_multiplierAdapter_readsMultiplier() public {
        assertEq(b20.name(), "Coinbase B20");
        assertEq(xs.name(), "Backed xStocks");
        assertEq(b20.token(), address(mcb));
        assertEq(xs.token(), address(maaplx));
        assertEq(b20.underlying(), AAPL);
        assertEq(xs.underlying(), AAPL);
        assertEq(b20.tokenDecimals(), 6);
        assertEq(xs.tokenDecimals(), 18);
        assertEq(b20.MAX_RATIO(), 1e24);

        assertEq(b20.sharesPerToken(), 1.0125e18);
        assertEq(xs.sharesPerToken(), 1e18);
        (uint256 spt, bool healthy) = b20.ratio();
        assertEq(spt, 1.0125e18);
        assertTrue(healthy);

        IWrapperAdapter.Health memory hl = xs.health();
        assertFalse(hl.paused);
        assertFalse(hl.stale);
        assertEq(hl.updatedAt, block.timestamp);

        // Corporate action (2:1 split) on the token reprices live.
        mcb.setMultiplier(2.025e18);
        maaplx.setMultiplier(0.5e18);
        assertEq(b20.sharesPerToken(), 2.025e18);
        assertEq(xs.sharesPerToken(), 0.5e18);
        (spt, healthy) = xs.ratio();
        assertEq(spt, 0.5e18);
        assertTrue(healthy);

        vm.warp(block.timestamp + 1000);
        assertEq(b20.health().updatedAt, block.timestamp);
    }

    function test_multiplierAdapter_pausedTokenUnhealthy() public {
        mcb.setTransfersPaused(true);
        IWrapperAdapter.Health memory hl = b20.health();
        assertTrue(hl.paused);
        assertFalse(hl.stale);
        (uint256 spt, bool healthy) = b20.ratio();
        assertEq(spt, 1.0125e18);
        assertFalse(healthy);
        // sharesPerToken still reads (pause is a health concern, not a ratio concern).
        assertEq(b20.sharesPerToken(), 1.0125e18);

        mcb.setTransfersPaused(false);
        (, healthy) = b20.ratio();
        assertTrue(healthy);
        assertFalse(b20.health().paused);
    }

    function test_multiplierAdapter_outOfBoundsRatioUnhealthy() public {
        maaplx.setMultiplier(1e24 + 1);
        vm.expectRevert(abi.encodeWithSelector(IWrapperAdapter.InvalidRatio.selector, 1e24 + 1));
        xs.sharesPerToken();
        (uint256 spt, bool healthy) = xs.ratio();
        assertEq(spt, 1e24 + 1);
        assertFalse(healthy);

        maaplx.setMultiplier(1e24);
        assertEq(xs.sharesPerToken(), 1e24);
        (, healthy) = xs.ratio();
        assertTrue(healthy);

        // A token whose multiplier() / transfersPaused() revert.
        BrokenIssuerToken broken = new BrokenIssuerToken();
        B20MultiplierAdapter ba = new B20MultiplierAdapter(address(broken), AAPL);
        assertEq(ba.tokenDecimals(), 8);
        (spt, healthy) = ba.ratio();
        assertEq(spt, 1e18);
        assertTrue(healthy);

        broken.setBroken(true);
        (spt, healthy) = ba.ratio();
        assertEq(spt, 0);
        assertFalse(healthy);
        // health() never reverts; an unreadable pause flag is treated as paused.
        assertTrue(ba.health().paused);
        vm.expectRevert(bytes("multiplier down"));
        ba.sharesPerToken();
    }
}
