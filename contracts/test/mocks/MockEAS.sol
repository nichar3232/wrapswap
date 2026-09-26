// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Attestation, IEAS} from "../../src/EASEligibility.sol";

/// @notice Settable EAS stand-in: getAttestation returns whatever was stored (zeroed record if unknown).
contract MockEAS is IEAS {
    mapping(bytes32 => Attestation) internal _a;
    bool public reverts;

    function set(Attestation memory a) external {
        _a[a.uid] = a;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function getAttestation(bytes32 uid) external view returns (Attestation memory) {
        require(!reverts, "eas down");
        return _a[uid];
    }
}
