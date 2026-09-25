// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {IIssuerAdapter} from "./IIssuerAdapter.sol";

interface IB20 {
    function multiplier() external view returns (uint256);
    function pausedFeatures() external view returns (uint8[] memory);
}

/// @notice B20 multiplier is expressed with 18 decimals independently of token decimals.
contract B20Adapter is IIssuerAdapter {
    address public immutable token;
    string public name;

    constructor(address t) {
        token = t;
        name = "Coinbase B20";
    }

    function sharesPerToken() external view returns (uint256) {
        return IB20(token).multiplier();
    }

    function paused() external view returns (bool) {
        return IB20(token).pausedFeatures().length != 0;
    }
}
