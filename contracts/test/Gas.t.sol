// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Fixture} from "./utils/Fixture.sol";

/// @notice One operation per test body, all preparation in setUp, so `forge snapshot` isolates each path.
///         Snapshot: forge snapshot --match-path contracts/test/Gas.t.sol --snap contracts/gas-snapshot
abstract contract GasBase is Fixture {
    uint256 internal id;

    function mcbIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function setUp() public virtual override {
        super.setUp();
        seedInventory(8000e6, 12150e18);
        seedLiquidity(1000e6, 1012e18, 120);
        fund(demo, 500e6, 500e18);
        fund(alice, 200e6, 0);
        fund(bob, 0, 200e18);
        oracle.setMid(address(mcb), address(maaplx), 1.0125e18);
    }

    function _commitBoth() internal {
        (id,,) = dark.currentBatch();
        vm.prank(alice);
        dark.fund(address(mcb), 60e6);
        vm.prank(bob);
        dark.fund(address(maaplx), 50.625e18);
        bytes32 hA = dark.commitHashOf(id, alice, true, 60e6, 1.01e18, address(0), "a");
        bytes32 hB = dark.commitHashOf(id, bob, false, 50.625e18, 1.015e18, address(0), "b");
        vm.prank(alice);
        dark.commit(hA, address(mcb), 60e6, 0);
        vm.prank(bob);
        dark.commit(hB, address(maaplx), 50.625e18, 0);
    }
}

contract GasParityFill is GasBase {
    function test_gas_parityFill() public {
        swapAs(demo, true, -100e6);
    }
}

contract GasFallThrough is GasBase {
    function setUp() public override {
        super.setUp();
        hook.withdrawInventory(cur(maaplx), hook.inventory(cur(maaplx)), address(this));
    }

    function test_gas_fallThrough() public {
        swapAs(demo, true, -1e6);
    }
}

contract GasCommit is GasBase {
    bytes32 internal h;

    function setUp() public override {
        super.setUp();
        (id,,) = dark.currentBatch();
        vm.prank(alice);
        dark.fund(address(mcb), 60e6);
        h = dark.commitHashOf(id, alice, true, 60e6, 1.01e18, address(0), "a");
    }

    function test_gas_commit() public {
        vm.prank(alice);
        dark.commit(h, address(mcb), 60e6, 0);
    }
}

contract GasReveal is GasBase {
    function setUp() public override {
        super.setUp();
        _commitBoth();
        vm.roll(dark.batchOrigin() + id * 20 + 12);
    }

    function test_gas_reveal() public {
        vm.prank(alice);
        dark.reveal(true, 60e6, 1.01e18, address(0), "a");
    }
}

contract GasSettle is GasBase {
    function setUp() public override {
        super.setUp();
        _commitBoth();
        vm.roll(dark.batchOrigin() + id * 20 + 12);
        vm.prank(alice);
        dark.reveal(true, 60e6, 1.01e18, address(0), "a");
        vm.prank(bob);
        dark.reveal(false, 50.625e18, 1.015e18, address(0), "b");
        vm.roll(dark.batchOrigin() + id * 20 + 18);
    }

    /// @dev Two-sided cross plus one residual routed into the ParityHook pool (the §10 batch).
    function test_gas_settle() public {
        dark.settle(id);
    }
}
