// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMockIssuerToken} from "../interfaces/IMockIssuerToken.sol";

/// @notice Local/testnet stand-in for an issuer security token (mcbAAPL, mAAPLx). Never a redeemable security.
/// @dev Issuer-faithful decimals and a settable multiplier (canonical shares per whole token, 1e18).
contract MockIssuerToken is IMockIssuerToken, ERC20, Ownable {
    uint8 private immutable _decimals;
    uint256 public multiplier;
    bool public transfersPaused;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 initialMultiplier)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {
        if (initialMultiplier == 0) revert InvalidMultiplier(0);
        _decimals = decimals_;
        multiplier = initialMultiplier;
        emit MultiplierUpdated(0, initialMultiplier);
    }

    function decimals() public view override(ERC20, IERC20Metadata) returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function setMultiplier(uint256 newMultiplier) external onlyOwner {
        if (newMultiplier == 0) revert InvalidMultiplier(0);
        emit MultiplierUpdated(multiplier, newMultiplier);
        multiplier = newMultiplier;
    }

    function setTransfersPaused(bool paused_) external onlyOwner {
        transfersPaused = paused_;
        emit TransfersPaused(paused_);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (transfersPaused) revert TokenPaused();
        super._update(from, to, value);
    }
}
