// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Explicit issuer mock, never represents a redeemable security.
contract MockIssuerToken is ERC20, Ownable {
    uint8 private immutable unitDecimals;
    uint256 public sharesPerToken = 1e18;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) Ownable(msg.sender) {
        require(d <= 18);
        unitDecimals = d;
    }

    function decimals() public view override returns (uint8) {
        return unitDecimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function setSharesPerToken(uint256 ratio) external onlyOwner {
        require(ratio > 0);
        sharesPerToken = ratio;
    }
}
