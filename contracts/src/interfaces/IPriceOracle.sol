// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IPriceOracle
/// @notice Midpoint of an issuer-token pair: whole quote tokens per ONE whole base token, 1e18 fixed point.
interface IPriceOracle {
    event MidUpdated(address indexed base, address indexed quote, uint256 midX18, uint64 updatedAt);

    error NoPrice(address base, address quote);

    /// @dev If only (quote, base) is stored, returns floor(1e36 / stored) with the stored updatedAt.
    function getMid(address base, address quote) external view returns (uint256 midX18, uint64 updatedAt);
}

/// @title IMockPriceOracle
/// @notice Settable oracle used on anvil and Unichain Sepolia; only authorized pushers may set.
interface IMockPriceOracle is IPriceOracle {
    event PusherSet(address indexed pusher, bool allowed);

    error NotPusher(address caller);
    error ZeroMid();

    function setMid(address base, address quote, uint256 midX18) external;
    function setPusher(address pusher, bool allowed) external;
    function isPusher(address pusher) external view returns (bool);
}
