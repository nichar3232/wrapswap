// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEASEligibility} from "./interfaces/IEligibility.sol";

/// @notice EAS attestation record (EAS `Common.sol`).
struct Attestation {
    bytes32 uid;
    bytes32 schema;
    uint64 time;
    uint64 expirationTime;
    uint64 revocationTime;
    bytes32 refUID;
    address recipient;
    address attester;
    bool revocable;
    bytes data;
}

/// @notice Minimal EAS read surface.
interface IEAS {
    function getAttestation(bytes32 uid) external view returns (Attestation memory);
}

/// @notice Coinbase attestation indexer: latest attestation uid per (recipient, schema).
interface IAttestationIndexer {
    function getAttestationUid(address recipient, bytes32 schemaUid) external view returns (bytes32);
}

/// @notice IEligibility backed by the Coinbase "Verified Country" EAS schema; accounts attested as
///         `restrictedCountry` ("US") are denied. demoMode admits everyone.
/// @dev Decision procedure per INTERFACES.md §1.4; the first failing step is the reason code. Missing EAS or
///      indexer contracts (anvil) and every revert on the read path map to a denial, never a revert.
contract EASEligibility is IEASEligibility {
    uint8 internal constant OK = 0;
    uint8 internal constant NO_ATTESTATION = 1;
    uint8 internal constant WRONG_SCHEMA = 2;
    uint8 internal constant WRONG_ATTESTER = 3;
    uint8 internal constant WRONG_RECIPIENT = 4;
    uint8 internal constant REVOKED = 5;
    uint8 internal constant EXPIRED = 6;
    uint8 internal constant RESTRICTED_COUNTRY = 7;

    address public immutable eas;
    address public immutable attestationIndexer;
    bytes32 public immutable schemaUid;
    address public immutable trustedAttester;
    bytes32 private immutable _restrictedHash;
    string private _restrictedCountry;

    address public owner;
    bool public demoMode;
    mapping(address => bool) public isTrustedRouter;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor(
        address owner_,
        address eas_,
        address attestationIndexer_,
        bytes32 schemaUid_,
        address trustedAttester_,
        string memory restrictedCountry_
    ) {
        owner = owner_;
        eas = eas_;
        attestationIndexer = attestationIndexer_;
        schemaUid = schemaUid_;
        trustedAttester = trustedAttester_;
        _restrictedCountry = restrictedCountry_;
        _restrictedHash = keccak256(bytes(restrictedCountry_));
        emit OwnershipTransferred(address(0), owner_);
    }

    function restrictedCountry() external view returns (string memory) {
        return _restrictedCountry;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setDemoMode(bool enabled) external onlyOwner {
        demoMode = enabled;
        emit DemoModeSet(enabled, msg.sender);
    }

    function setTrustedRouter(address router, bool trusted) external onlyOwner {
        isTrustedRouter[router] = trusted;
        emit TrustedRouterSet(router, trusted);
    }

    function resolveSwapper(address sender, address claimedSwapper) external view returns (address) {
        return isTrustedRouter[sender] && claimedSwapper != address(0) ? claimedSwapper : sender;
    }

    function check(address account, bytes32 attestationUid) external view returns (bool eligible, uint8 reason) {
        (reason,) = _decide(account, attestationUid);
        eligible = reason == OK;
    }

    /// @dev Emits the uid actually evaluated (the indexer's answer when the argument is zero).
    function enforce(address account, bytes32 attestationUid) external returns (bool eligible) {
        (uint8 reason, bytes32 uid) = _decide(account, attestationUid);
        eligible = reason == OK;
        if (!eligible) emit EligibilityDenied(account, msg.sender, reason, uid);
    }

    /// @notice ABI-decodes a Verified Country payload; external so check() can isolate malformed data in try/catch.
    function decodeCountry(bytes calldata data) external pure returns (string memory) {
        return abi.decode(data, (string));
    }

    function _decide(address account, bytes32 uid) internal view returns (uint8, bytes32) {
        if (demoMode) return (OK, uid);
        if (uid == bytes32(0) && attestationIndexer.code.length != 0) {
            try IAttestationIndexer(attestationIndexer).getAttestationUid(account, schemaUid) returns (bytes32 u) {
                uid = u;
            } catch {}
        }
        if (uid == bytes32(0) || eas.code.length == 0) return (NO_ATTESTATION, uid);
        Attestation memory a;
        try IEAS(eas).getAttestation(uid) returns (Attestation memory got) {
            a = got;
        } catch {
            return (NO_ATTESTATION, uid);
        }
        if (a.uid == bytes32(0)) return (NO_ATTESTATION, uid);
        if (a.schema != schemaUid) return (WRONG_SCHEMA, uid);
        if (a.attester != trustedAttester) return (WRONG_ATTESTER, uid);
        if (a.recipient != account) return (WRONG_RECIPIENT, uid);
        if (a.revocationTime != 0) return (REVOKED, uid);
        if (a.expirationTime != 0 && a.expirationTime <= block.timestamp) return (EXPIRED, uid);
        try this.decodeCountry(a.data) returns (string memory country) {
            if (keccak256(bytes(country)) == _restrictedHash) return (RESTRICTED_COUNTRY, uid);
        } catch {
            return (WRONG_SCHEMA, uid);
        }
        return (OK, uid);
    }
}
