// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IIssuerRegistry} from "../src/interfaces/IIssuerRegistry.sol";
import {IWrapperAdapter} from "../src/interfaces/IWrapperAdapter.sol";
import {IssuerRegistry} from "../src/IssuerRegistry.sol";
import {StaticAdapter} from "../src/adapters/StaticAdapter.sol";
import {B20MultiplierAdapter} from "../src/adapters/B20MultiplierAdapter.sol";
import {XStocksMultiplierAdapter} from "../src/adapters/XStocksMultiplierAdapter.sol";
import {MockIssuerToken} from "../src/mocks/MockIssuerToken.sol";

/// @notice Fully configurable adapter; ratio() can be made to revert.
contract ConfigurableAdapter {
    address public token;
    bytes32 public underlying;
    uint8 public tokenDecimals;
    uint256 public spt = 1e18;
    bool public healthy = true;
    bool public ratioReverts;

    constructor(address token_, bytes32 underlying_, uint8 decimals_) {
        token = token_;
        underlying = underlying_;
        tokenDecimals = decimals_;
    }

    function set(uint256 spt_, bool healthy_, bool reverts_) external {
        spt = spt_;
        healthy = healthy_;
        ratioReverts = reverts_;
    }

    function name() external pure returns (string memory) {
        return "Configurable";
    }

    function ratio() external view returns (uint256, bool) {
        require(!ratioReverts, "ratio down");
        return (spt, healthy);
    }
}

/// @notice Contract with no token() function.
contract NotAnAdapter {}

