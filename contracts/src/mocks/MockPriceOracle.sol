// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMockPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Settable midpoint oracle for anvil and Base Sepolia. The crank pushes the adapter parity mid.
contract MockPriceOracle is IMockPriceOracle, Ownable {
    struct Mid {
        uint256 midX18;
        uint64 updatedAt;
    }

    mapping(address => mapping(address => Mid)) private _mids;
    mapping(address => bool) public isPusher;

    constructor(address owner_) Ownable(owner_) {}

    function setPusher(address pusher, bool allowed) external onlyOwner {
        isPusher[pusher] = allowed;
        emit PusherSet(pusher, allowed);
    }

    function setMid(address base, address quote, uint256 midX18) external {
        if (!isPusher[msg.sender]) revert NotPusher(msg.sender);
        if (midX18 == 0) revert ZeroMid();
        uint64 ts = uint64(block.timestamp);
        _mids[base][quote] = Mid(midX18, ts);
        emit MidUpdated(base, quote, midX18, ts);
    }

    function getMid(address base, address quote) external view returns (uint256 midX18, uint64 updatedAt) {
        Mid memory m = _mids[base][quote];
        if (m.midX18 != 0) return (m.midX18, m.updatedAt);
        m = _mids[quote][base];
        if (m.midX18 != 0) return (1e36 / m.midX18, m.updatedAt);
        revert NoPrice(base, quote);
    }
}
