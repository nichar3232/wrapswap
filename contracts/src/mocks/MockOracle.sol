// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Explicitly mock 8-decimal feed for testnet; fork uses verified Chainlink proxy.
contract MockOracle {
    address public immutable owner;
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 price) {
        owner = msg.sender;
        answer = price;
        updatedAt = block.timestamp;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function setAnswer(int256 price) external {
        require(msg.sender == owner && price > 0);
        answer = price;
        updatedAt = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
