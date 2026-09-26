// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Fixture} from "./utils/Fixture.sol";
import {RevertDecoder} from "./utils/Helpers.sol";
import {DarkCrossHook} from "../src/DarkCrossHook.sol";
import {Attestation} from "../src/EASEligibility.sol";
import {IDarkCrossHook} from "../src/interfaces/IDarkCrossHook.sol";
import {IParityHook} from "../src/interfaces/IParityHook.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {MockIssuerToken} from "../src/mocks/MockIssuerToken.sol";

/// @notice ERC20 that re-enters a DarkCrossHook from transferFrom and records the revert selector.
contract ReentrantToken is ERC20 {
    DarkCrossHook public target;
    bytes4 public caught;

    constructor() ERC20("Reentrant", "RE") {}

    function setTarget(DarkCrossHook t) external {
        target = t;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (address(target) != address(0)) {
            try target.settle(0) {}
            catch (bytes memory e) {
                caught = RevertDecoder.selectorOf(e);
            }
        }
        return super.transferFrom(from, to, value);
    }
}

abstract contract DarkCrossHookBase is Fixture {
    uint256 internal constant MID = 1.0125e18;
    uint256 internal ONE_MCB;
    uint256 internal ONE_MAAPLX;
    address[] internal traders;

    function setUp() public virtual override {
        super.setUp();
        ONE_MCB = one(mcb);
        ONE_MAAPLX = one(maaplx);
        seedInventory(8000 * ONE_MCB, 12150 * ONE_MAAPLX);
        seedLiquidity(1000 * ONE_MCB, 1012 * ONE_MAAPLX, 120);
        oracle.setMid(address(mcb), address(maaplx), MID);
        fund(alice, 1000 * ONE_MCB, 1000 * ONE_MAAPLX);
        fund(bob, 1000 * ONE_MCB, 1000 * ONE_MAAPLX);
        traders.push(alice);
        traders.push(bob);
    }

    // ---------------------------------------------------------------- helpers

    function _salt(address who) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", who));
    }

    function _fundEscrow(address who, address token, uint256 amount) internal {
        vm.prank(who);
        dark.fund(token, amount);
    }

    function _commit(address who, bool sellBase, uint256 amountIn, uint256 limit, bool route, uint256 lock)
        internal
        returns (uint256 batchId)
    {
        (batchId,,) = dark.currentBatch();
        address lockToken = sellBase ? address(mcb) : address(maaplx);
        (uint256 avail,) = dark.balances(who, lockToken);
        if (avail < lock) _fundEscrow(who, lockToken, lock - avail);
        bytes32 h = dark.commitHashOf(batchId, who, sellBase, amountIn, limit, route, _salt(who));
        vm.prank(who);
        assertTrue(dark.commit(h, lockToken, lock, 0));
    }

    function _reveal(address who, bool sellBase, uint256 amountIn, uint256 limit, bool route) internal {
        vm.prank(who);
        dark.reveal(sellBase, amountIn, limit, route, _salt(who));
    }

    function _toReveal(uint256 batchId) internal {
        vm.roll(dark.batchOrigin() + batchId * 20 + 12);
    }

    function _toSettle(uint256 batchId) internal {
        vm.roll(dark.batchOrigin() + batchId * 20 + 18);
    }

    function _escrowTotal(address token, address[] memory accounts) internal view returns (uint256 total) {
        for (uint256 i; i < accounts.length; i++) {
            (uint256 a, uint256 l) = dark.balances(accounts[i], token);
            total += a + l;
        }
    }

    function _assertConservation() internal view {
        address[] memory accounts = new address[](traders.length + 1);
        for (uint256 i; i < traders.length; i++) {
            accounts[i] = traders[i];
        }
        accounts[traders.length] = treasury;
        assertEq(_escrowTotal(address(mcb), accounts), mcb.balanceOf(address(dark)), "mcb conservation");
        assertEq(_escrowTotal(address(maaplx), accounts), maaplx.balanceOf(address(dark)), "maaplx conservation");
    }

    function _attest(address who, string memory country) internal returns (bytes32 uid) {
        uid = keccak256(abi.encode(who, country));
        eas.set(
            Attestation({
                uid: uid,
                schema: SCHEMA,
                time: uint64(block.timestamp),
                expirationTime: 0,
                revocationTime: 0,
                refUID: 0,
                recipient: who,
                attester: ATTESTER,
                revocable: true,
                data: abi.encode(country)
            })
        );
    }

    function _skippedReasons() internal returns (bytes[] memory reasons) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(dark) && logs[i].topics[0] == IDarkCrossHook.ResidualSkipped.selector) n++;
        }
        reasons = new bytes[](n);
        n = 0;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(dark) && logs[i].topics[0] == IDarkCrossHook.ResidualSkipped.selector) {
                reasons[n++] = abi.decode(logs[i].data, (bytes));
            }
        }
    }

    // ---------------------------------------------------------------- crossing and residuals

    function test_constructorAndViews() public {
        assertEq(dark.BATCH_BLOCKS(), 20);
        assertEq(dark.COMMIT_BLOCKS(), 12);
        assertEq(dark.REVEAL_BLOCKS(), 6);
        assertEq(dark.MAX_PARTICIPANTS(), 64);
        assertEq(dark.CROSS_FEE_PIPS(), 500);
        assertEq(dark.FORFEIT_BPS(), 10);
        assertEq(dark.ORACLE_MAX_AGE(), 900);
        assertEq(address(dark.poolManager()), address(manager));
        assertEq(address(dark.parityHook()), address(hook));
        assertEq(address(dark.oracle()), address(oracle));
        assertEq(address(dark.eligibility()), address(eligibility));
        assertEq(dark.baseToken(), address(mcb));
        assertEq(dark.quoteToken(), address(maaplx));
        assertEq(dark.treasury(), treasury);
        PoolKey memory k = dark.parityPoolKey();
        assertEq(Currency.unwrap(k.currency0), Currency.unwrap(key.currency0));
        assertEq(address(k.hooks), address(hook));
        (uint256 id, IDarkCrossHook.Phase ph, uint256 ends) = dark.currentBatch();
        assertEq(id, 0);
        assertEq(uint8(ph), 0);
        assertEq(ends, dark.batchOrigin() + 12);
        vm.roll(dark.batchOrigin() + 13);
        (, ph, ends) = dark.currentBatch();
        assertEq(uint8(ph), 1);
        assertEq(ends, dark.batchOrigin() + 18);
        vm.roll(dark.batchOrigin() + 19);
        (, ph, ends) = dark.currentBatch();
        assertEq(uint8(ph), 2);
        assertEq(ends, dark.batchOrigin() + 20);
        // Invalid configurations.
        PoolKey memory bad = key;
        bad.fee = 3000;
        vm.expectRevert(DarkCrossHook.InvalidConfig.selector);
        new DarkCrossHook(manager, hook, oracle, eligibility, address(mcb), address(maaplx), bad, treasury);
        vm.expectRevert(DarkCrossHook.InvalidConfig.selector);
        new DarkCrossHook(manager, hook, oracle, eligibility, address(mcb), address(mcb), key, treasury);
        vm.expectRevert(DarkCrossHook.InvalidConfig.selector);
        new DarkCrossHook(manager, hook, oracle, eligibility, address(mcb), address(maaplx), key, address(0));
        bad = key;
        bad.hooks = IHooks(address(0xdead));
        vm.expectRevert(DarkCrossHook.InvalidConfig.selector);
        new DarkCrossHook(manager, hook, oracle, eligibility, address(mcb), address(maaplx), bad, treasury);
    }

    function test_crossAndResidualIntoParityPoolSameTx() public {
        uint256 id = _commit(alice, true, 60 * ONE_MCB, 1.01e18, true, 60 * ONE_MCB);
        _commit(bob, false, 50.625e18, 1.015e18, false, 50.625e18);
        _toReveal(id);
        _reveal(alice, true, 60 * ONE_MCB, 1.01e18, true);
        _reveal(bob, false, 50.625e18, 1.015e18, false);
        _toSettle(id);
        uint256 invMcbBefore = hook.inventory(cur(mcb));
        vm.recordLogs();
        dark.settle(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool fill;
        bool routed;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == IParityHook.InventoryFill.selector) {
                fill = true;
                assertEq(address(uint160(uint256(logs[i].topics[2]))), alice, "swapper is the trader");
                assertEq(address(uint160(uint256(logs[i].topics[3]))), address(dark), "sender is dark");
            }
            if (logs[i].emitter == address(dark) && logs[i].topics[0] == IDarkCrossHook.ResidualRouted.selector) {
                routed = true;
            }
        }
        assertTrue(fill && routed);
        assertEq(hook.inventory(cur(mcb)), invMcbBefore + 10 * ONE_MCB);
        (uint256 aMcbAvail, uint256 aMcbLocked) = dark.balances(alice, address(mcb));
        assertEq(aMcbAvail + aMcbLocked, 0);
        _assertConservation();
    }

    function test_quoteSellerResidualRouted() public {
        uint256 id = _commit(alice, true, 20 * ONE_MCB, 1.0e18, false, 20 * ONE_MCB);
        _commit(bob, false, 50 * ONE_MAAPLX, 1.02e18, true, 50 * ONE_MAAPLX);
        _toReveal(id);
        _reveal(alice, true, 20 * ONE_MCB, 1.0e18, false);
        _reveal(bob, false, 50 * ONE_MAAPLX, 1.02e18, true);
        _toSettle(id);
        dark.settle(id);
        IDarkCrossHook.Order memory ob = dark.order(id, bob);
        assertEq(ob.crossedIn, 20.25e18);
        assertEq(ob.residualIn, 50 * ONE_MAAPLX - 20.25e18);
        IDarkCrossHook.BatchResult memory r = dark.batchResult(id);
        assertEq(r.residualQuoteIn, ob.residualIn);
        assertEq(r.residualBaseIn, 0);
        (uint256 bobMcb,) = dark.balances(bob, address(mcb));
        // Crossed 20 mcbAAPL minus 5 bps, plus the residual's mcbAAPL at parity minus the ParityHook fee.
        assertGt(bobMcb, 20 * ONE_MCB * 9995 / 10000 + 29 * ONE_MCB);
        (uint256 bobQ, uint256 bobQLocked) = dark.balances(bob, address(maaplx));
        assertEq(bobQLocked, 0);
        assertEq(bobQ, 0, "the whole quote lock was consumed");
        _assertConservation();
    }

    function test_residualSkippedOnPegGuard() public {
        // No mAAPLx inventory and thin liquidity: a large residual falls through and trips the guard.
        uint256 inv = hook.inventory(cur(maaplx));
        hook.withdrawInventory(cur(maaplx), inv, address(this));
        uint256 id = _commit(alice, true, 900 * ONE_MCB, 1.0e18, true, 900 * ONE_MCB);
        _toReveal(id);
        _reveal(alice, true, 900 * ONE_MCB, 1.0e18, true);
        _toSettle(id);
        vm.recordLogs();
        dark.settle(id);
        bytes[] memory reasons = _skippedReasons();
        assertEq(reasons.length, 1);
        (bytes4 outer,, bytes4 hookSel, bytes memory inner) = RevertDecoder.unwrap(reasons[0]);
        assertEq(outer, CustomRevert.WrappedError.selector);
        assertEq(hookSel, IHooks.afterSwap.selector);
        assertEq(RevertDecoder.selectorOf(inner), IParityHook.PegGuardTripped.selector);
        (uint256 avail, uint256 locked) = dark.balances(alice, address(mcb));
        assertEq(locked, 0);
        assertEq(avail, 900 * ONE_MCB, "residual stays in escrow");
        _assertConservation();
    }

    function test_residualSkippedOnMinOut() public {
        // Limit 1.05 > mid: excluded from the cross; parity output (1.0125 less fee) is below minOut.
        uint256 id = _commit(alice, true, 10 * ONE_MCB, 1.05e18, true, 10 * ONE_MCB);
        _toReveal(id);
        _reveal(alice, true, 10 * ONE_MCB, 1.05e18, true);
        _toSettle(id);
        vm.recordLogs();
        dark.settle(id);
        bytes[] memory reasons = _skippedReasons();
        assertEq(reasons.length, 1);
        assertEq(RevertDecoder.selectorOf(reasons[0]), DarkCrossHook.ResidualBelowMinOut.selector);
        (uint256 avail,) = dark.balances(alice, address(mcb));
        assertEq(avail, 10 * ONE_MCB);
        _assertConservation();
    }

    function test_residualSkippedWhenTraderIneligible() public {
        eligibility.setDemoMode(false);
        bytes32 uid = _attest(alice, "FR");
        _fundEscrow(alice, address(mcb), 10 * ONE_MCB);
        (uint256 id,,) = dark.currentBatch();
        bytes32 h = dark.commitHashOf(id, alice, true, 10 * ONE_MCB, 1.0e18, true, _salt(alice));
        vm.prank(alice);
        assertTrue(dark.commit(h, address(mcb), 10 * ONE_MCB, uid));
        _toReveal(id);
        _reveal(alice, true, 10 * ONE_MCB, 1.0e18, true);
        // Attestation re-issued as US before settlement: the parity pool rejects the residual.
        eas.set(
            Attestation({
                uid: uid,
                schema: SCHEMA,
                time: uint64(block.timestamp),
                expirationTime: 0,
                revocationTime: 0,
                refUID: 0,
                recipient: alice,
                attester: ATTESTER,
                revocable: true,
                data: abi.encode("US")
            })
        );
        _toSettle(id);
        vm.recordLogs();
        dark.settle(id);
        bytes[] memory reasons = _skippedReasons();
        assertEq(reasons.length, 1);
        (,, bytes4 hookSel, bytes memory inner) = RevertDecoder.unwrap(reasons[0]);
        assertEq(hookSel, IHooks.beforeSwap.selector);
        assertEq(keccak256(inner), keccak256(abi.encodeWithSelector(IEligibility.NotEligible.selector, alice, uint8(7))));
        _assertConservation();
    }

    function test_limitExclusionBothSides() public {
        uint256 id = _commit(alice, true, 10 * ONE_MCB, 1.02e18, false, 10 * ONE_MCB); // wants >= 1.02: excluded
        _commit(bob, false, 10 * ONE_MAAPLX, 1.0e18, false, 10 * ONE_MAAPLX); // pays <= 1.00: excluded
        _toReveal(id);
        _reveal(alice, true, 10 * ONE_MCB, 1.02e18, false);
        _reveal(bob, false, 10 * ONE_MAAPLX, 1.0e18, false);
        _toSettle(id);
        vm.recordLogs();
        dark.settle(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != IDarkCrossHook.Crossed.selector);
        }
        IDarkCrossHook.BatchResult memory r = dark.batchResult(id);
        assertEq(r.crossedBase, 0);
        assertEq(r.crossedQuote, 0);
        assertEq(dark.order(id, alice).residualIn, 10 * ONE_MCB);
        (uint256 a,) = dark.balances(alice, address(mcb));
        assertEq(a, 10 * ONE_MCB);
        _assertConservation();
    }

    function test_zeroSideNoDivision() public {
        uint256 id = _commit(alice, true, 10 * ONE_MCB, 1.0e18, false, 10 * ONE_MCB);
        _toReveal(id);
        _reveal(alice, true, 10 * ONE_MCB, 1.0e18, false);
        _toSettle(id);
        dark.settle(id);
        assertEq(dark.batchResult(id).crossedBase, 0);
        // Quote side only.
        uint256 id2 = id + 1;
        vm.roll(dark.batchOrigin() + id2 * 20);
        _commit(bob, false, 10 * ONE_MAAPLX, 1.02e18, false, 10 * ONE_MAAPLX);
        _toReveal(id2);
        _reveal(bob, false, 10 * ONE_MAAPLX, 1.02e18, false);
        _toSettle(id2);
        dark.settle(id2);
        assertEq(dark.batchResult(id2).crossedQuote, 0);
        // Empty batch.
        vm.roll(dark.batchOrigin() + (id2 + 1) * 20 + 18);
        dark.settle(id2 + 1);
        assertEq(dark.batchResult(id2 + 1).participants, 0);
        _assertConservation();
    }

    // ---------------------------------------------------------------- commit / reveal

    function test_revealRejectedReasonsNoForfeit() public {
        address carol = makeAddr("carol");
        address dave = makeAddr("dave");
        fund(carol, 1000 * ONE_MCB, 1000 * ONE_MAAPLX);
        fund(dave, 1000 * ONE_MCB, 1000 * ONE_MAAPLX);
        traders.push(carol);
        traders.push(dave);
        (uint256 id,,) = dark.currentBatch();
        // 1 WRONG_LOCK_TOKEN: commits to sellBase but locks the quote token.
        _fundEscrow(alice, address(maaplx), 1 * ONE_MAAPLX);
        bytes32 hA = dark.commitHashOf(id, alice, true, 1 * ONE_MCB, 1e18, false, _salt(alice));
        vm.prank(alice);
        assertTrue(dark.commit(hA, address(maaplx), 1 * ONE_MAAPLX, 0));
        // 2 INSUFFICIENT_LOCK
        _commit(bob, true, 10 * ONE_MCB, 1e18, false, 1 * ONE_MCB);
        // 3 ZERO_AMOUNT
        _commit(carol, true, 0, 1e18, false, 1 * ONE_MCB);
        // 4 ZERO_LIMIT
        _commit(dave, true, 1 * ONE_MCB, 0, false, 1 * ONE_MCB);
        _toReveal(id);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.RevealRejected(id, alice, 1);
        _reveal(alice, true, 1 * ONE_MCB, 1e18, false);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.RevealRejected(id, bob, 2);
        _reveal(bob, true, 10 * ONE_MCB, 1e18, false);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.RevealRejected(id, carol, 3);
        _reveal(carol, true, 0, 1e18, false);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.RevealRejected(id, dave, 4);
        _reveal(dave, true, 1 * ONE_MCB, 0, false);
        _toSettle(id);
        vm.recordLogs();
        dark.settle(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != IDarkCrossHook.Forfeited.selector, "no forfeit");
        }
        assertFalse(dark.order(id, bob).valid);
        assertTrue(dark.order(id, bob).revealed);
        (uint256 bAvail, uint256 bLocked) = dark.balances(bob, address(mcb));
        assertEq(bLocked, 0);
        assertEq(bAvail, 1 * ONE_MCB);
        _assertConservation();
    }

    function test_commitRevealPhasesAndErrors() public {
        _fundEscrow(alice, address(mcb), 100 * ONE_MCB);
        (uint256 id,,) = dark.currentBatch();
        bytes32 h = dark.commitHashOf(id, alice, true, 10 * ONE_MCB, 1e18, false, _salt(alice));
        // Reveal during COMMIT.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IDarkCrossHook.WrongPhase.selector, IDarkCrossHook.Phase.REVEAL, IDarkCrossHook.Phase.COMMIT)
        );
        dark.reveal(true, 10 * ONE_MCB, 1e18, false, _salt(alice));
        // Unsupported lock token.
        MockIssuerToken stray = new MockIssuerToken("S", "S", 18, 1e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.UnsupportedToken.selector, address(stray)));
        dark.commit(h, address(stray), 10 * ONE_MCB, 0);
        // Insufficient escrow.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IDarkCrossHook.InsufficientEscrow.selector, address(mcb), 100 * ONE_MCB, 101 * ONE_MCB)
        );
        dark.commit(h, address(mcb), 101 * ONE_MCB, 0);
        vm.prank(alice);
        assertTrue(dark.commit(h, address(mcb), 10 * ONE_MCB, 0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.AlreadyCommitted.selector, id, alice));
        dark.commit(h, address(mcb), 10 * ONE_MCB, 0);
        // Commit during REVEAL.
        _toReveal(id);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IDarkCrossHook.WrongPhase.selector, IDarkCrossHook.Phase.COMMIT, IDarkCrossHook.Phase.REVEAL)
        );
        dark.commit(h, address(mcb), 10 * ONE_MCB, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.UnknownCommit.selector, id, bob));
        dark.reveal(true, 10 * ONE_MCB, 1e18, false, _salt(bob));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.CommitMismatch.selector, id, alice));
        dark.reveal(true, 11 * ONE_MCB, 1e18, false, _salt(alice));
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.Revealed(id, alice, true, 10 * ONE_MCB, 1e18, false);
        _reveal(alice, true, 10 * ONE_MCB, 1e18, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.AlreadyRevealed.selector, id, alice));
        dark.reveal(true, 10 * ONE_MCB, 1e18, false, _salt(alice));
        // Reveal during SETTLE.
        _toSettle(id);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IDarkCrossHook.WrongPhase.selector, IDarkCrossHook.Phase.REVEAL, IDarkCrossHook.Phase.SETTLE)
        );
        dark.reveal(true, 10 * ONE_MCB, 1e18, false, _salt(alice));
        IDarkCrossHook.Order memory o = dark.order(id, alice);
        assertEq(o.commitHash, h);
        assertEq(o.lockToken, address(mcb));
        assertEq(o.locked, 10 * ONE_MCB);
        assertTrue(o.valid && o.revealed && o.sellBase);
        assertEq(dark.participants(id).length, 1);
    }

    function test_commitHashBindsChainAndContract() public {
        bytes32 h = dark.commitHashOf(0, alice, true, 1, 1, true, "s");
        assertEq(
            h,
            keccak256(abi.encode(block.chainid, address(dark), uint256(0), alice, true, uint256(1), uint256(1), true, bytes32("s")))
        );
        DarkCrossHook other =
            new DarkCrossHook(manager, hook, oracle, eligibility, address(mcb), address(maaplx), key, treasury);
        assertTrue(other.commitHashOf(0, alice, true, 1, 1, true, "s") != h);
        vm.chainId(1301);
        assertTrue(dark.commitHashOf(0, alice, true, 1, 1, true, "s") != h);
    }

    function test_commitDeniedReturnsFalseNoState() public {
        eligibility.setDemoMode(false);
        _fundEscrow(alice, address(mcb), 10 * ONE_MCB);
        (uint256 id,,) = dark.currentBatch();
        bytes32 h = dark.commitHashOf(id, alice, true, 10 * ONE_MCB, 1e18, false, _salt(alice));
        vm.expectEmit(true, true, true, true, address(eligibility));
        emit IEligibility.EligibilityDenied(alice, address(dark), 1, bytes32(0));
        vm.prank(alice);
        assertFalse(dark.commit(h, address(mcb), 10 * ONE_MCB, 0));
        assertEq(dark.participants(id).length, 0);
        assertEq(dark.order(id, alice).commitHash, bytes32(0));
        (uint256 a, uint256 l) = dark.balances(alice, address(mcb));
        assertEq(a, 10 * ONE_MCB);
        assertEq(l, 0);
    }

    // ---------------------------------------------------------------- escrow and forfeits

    function test_withdrawInsufficientEscrow() public {
        _fundEscrow(alice, address(mcb), 5 * ONE_MCB);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IDarkCrossHook.InsufficientEscrow.selector, address(mcb), 5 * ONE_MCB, 6 * ONE_MCB)
        );
        dark.withdraw(address(mcb), 6 * ONE_MCB);
        uint256 before = mcb.balanceOf(alice);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.Withdrawn(alice, address(mcb), 5 * ONE_MCB);
        vm.prank(alice);
        dark.withdraw(address(mcb), 5 * ONE_MCB);
        assertEq(mcb.balanceOf(alice), before + 5 * ONE_MCB);
    }

    function test_fundUnsupportedToken() public {
        MockIssuerToken stray = new MockIssuerToken("S", "S", 18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.UnsupportedToken.selector, address(stray)));
        dark.fund(address(stray), 1);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.UnsupportedToken.selector, address(stray)));
        dark.withdraw(address(stray), 1);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.Funded(alice, address(maaplx), 3);
        _fundEscrow(alice, address(maaplx), 3);
    }

    function test_unrevealedForfeitToTreasuryNonZero() public {
        uint256 lock = dark.MIN_LOCK();
        uint256 id = _commit(alice, true, lock, 1e18, false, lock);
        _toSettle(id);
        vm.expectEmit(true, true, true, true, address(dark));
        emit IDarkCrossHook.Forfeited(id, alice, address(mcb), 10);
        dark.settle(id);
        (uint256 t,) = dark.balances(treasury, address(mcb));
        assertEq(t, 10);
        (uint256 a, uint256 l) = dark.balances(alice, address(mcb));
        assertEq(a, lock - 10);
        assertEq(l, 0);
        _assertConservation();
    }

    function test_commitBelowMinLockReverts() public {
        _fundEscrow(alice, address(mcb), 1 * ONE_MCB);
        uint256 minLock = dark.MIN_LOCK();
        vm.prank(alice);
        vm.expectRevert(IDarkCrossHook.InvalidCommit.selector);
        dark.commit(bytes32(uint256(1)), address(mcb), minLock - 1, 0);
        vm.prank(alice);
        vm.expectRevert(IDarkCrossHook.InvalidCommit.selector);
        dark.commit(bytes32(0), address(mcb), minLock, 0);
        vm.prank(alice);
        assertTrue(dark.commit(bytes32(uint256(1)), address(mcb), minLock, 0));
    }

    function _manyCommits(uint256 n, bool reveal) internal returns (uint256 id, address[] memory who) {
        (id,,) = dark.currentBatch();
        who = new address[](n);
        for (uint256 i; i < n; i++) {
            who[i] = address(uint160(0xA11CE0000 + i));
            bool sellBase = i % 2 == 0;
            uint256 amt = sellBase ? (i + 1) * ONE_MCB : (i + 1) * ONE_MAAPLX;
            fund(who[i], sellBase ? amt : 0, sellBase ? 0 : amt);
            traders.push(who[i]);
            _commit(who[i], sellBase, amt, sellBase ? 1.0e18 : 1.03e18, true, amt);
        }
        if (reveal) {
            _toReveal(id);
            for (uint256 i; i < n; i++) {
                bool sellBase = i % 2 == 0;
                uint256 amt = sellBase ? (i + 1) * ONE_MCB : (i + 1) * ONE_MAAPLX;
                _reveal(who[i], sellBase, amt, sellBase ? 1.0e18 : 1.03e18, true);
            }
        }
    }

    function test_batchFullAt64() public {
        (uint256 id,) = _manyCommits(64, false);
        assertEq(dark.participants(id).length, 64);
        _fundEscrow(alice, address(mcb), ONE_MCB);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.BatchFull.selector, id));
        dark.commit(bytes32(uint256(1)), address(mcb), ONE_MCB, 0);
    }

    function test_settleGasBoundedAt64Participants() public {
        (uint256 id,) = _manyCommits(64, true);
        _toSettle(id);
        uint256 g = gasleft();
        dark.settle(id);
        uint256 used = g - gasleft();
        assertLt(used, 15_000_000, "settle must fit well inside a block");
        emit log_named_uint("settle gas, 64 participants with residuals", used);
        _assertConservation();
    }

    // ---------------------------------------------------------------- settlement timing and oracle

    function test_settleRevertsOracleStale() public {
        uint256 id = _commit(alice, true, 10 * ONE_MCB, 1e18, false, 10 * ONE_MCB);
        _toSettle(id);
        (, uint64 updatedAt) = oracle.getMid(address(mcb), address(maaplx));
        vm.warp(uint256(updatedAt) + 901);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.OracleStale.selector, updatedAt, uint64(updatedAt + 901)));
        dark.settle(id);
        vm.warp(uint256(updatedAt) + 900);
        dark.settle(id);
        // No price at all bubbles the oracle error.
        DarkCrossHook fresh =
            new DarkCrossHook(manager, hook, oracle, eligibility, address(maaplx), address(mcb), key, treasury);
        oracle.setMid(address(mcb), address(maaplx), MID); // inverse exists, so (maaplx, mcb) resolves
        vm.roll(fresh.batchOrigin() + 18);
        fresh.settle(0);
    }

    function test_midMovedAfterRevealRespectsLimits() public {
        uint256 id = _commit(alice, true, 10 * ONE_MCB, 1.01e18, false, 10 * ONE_MCB);
        _commit(bob, false, 10 * ONE_MAAPLX, 1.02e18, false, 10 * ONE_MAAPLX);
        _toReveal(id);
        _reveal(alice, true, 10 * ONE_MCB, 1.01e18, false);
        _reveal(bob, false, 10 * ONE_MAAPLX, 1.02e18, false);
        // Pusher moves the mid below alice's limit after seeing the reveals: alice is protected.
        oracle.setMid(address(mcb), address(maaplx), 1.005e18);
        _toSettle(id);
        dark.settle(id);
        assertEq(dark.batchResult(id).crossedBase, 0);
        (uint256 aMcb,) = dark.balances(alice, address(mcb));
        assertEq(aMcb, 10 * ONE_MCB);
        // Next batch: a mid inside both limits crosses, and each side's price is within its limit.
        uint256 id2 = id + 1;
        vm.roll(dark.batchOrigin() + id2 * 20);
        oracle.setMid(address(mcb), address(maaplx), 1.015e18);
        _commit(alice, true, 10 * ONE_MCB, 1.01e18, false, 10 * ONE_MCB);
        _commit(bob, false, 10 * ONE_MAAPLX, 1.02e18, false, 10 * ONE_MAAPLX);
        _toReveal(id2);
        _reveal(alice, true, 10 * ONE_MCB, 1.01e18, false);
        _reveal(bob, false, 10 * ONE_MAAPLX, 1.02e18, false);
        _toSettle(id2);
        dark.settle(id2);
        IDarkCrossHook.BatchResult memory r = dark.batchResult(id2);
        assertGt(r.crossedBase, 0);
        // Gross price quote/base = mid, inside [1.01, 1.02].
        uint256 px = r.crossedQuote * 1e6 / r.crossedBase;
        assertGe(px, 1.01e18);
        assertLe(px, 1.02e18);
        _assertConservation();
    }

    function test_settlePhaseRules() public {
        uint256 id = _commit(alice, true, 10 * ONE_MCB, 1e18, false, 10 * ONE_MCB);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.BatchNotSettleable.selector, id));
        dark.settle(id);
        _toReveal(id);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.BatchNotSettleable.selector, id));
        dark.settle(id);
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.BatchNotSettleable.selector, id + 1));
        dark.settle(id + 1);
        _toSettle(id);
        dark.settle(id);
        assertTrue(dark.settled(id));
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.AlreadySettled.selector, id));
        dark.settle(id);
        // A past batch is settleable later.
        vm.roll(dark.batchOrigin() + 5 * 20 + 3);
        dark.settle(id + 1);
        assertTrue(dark.settled(id + 1));
    }

    function test_batchResultStored() public {
        uint256 id = _commit(alice, true, 60 * ONE_MCB, 1.01e18, true, 60 * ONE_MCB);
        _commit(bob, false, 50.625e18, 1.015e18, false, 50.625e18);
        _toReveal(id);
        _reveal(alice, true, 60 * ONE_MCB, 1.01e18, true);
        _reveal(bob, false, 50.625e18, 1.015e18, false);
        _toSettle(id);
        dark.settle(id);
        IDarkCrossHook.BatchResult memory r = dark.batchResult(id);
        assertTrue(r.settled);
        assertEq(r.midX18, MID);
        assertEq(r.midUpdatedAt, uint64(block.timestamp));
        assertEq(r.crossedBase, 50 * ONE_MCB);
        assertEq(r.crossedQuote, 50.625e18);
        assertEq(r.residualBaseIn, 10 * ONE_MCB);
        assertEq(r.residualQuoteIn, 0);
        assertEq(r.participants, 2);
    }

    // ---------------------------------------------------------------- callbacks

    function test_unlockCallbackOnlyDuringSettle() public {
        bytes memory payload = abi.encode(uint8(1), uint256(0));
        vm.expectRevert(IDarkCrossHook.NotPoolManager.selector);
        dark.unlockCallback(payload);
        vm.prank(address(manager));
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.Unauthorized.selector, address(manager)));
        dark.unlockCallback(payload);
    }

    function test_executeResidualOnlySelf() public {
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.Unauthorized.selector, address(this)));
        dark.executeResidual(0, alice);
        vm.prank(address(dark));
        vm.expectRevert(abi.encodeWithSelector(IDarkCrossHook.Unauthorized.selector, address(dark)));
        dark.executeResidual(0, alice);
    }

    function test_settleNonReentrant() public {
        ReentrantToken re = new ReentrantToken();
        (address lo, address hi) = address(re) < address(maaplx) ? (address(re), address(maaplx)) : (address(maaplx), address(re));
        PoolKey memory k = PoolKey(Currency.wrap(lo), Currency.wrap(hi), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        DarkCrossHook d = new DarkCrossHook(manager, hook, oracle, eligibility, address(re), address(maaplx), k, treasury);
        re.setTarget(d);
        re.mint(alice, 100e18);
        vm.startPrank(alice);
        re.approve(address(d), type(uint256).max);
        d.fund(address(re), 1e18);
        vm.stopPrank();
        assertEq(re.caught(), DarkCrossHook.Reentrancy.selector);
        (uint256 a,) = d.balances(alice, address(re));
        assertEq(a, 1e18);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_cumulativeFloorAllocationConserves(uint256 seed, uint8 nBase, uint8 nQuote, uint256 mid) public {
        nBase = uint8(bound(nBase, 0, 6));
        nQuote = uint8(bound(nQuote, 0, 6));
        mid = bound(mid, 0.9e18, 1.1e18);
        oracle.setMid(address(mcb), address(maaplx), mid);
        (uint256 id,,) = dark.currentBatch();
        address[] memory who = new address[](uint256(nBase) + nQuote);
        uint256[] memory amts = new uint256[](who.length);
        for (uint256 i; i < who.length; i++) {
            who[i] = address(uint160(0xF00D0000 + i));
            bool sellBase = i < nBase;
            amts[i] = sellBase
                ? bound(uint256(keccak256(abi.encode(seed, i))), dark.MIN_LOCK(), 500 * ONE_MCB)
                : bound(uint256(keccak256(abi.encode(seed, i))), dark.MIN_LOCK(), 500 * ONE_MAAPLX);
            fund(who[i], sellBase ? amts[i] : 0, sellBase ? 0 : amts[i]);
            traders.push(who[i]);
            _commit(who[i], sellBase, amts[i], sellBase ? 1 : type(uint128).max, false, amts[i]);
        }
        _toReveal(id);
        for (uint256 i; i < who.length; i++) {
            bool sellBase = i < nBase;
            _reveal(who[i], sellBase, amts[i], sellBase ? 1 : type(uint128).max, false);
        }
        _toSettle(id);
        dark.settle(id);
        IDarkCrossHook.BatchResult memory r = dark.batchResult(id);
        uint256 sumCrossedBase;
        uint256 sumCrossedQuote;
        uint256 sumBaseReceived;
        uint256 sumQuoteReceived;
        for (uint256 i; i < who.length; i++) {
            IDarkCrossHook.Order memory o = dark.order(id, who[i]);
            assertEq(o.crossedIn + o.residualIn, amts[i]);
            if (i < nBase) {
                sumCrossedBase += o.crossedIn;
                (uint256 q,) = dark.balances(who[i], address(maaplx));
                sumQuoteReceived += q;
            } else {
                sumCrossedQuote += o.crossedIn;
                (uint256 b,) = dark.balances(who[i], address(mcb));
                sumBaseReceived += b;
            }
        }
        (uint256 feeQ,) = dark.balances(treasury, address(maaplx));
        (uint256 feeB,) = dark.balances(treasury, address(mcb));
        assertEq(sumCrossedBase, r.crossedBase, "base allocation exact");
        assertEq(sumCrossedQuote, r.crossedQuote, "quote allocation exact");
        assertEq(sumQuoteReceived + feeQ, r.crossedQuote, "quote received + fees");
        assertEq(sumBaseReceived + feeB, r.crossedBase, "base received + fees");
        assertLe(r.crossedQuote, r.crossedBase * mid * ONE_MAAPLX / (1e18 * ONE_MCB), "never over-crosses");
        _assertConservation();
    }

    function testFuzz_escrowConservation(uint256 seed, uint256 mid, bool dropInventory) public {
        mid = bound(mid, 1.0e18, 1.025e18);
        oracle.setMid(address(mcb), address(maaplx), mid);
        if (dropInventory) {
            uint256 inv = hook.inventory(cur(maaplx));
            hook.withdrawInventory(cur(maaplx), inv / 2, address(this));
        }
        (uint256 id,,) = dark.currentBatch();
        uint256 n = 6;
        address[] memory who = new address[](n);
        for (uint256 i; i < n; i++) {
            who[i] = address(uint160(0xBEEF0000 + i));
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bool sellBase = r % 2 == 0;
            uint256 amt = sellBase ? bound(r >> 8, dark.MIN_LOCK(), 3000 * ONE_MCB) : bound(r >> 8, dark.MIN_LOCK(), 3000 * ONE_MAAPLX);
            uint256 limit = sellBase ? bound(r >> 100, 0.99e18, 1.03e18) : bound(r >> 100, 0.99e18, 1.03e18);
            bool route = (r >> 200) % 3 != 0;
            bool reveals = (r >> 210) % 5 != 0;
            fund(who[i], sellBase ? amt : 0, sellBase ? 0 : amt);
            traders.push(who[i]);
            _commit(who[i], sellBase, amt, limit, route, amt);
            if (reveals) {
                _toReveal(id);
                _reveal(who[i], sellBase, amt, limit, route);
                vm.roll(dark.batchOrigin() + id * 20); // back to COMMIT for the next trader
            }
        }
        _toSettle(id);
        dark.settle(id);
        _assertConservation();
        for (uint256 i; i < n; i++) {
            (, uint256 lb) = dark.balances(who[i], address(mcb));
            (, uint256 lq) = dark.balances(who[i], address(maaplx));
            assertEq(lb + lq, 0, "all locks released");
        }
    }
}

contract DarkCrossHook_McbC0Test is DarkCrossHookBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract DarkCrossHook_MaaplxC0Test is DarkCrossHookBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
