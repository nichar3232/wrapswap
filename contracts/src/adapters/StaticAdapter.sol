// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IWrapperAdapter} from "../interfaces/IWrapperAdapter.sol";

/// @notice Owner-set ratio for issuers without an on-chain multiplier.
contract StaticAdapter is IWrapperAdapter, Ownable {
    uint256 internal constant MAX_RATIO = 1e24;

    address public immutable token;
    bytes32 public immutable underlying;
    uint8 public immutable tokenDecimals;
    string public name;
    uint256 public sharesPerToken;
    bool public paused;
    uint64 public updatedAt;

    constructor(address token_, bytes32 underlying_, string memory name_, uint256 sharesPerToken_, address owner_)
        Ownable(owner_)
    {
        if (sharesPerToken_ == 0 || sharesPerToken_ > MAX_RATIO) revert InvalidRatio(sharesPerToken_);
        token = token_;
        underlying = underlying_;
        tokenDecimals = IERC20Metadata(token_).decimals();
        name = name_;
        sharesPerToken = sharesPerToken_;
        updatedAt = uint64(block.timestamp);
    }

    function setSharesPerToken(uint256 newSharesPerToken) external onlyOwner {
        if (newSharesPerToken == 0 || newSharesPerToken > MAX_RATIO) revert InvalidRatio(newSharesPerToken);
        emit RatioUpdated(token, sharesPerToken, newSharesPerToken);
        sharesPerToken = newSharesPerToken;
        updatedAt = uint64(block.timestamp);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit AdapterPaused(token, paused_);
    }

    function health() external view returns (Health memory) {
        return Health(paused, false, updatedAt);
    }

    function ratio() external view returns (uint256, bool) {
        return (sharesPerToken, !paused);
    }
}
