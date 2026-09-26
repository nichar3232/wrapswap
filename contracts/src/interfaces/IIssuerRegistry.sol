// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IIssuerRegistry
/// @notice Owner-curated set of issuer tokens, each bound to one IWrapperAdapter and one underlying security.
interface IIssuerRegistry {
    event IssuerAdded(address indexed token, address indexed adapter, bytes32 indexed underlying);
    event IssuerRemoved(address indexed token, address indexed adapter, bytes32 indexed underlying);
    event IssuerPaused(address indexed token, bool paused);

    error AlreadyRegistered(address token);
    error UnknownIssuer(address token);
    error InvalidAdapter(address adapter);

    function add(address adapter) external;
    function remove(address token) external;
    function setPaused(address token, bool paused) external;

    function adapters() external view returns (address[] memory);
    function adapterOf(address token) external view returns (address);
    function underlyingOf(address token) external view returns (bytes32);
    function isIssuer(address token) external view returns (bool);
    function paused(address token) external view returns (bool);
    /// @notice Registered, not paused in the registry, and the adapter reports healthy.
    function active(address token) external view returns (bool);
}