contract IssuerRegistryTest is Test {
    bytes32 constant AAPL = bytes32("AAPL");
    bytes32 constant MSFT = bytes32("MSFT");
    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");

    IssuerRegistry reg;
    MockIssuerToken mcb;
    MockIssuerToken maaplx;
    B20MultiplierAdapter b20;
    XStocksMultiplierAdapter xs;

    event IssuerAdded(address indexed token, address indexed adapter, bytes32 indexed underlying);
    event IssuerRemoved(address indexed token, address indexed adapter, bytes32 indexed underlying);
    event IssuerPaused(address indexed token, bool paused);

    function setUp() public {
        reg = new IssuerRegistry(owner);
        mcb = new MockIssuerToken("Mock cbAAPL", "mcbAAPL", 6, 1.0125e18);
        maaplx = new MockIssuerToken("Mock AAPLx", "mAAPLx", 18, 1e18);
        b20 = new B20MultiplierAdapter(address(mcb), AAPL);
        xs = new XStocksMultiplierAdapter(address(maaplx), AAPL);
    }

    function test_addRemoveSetPausedEvents() public {
        vm.expectEmit(true, true, true, true, address(reg));
        emit IssuerAdded(address(mcb), address(b20), AAPL);
        vm.prank(owner);
        reg.add(address(b20));

        vm.expectEmit(true, true, true, true, address(reg));
        emit IssuerAdded(address(maaplx), address(xs), AAPL);
        vm.prank(owner);
        reg.add(address(xs));

        address[] memory list = reg.adapters();
        assertEq(list.length, 2);
        assertEq(list[0], address(b20));
        assertEq(list[1], address(xs));
        assertEq(reg.adapterOf(address(mcb)), address(b20));
        assertTrue(reg.isIssuer(address(mcb)));
        assertTrue(reg.active(address(mcb)));
        assertTrue(reg.active(address(maaplx)));

        vm.expectEmit(true, false, false, true, address(reg));
        emit IssuerPaused(address(mcb), true);
        vm.prank(owner);
        reg.setPaused(address(mcb), true);
        assertTrue(reg.paused(address(mcb)));
        assertFalse(reg.active(address(mcb)));
        assertTrue(reg.isIssuer(address(mcb)));

        vm.expectEmit(true, false, false, true, address(reg));
        emit IssuerPaused(address(mcb), false);
        vm.prank(owner);
        reg.setPaused(address(mcb), false);
        assertTrue(reg.active(address(mcb)));

        // Adapter-level unhealth also deactivates.
        mcb.setTransfersPaused(true);
        assertFalse(reg.active(address(mcb)));
        mcb.setTransfersPaused(false);

        vm.prank(owner);
        reg.setPaused(address(mcb), true);
        vm.expectEmit(true, true, true, true, address(reg));
        emit IssuerRemoved(address(mcb), address(b20), AAPL);
        vm.prank(owner);
        reg.remove(address(mcb));
        assertFalse(reg.isIssuer(address(mcb)));
        assertFalse(reg.active(address(mcb)));
        assertFalse(reg.paused(address(mcb)));
        assertEq(reg.adapterOf(address(mcb)), address(0));
        assertEq(reg.underlyingOf(address(mcb)), bytes32(0));
        list = reg.adapters();
        assertEq(list.length, 1);
        assertEq(list[0], address(xs));

        // Re-add after removal works and starts unpaused.
        vm.prank(owner);
        reg.add(address(b20));
        assertTrue(reg.active(address(mcb)));
        assertEq(reg.adapters().length, 2);

        // onlyOwner.
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        reg.add(address(b20));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        reg.remove(address(mcb));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        reg.setPaused(address(mcb), true);
        vm.stopPrank();
    }

    function test_addInvalidAdapter() public {
        vm.startPrank(owner);

        // Zero token.
        ConfigurableAdapter zeroToken = new ConfigurableAdapter(address(0), AAPL, 6);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.InvalidAdapter.selector, address(zeroToken)));
        reg.add(address(zeroToken));

        // Zero underlying.
        ConfigurableAdapter zeroU = new ConfigurableAdapter(address(mcb), bytes32(0), 6);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.InvalidAdapter.selector, address(zeroU)));
        reg.add(address(zeroU));

        // Decimals > 18.
        ConfigurableAdapter bigDec = new ConfigurableAdapter(address(mcb), AAPL, 19);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.InvalidAdapter.selector, address(bigDec)));
        reg.add(address(bigDec));

        // Unhealthy ratio (paused) and zero ratio.
        ConfigurableAdapter sick = new ConfigurableAdapter(address(mcb), AAPL, 6);
        sick.set(1e18, false, false);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.InvalidAdapter.selector, address(sick)));
        reg.add(address(sick));
        sick.set(0, true, false);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.InvalidAdapter.selector, address(sick)));
        reg.add(address(sick));

        // Real adapter over a paused token.
        vm.stopPrank();
        mcb.setTransfersPaused(true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.InvalidAdapter.selector, address(b20)));
        reg.add(address(b20));
        mcb.setTransfersPaused(false);

        vm.startPrank(owner);
        // Paused static adapter.
        StaticAdapter st = new StaticAdapter(address(mcb), AAPL, "S", 1e18, owner);
        st.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.InvalidAdapter.selector, address(st)));
        reg.add(address(st));

        // EOA adapter.
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.InvalidAdapter.selector, eoa));
        reg.add(eoa);

        // Contract without token().
        NotAnAdapter na = new NotAnAdapter();
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.InvalidAdapter.selector, address(na)));
        reg.add(address(na));
        vm.stopPrank();

        assertEq(reg.adapters().length, 0);
    }

    function test_alreadyRegistered() public {
        vm.startPrank(owner);
        reg.add(address(b20));
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.AlreadyRegistered.selector, address(mcb)));
        reg.add(address(b20));
        // A different adapter for the same token is also rejected.
        StaticAdapter st = new StaticAdapter(address(mcb), AAPL, "S", 1e18, owner);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.AlreadyRegistered.selector, address(mcb)));
        reg.add(address(st));
        vm.stopPrank();
        assertEq(reg.adapters().length, 1);
    }

    function test_unknownIssuer() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.UnknownIssuer.selector, address(mcb)));
        reg.remove(address(mcb));
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.UnknownIssuer.selector, address(mcb)));
        reg.setPaused(address(mcb), true);
        reg.add(address(b20));
        reg.remove(address(mcb));
        vm.expectRevert(abi.encodeWithSelector(IIssuerRegistry.UnknownIssuer.selector, address(mcb)));
        reg.remove(address(mcb));
        vm.stopPrank();
        assertFalse(reg.active(address(mcb)));
        assertFalse(reg.active(address(0xdead)));
    }

    function test_activeFalseOnRevertingAdapter() public {
        ConfigurableAdapter ca = new ConfigurableAdapter(address(mcb), AAPL, 6);
        vm.prank(owner);
        reg.add(address(ca));
        assertTrue(reg.active(address(mcb)));

        ca.set(1e18, true, true);
        assertFalse(reg.active(address(mcb)));
        assertTrue(reg.isIssuer(address(mcb)));

        ca.set(0, true, false);
        assertFalse(reg.active(address(mcb)));
        ca.set(1e18, false, false);
        assertFalse(reg.active(address(mcb)));
        ca.set(1e18, true, false);
        assertTrue(reg.active(address(mcb)));

        // Reverting adapter can still be removed.
        ca.set(1e18, true, true);
        vm.prank(owner);
        reg.remove(address(mcb));
        assertFalse(reg.isIssuer(address(mcb)));
    }

    function test_underlyingOf() public {
        MockIssuerToken msft = new MockIssuerToken("Mock MSFT", "mMSFT", 8, 1e18);
        StaticAdapter st = new StaticAdapter(address(msft), MSFT, "S", 1e18, owner);
        vm.startPrank(owner);
        reg.add(address(b20));
        reg.add(address(xs));
        reg.add(address(st));
        vm.stopPrank();
        assertEq(reg.underlyingOf(address(mcb)), AAPL);
        assertEq(reg.underlyingOf(address(maaplx)), AAPL);
        assertEq(reg.underlyingOf(address(msft)), MSFT);
        assertEq(reg.underlyingOf(address(0xbeef)), bytes32(0));

        // Removing the middle entry swaps the last one in.
        vm.prank(owner);
        reg.remove(address(mcb));
        address[] memory list = reg.adapters();
        assertEq(list.length, 2);
        assertEq(list[0], address(st));
        assertEq(list[1], address(xs));
        assertEq(reg.underlyingOf(address(mcb)), bytes32(0));
        assertEq(reg.underlyingOf(address(msft)), MSFT);
        assertEq(reg.owner(), owner);
    }
}
