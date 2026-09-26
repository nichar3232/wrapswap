// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EASEligibility, Attestation} from "../src/EASEligibility.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {MockEAS} from "./mocks/MockEAS.sol";
import {MockAttestationIndexer} from "./mocks/MockAttestationIndexer.sol";

contract EASEligibilityTest is Test {
    bytes32 constant SCHEMA = keccak256("VerifiedCountry");
    address owner = makeAddr("owner");
    address attester = makeAddr("attester");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address router = makeAddr("router");
    address hook = makeAddr("hook");

    MockEAS eas;
    MockAttestationIndexer indexer;
    EASEligibility elig;

    event DemoModeSet(bool enabled, address indexed setBy);
    event TrustedRouterSet(address indexed router, bool trusted);
    event EligibilityDenied(address indexed account, address indexed caller, uint8 indexed reason, bytes32 attestationUid);

    function setUp() public {
        vm.warp(1_790_000_000);
        eas = new MockEAS();
        indexer = new MockAttestationIndexer();
        elig = new EASEligibility(owner, address(eas), address(indexer), SCHEMA, attester, "US");
    }

    function _att(bytes32 uid, address recipient, string memory country) internal view returns (Attestation memory a) {
        a.uid = uid;
        a.schema = SCHEMA;
        a.time = uint64(block.timestamp - 100);
        a.recipient = recipient;
        a.attester = attester;
        a.revocable = true;
        a.data = abi.encode(country);
    }

    function _check(address account, bytes32 uid, bool wantOk, uint8 wantReason) internal view {
        (bool ok, uint8 reason) = elig.check(account, uid);
        assertEq(ok, wantOk);
        assertEq(reason, wantReason);
    }

    function test_reasons() public {
        assertEq(elig.eas(), address(eas));
        assertEq(elig.attestationIndexer(), address(indexer));
        assertEq(elig.schemaUid(), SCHEMA);
        assertEq(elig.trustedAttester(), attester);
        assertEq(elig.restrictedCountry(), "US");
        assertEq(elig.owner(), owner);
        assertFalse(elig.demoMode());

        // 0 OK.
        eas.set(_att("ok", alice, "FR"));
        _check(alice, "ok", true, 0);

        // 1 NO_ATTESTATION: unknown uid (zeroed record) and zero uid with no indexer entry.
        _check(alice, "missing", false, 1);
        _check(alice, bytes32(0), false, 1);

        // 2 WRONG_SCHEMA.
        Attestation memory a = _att("schema", alice, "FR");
        a.schema = keccak256("other");
        eas.set(a);
        _check(alice, "schema", false, 2);

        // 2 WRONG_SCHEMA: undecodable data.
        a = _att("garbage", alice, "FR");
        a.data = hex"deadbeef";
        eas.set(a);
        _check(alice, "garbage", false, 2);
        a = _att("empty", alice, "FR");
        a.data = "";
        eas.set(a);
        _check(alice, "empty", false, 2);

        // 3 WRONG_ATTESTER.
        a = _att("attester", alice, "FR");
        a.attester = bob;
        eas.set(a);
        _check(alice, "attester", false, 3);

        // 4 WRONG_RECIPIENT.
        eas.set(_att("recipient", bob, "FR"));
        _check(alice, "recipient", false, 4);
        _check(bob, "recipient", true, 0);

        // 5 REVOKED.
        a = _att("revoked", alice, "FR");
        a.revocationTime = uint64(block.timestamp - 1);
        eas.set(a);
        _check(alice, "revoked", false, 5);

        // 6 EXPIRED.
        a = _att("expired", alice, "FR");
        a.expirationTime = uint64(block.timestamp - 1);
        eas.set(a);
        _check(alice, "expired", false, 6);
        a = _att("future", alice, "FR");
        a.expirationTime = uint64(block.timestamp + 1);
        eas.set(a);
        _check(alice, "future", true, 0);

        // 7 RESTRICTED_COUNTRY.
        eas.set(_att("us", alice, "US"));
        _check(alice, "us", false, 7);

        // First-failure ordering.
        a = _att("attRevoked", alice, "US");
        a.attester = bob;
        a.revocationTime = 1;
        eas.set(a);
        _check(alice, "attRevoked", false, 3);

        a = _att("schemaAll", bob, "US");
        a.schema = bytes32(uint256(1));
        a.attester = bob;
        a.revocationTime = 1;
        a.expirationTime = 1;
        eas.set(a);
        _check(alice, "schemaAll", false, 2);

        a = _att("recipRevoked", bob, "US");
        a.revocationTime = 1;
        eas.set(a);
        _check(alice, "recipRevoked", false, 4);

        a = _att("revExpUS", alice, "US");
        a.revocationTime = 1;
        a.expirationTime = 1;
        eas.set(a);
        _check(alice, "revExpUS", false, 5);

        a = _att("expUS", alice, "US");
        a.expirationTime = 1;
        eas.set(a);
        _check(alice, "expUS", false, 6);

        // Expired + garbage data: expiry checked before decoding.
        a = _att("expGarbage", alice, "FR");
        a.expirationTime = 1;
        a.data = hex"01";
        eas.set(a);
        _check(alice, "expGarbage", false, 6);
    }

    function test_indexerLookupWhenUidZero() public {
        eas.set(_att("aliceFR", alice, "FR"));
        eas.set(_att("bobUS", bob, "US"));
        indexer.set(alice, SCHEMA, "aliceFR");
        indexer.set(bob, SCHEMA, "bobUS");
        _check(alice, bytes32(0), true, 0);
        _check(bob, bytes32(0), false, 7);

        // Indexer entry under a different schema is ignored.
        address carol = makeAddr("carol");
        eas.set(_att("carolFR", carol, "FR"));
        indexer.set(carol, keccak256("other"), "carolFR");
        _check(carol, bytes32(0), false, 1);

        // An explicit uid bypasses the indexer.
        _check(bob, "aliceFR", false, 4);

        // enforce emits the uid actually evaluated (the indexer's answer).
        vm.expectEmit(true, true, true, true, address(elig));
        emit EligibilityDenied(bob, address(this), 7, "bobUS");
        assertFalse(elig.enforce(bob, bytes32(0)));
    }

    function test_nullEasReturnsNoAttestation() public {
        EASEligibility nullElig = new EASEligibility(owner, address(0), address(0), SCHEMA, attester, "US");
        (bool ok, uint8 reason) = nullElig.check(alice, bytes32(0));
        assertFalse(ok);
        assertEq(reason, 1);
        (ok, reason) = nullElig.check(alice, "someuid");
        assertFalse(ok);
        assertEq(reason, 1);
        assertFalse(nullElig.enforce(alice, "someuid"));

        // EOA addresses for EAS/indexer behave the same.
        EASEligibility eoaElig =
            new EASEligibility(owner, makeAddr("easEoa"), makeAddr("idxEoa"), SCHEMA, attester, "US");
        (ok, reason) = eoaElig.check(alice, "someuid");
        assertFalse(ok);
        assertEq(reason, 1);

        // EAS that reverts -> 1.
        eas.set(_att("ok", alice, "FR"));
        _check(alice, "ok", true, 0);
        eas.setReverts(true);
        _check(alice, "ok", false, 1);
        assertFalse(elig.enforce(alice, "ok"));

        // Null EAS in demo mode admits.
        vm.prank(owner);
        nullElig.setDemoMode(true);
        (ok, reason) = nullElig.check(alice, bytes32(0));
        assertTrue(ok);
        assertEq(reason, 0);
    }

    function test_setDemoModeOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IEligibility.NotOwner.selector, alice));
        elig.setDemoMode(true);
        assertFalse(elig.demoMode());

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IEligibility.NotOwner.selector, alice));
        elig.setTrustedRouter(router, true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IEligibility.NotOwner.selector, alice));
        elig.transferOwnership(alice);

        vm.prank(owner);
        elig.transferOwnership(bob);
        assertEq(elig.owner(), bob);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IEligibility.NotOwner.selector, owner));
        elig.setDemoMode(true);
        vm.prank(bob);
        elig.setDemoMode(true);
        assertTrue(elig.demoMode());
    }

    function test_setDemoModeEmits() public {
        vm.expectEmit(true, false, false, true, address(elig));
        emit DemoModeSet(true, owner);
        vm.prank(owner);
        elig.setDemoMode(true);
        assertTrue(elig.demoMode());

        vm.expectEmit(true, false, false, true, address(elig));
        emit DemoModeSet(false, owner);
        vm.prank(owner);
        elig.setDemoMode(false);
        assertFalse(elig.demoMode());
    }

    function test_demoModeOffRejectsUS() public {
        eas.set(_att("us", alice, "US"));
        eas.set(_att("fr", bob, "FR"));
        _check(alice, "us", false, 7);
        _check(bob, "fr", true, 0);

        vm.prank(owner);
        elig.setDemoMode(true);
        _check(alice, "us", true, 0);
        _check(bob, "fr", true, 0);
        _check(alice, bytes32(0), true, 0); // no attestation at all
        _check(alice, "nonexistent", true, 0);
        assertTrue(elig.enforce(alice, "us"));

        vm.prank(owner);
        elig.setDemoMode(false);
        _check(alice, "us", false, 7);

        // Case-sensitive exact match on the restricted country.
        eas.set(_att("lower", alice, "us"));
        _check(alice, "lower", true, 0);
    }

    function test_enforceEmitsCallerAsMsgSender() public {
        eas.set(_att("us", alice, "US"));
        eas.set(_att("fr", bob, "FR"));

        vm.expectEmit(true, true, true, true, address(elig));
        emit EligibilityDenied(alice, hook, 7, "us");
        vm.prank(hook);
        assertFalse(elig.enforce(alice, "us"));

        vm.expectEmit(true, true, true, true, address(elig));
        emit EligibilityDenied(alice, router, 1, "missing");
        vm.prank(router);
        assertFalse(elig.enforce(alice, "missing"));

        // Success: returns true and emits nothing.
        vm.recordLogs();
        vm.prank(hook);
        assertTrue(elig.enforce(bob, "fr"));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function testFuzz_resolveSwapper(address sender, address claimed, bool trusted) public {
        vm.prank(owner);
        elig.setTrustedRouter(sender, trusted);
        address got = elig.resolveSwapper(sender, claimed);
        if (trusted && claimed != address(0)) assertEq(got, claimed);
        else assertEq(got, sender);
        assertEq(elig.isTrustedRouter(sender), trusted);
    }

    function test_setTrustedRouterEmits() public {
        vm.expectEmit(true, false, false, true, address(elig));
        emit TrustedRouterSet(router, true);
        vm.prank(owner);
        elig.setTrustedRouter(router, true);
        assertTrue(elig.isTrustedRouter(router));
        assertEq(elig.resolveSwapper(router, alice), alice);
        assertEq(elig.resolveSwapper(router, address(0)), router);
        assertEq(elig.resolveSwapper(bob, alice), bob);

        vm.expectEmit(true, false, false, true, address(elig));
        emit TrustedRouterSet(router, false);
        vm.prank(owner);
        elig.setTrustedRouter(router, false);
        assertFalse(elig.isTrustedRouter(router));
        assertEq(elig.resolveSwapper(router, alice), router);
    }

    function test_expiredAtExactTimestamp() public {
        Attestation memory a = _att("edge", alice, "FR");
        a.expirationTime = uint64(block.timestamp);
        eas.set(a);
        _check(alice, "edge", false, 6);

        vm.warp(block.timestamp - 1);
        _check(alice, "edge", true, 0);
        vm.warp(block.timestamp + 2);
        _check(alice, "edge", false, 6);
    }
}
