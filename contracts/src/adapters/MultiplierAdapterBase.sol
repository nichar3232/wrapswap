// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IWrapperAdapter} from "../interfaces/IWrapperAdapter.sol";
import {IMockIssuerToken} from "../interfaces/IMockIssuerToken.sol";

/// @notice Reads an issuer token's own multiplier (canonical shares per whole token, 1e18) and pause flag.
/// @dev Freshness is inherent (the ratio is read live), so stale is always false and updatedAt is block.timestamp.
///      sharesPerToken() reverts InvalidRatio outside (0, 1e24]; ratio() and health() never revert.
abstract contract MultiplierAdapterBase is IWrapperAdapter {
    uint256 public constant MAX_RATIO = 1e24;

    address public immutable token;
    bytes32 public immutable underlying;
    uint8 public immutable tokenDecimals;

    constructor(address token_, bytes32 underlying_) {
        token = token_;
        underlying = underlying_;
        tokenDecimals = IERC20Metadata(token_).decimals();
    }

    function sharesPerToken() external view returns (uint256 spt) {
        spt = IMockIssuerToken(token).multiplier();
        if (spt == 0 || spt > MAX_RATIO) revert InvalidRatio(spt);
    }

    function health() external view returns (Health memory) {
        return Health(_paused(), false, uint64(block.timestamp));
    }

    function ratio() external view returns (uint256 spt, bool healthy) {
        try IMockIssuerToken(token).multiplier() returns (uint256 m) {
            spt = m;
        } catch {
            return (0, false);
        }
        healthy = spt != 0 && spt <= MAX_RATIO && !_paused();
    }

    function _paused() internal view returns (bool) {
        try IMockIssuerToken(token).transfersPaused() returns (bool p) {
            return p;
        } catch {
            return true;
        }
    }
}
