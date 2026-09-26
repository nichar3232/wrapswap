// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title IMockIssuerToken
/// @notice Testnet/local stand-in for a real issuer security token (Coinbase B20 AAPL, Backed xStocks AAPLx).
/// @dev Issuer-faithful decimals. multiplier() is canonical shares per whole token, 1e18 fixed point.
interface IMockIssuerToken is IERC20Metadata {
    event MultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);
    event TransfersPaused(bool paused);

    error InvalidMultiplier(uint256 multiplier);
    error TokenPaused();

    function multiplier() external view returns (uint256);
    function transfersPaused() external view returns (bool);
    function mint(address to, uint256 amount) external;
    function setMultiplier(uint256 newMultiplier) external;
    function setTransfersPaused(bool paused) external;
}
