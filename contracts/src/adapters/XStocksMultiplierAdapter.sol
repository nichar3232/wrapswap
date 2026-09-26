// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MultiplierAdapterBase} from "./MultiplierAdapterBase.sol";

/// @notice Backed xStocks-style issuer token: corporate actions surface through the token's multiplier.
contract XStocksMultiplierAdapter is MultiplierAdapterBase {
    constructor(address token_, bytes32 underlying_) MultiplierAdapterBase(token_, underlying_) {}

    function name() external pure returns (string memory) {
        return "Backed xStocks";
    }
}
