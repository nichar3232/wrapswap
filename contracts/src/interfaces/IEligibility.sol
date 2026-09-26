// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IEligibility
/// @notice Swapper eligibility gate shared by ParityHook and DarkCrossHook.
/// @dev Reason codes: 0 OK, 1 NO_ATTESTATION, 2 WRONG_SCHEMA, 3 WRONG_ATTESTER, 4 WRONG_RECIPIENT, 5 REVOKED,
///      6 EXPIRED, 7 RESTRICTED_COUNTRY. demoMode=true makes check() return (true, 0) for every account.
interface IEligibility {
    event DemoModeSet(bool enabled, address indexed setBy);
    event TrustedRouterSet(address indexed router, bool trusted);
    event EligibilityDenied(address indexed account, address indexed caller, uint8 indexed reason, bytes32 attestationUid);

    error NotEligible(address account, uint8 reason);
    error NotOwner(address caller);

    function owner() external view returns (address);
    function demoMode() external view returns (bool);
    function setDemoMode(bool enabled) external;

    /// @notice Pure read. attestationUid == 0 resolves the account's attestation through the configured indexer.
    function check(address account, bytes32 attestationUid) external view returns (bool eligible, uint8 reason);
    /// @notice Same decision as check(); on denial emits EligibilityDenied and returns false. Never reverts on denial.
    function enforce(address account, bytes32 attestationUid) external returns (bool eligible);

    function isTrustedRouter(address router) external view returns (bool);
    function setTrustedRouter(address router, bool trusted) external;
    /// @notice claimedSwapper if sender is a trusted router and claimedSwapper != 0, otherwise sender.
    function resolveSwapper(address sender, address claimedSwapper) external view returns (address);
}

/// @title IEASEligibility
/// @notice IEligibility backed by the Coinbase "Verified Country" EAS attestation; restrictedCountry is "US".
interface IEASEligibility is IEligibility {
    function eas() external view returns (address);
    function attestationIndexer() external view returns (address);
    function schemaUid() external view returns (bytes32);
    function trustedAttester() external view returns (address);
    function restrictedCountry() external view returns (string memory);
}
