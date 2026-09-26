// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MultiplierAdapterBase} from "./MultiplierAdapterBase.sol";

/// @notice Coinbase B20-style issuer token: 18-decimal multiplier independent of token decimals.
contract B20MultiplierAdapter is MultiplierAdapterBase {
    constructor(address token_, bytes32 underlying_) MultiplierAdapterBase(token_, underlying_) {}

    function name() external pure returns (string memory) {
        return "Coinbase B20";
    }
}
