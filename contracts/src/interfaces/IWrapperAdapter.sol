// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IWrapperAdapter
/// @notice Reads one issuer token's issuer-token -> canonical-share ratio and its health.
/// @dev sharesPerToken is the number of canonical shares (1e18 fixed point) represented by ONE WHOLE token
///      (10**tokenDecimals raw units). A healthy adapter is not paused and not stale.
interface IWrapperAdapter {
    struct Health {
        bool paused;
        bool stale;
        uint64 updatedAt;
    }

    event RatioUpdated(address indexed token, uint256 oldSharesPerToken, uint256 newSharesPerToken);
    event AdapterPaused(address indexed token, bool paused);

    error InvalidRatio(uint256 sharesPerToken);

    function token() external view returns (address);
    function underlying() external view returns (bytes32);
    function name() external view returns (string memory);
    function tokenDecimals() external view returns (uint8);
    function sharesPerToken() external view returns (uint256);
    function health() external view returns (Health memory);
    function ratio() external view returns (uint256 sharesPerToken, bool healthy);
}
