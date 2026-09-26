// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAttestationIndexer} from "../../src/EASEligibility.sol";

contract MockAttestationIndexer is IAttestationIndexer {
    mapping(address => mapping(bytes32 => bytes32)) public uidOf;

    function set(address recipient, bytes32 schema, bytes32 uid) external {
        uidOf[recipient][schema] = uid;
    }

    function getAttestationUid(address recipient, bytes32 schemaUid) external view returns (bytes32) {
        return uidOf[recipient][schemaUid];
    }
}
