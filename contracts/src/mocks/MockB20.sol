// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {MockIssuerToken} from "./MockIssuerToken.sol";

/// @notice Compatibility model of consumed B20 ABI; native precompile unsupported by Anvil.
contract MockB20 is MockIssuerToken {
    bool public transfersPaused;
    constructor() MockIssuerToken("Mock Coinbase Apple", "mAAPLc", 8) {}

    function multiplier() external view returns (uint256) {
        return sharesPerToken;
    }

    function setMultiplier(uint256 ratio) external onlyOwner {
        require(ratio > 0);
        sharesPerToken = ratio;
    }

    function pausedFeatures() external view returns (uint8[] memory p) {
        p = new uint8[](transfersPaused ? 1 : 0);
    }

    function setPaused(bool paused) external onlyOwner {
        transfersPaused = paused;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!transfersPaused, "B20 paused");
        super._update(from, to, value);
    }
}
