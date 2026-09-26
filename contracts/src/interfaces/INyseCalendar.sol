// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title INyseCalendar
/// @notice NYSE regular-session clock evaluated at a unix timestamp (always block.timestamp on-chain).
/// @dev day = floor((ts - utcOffset) / 86400) where utcOffset is 4h (EDT) or 5h (EST). Sessions 09:30-16:00 local,
///      or 09:30-earlyClose. Weekends and holidays are closed.
interface INyseCalendar {
    event HolidaySet(uint256 indexed day, bool closed);
    event EarlyCloseSet(uint256 indexed day, uint256 secondsAfterMidnight);

    error InvalidEarlyClose(uint256 secondsAfterMidnight);
    error NoTransitionWithinYear(uint256 ts);

    function isOpen(uint256 ts) external view returns (bool);
    /// @notice First timestamp strictly after ts at which isOpen flips.
    function nextTransition(uint256 ts) external view returns (uint256);
    function holidays(uint256 day) external view returns (bool);
    function earlyClose(uint256 day) external view returns (uint256);

    function setHoliday(uint256 day, bool closed) external;
    function setEarlyClose(uint256 day, uint256 secondsAfterMidnight) external;
}
