// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {INyseCalendar} from "./interfaces/INyseCalendar.sol";

/// @notice NYSE regular sessions 09:30-16:00 America/New_York, DST-correct, with 2026-2027 holidays and early closes.
/// @dev Pure function of the timestamp argument; callers pass block.timestamp, so anvil warps and Sepolia's real
///      clock both work. `day` is the local (ET) calendar day number since 1970-01-01.
contract NyseCalendar is INyseCalendar, Ownable {
    uint256 internal constant OPEN_SECONDS = 34200; // 09:30
    uint256 internal constant CLOSE_SECONDS = 57600; // 16:00
    uint256 internal constant EARLY_CLOSE_SECONDS = 46800; // 13:00

    mapping(uint256 => bool) public holidays;
    mapping(uint256 => uint256) public earlyClose;

    constructor(address owner_) Ownable(owner_) {
        uint16[20] memory closed = [
            // 2026: New Year, MLK, Presidents, Good Friday, Memorial, Juneteenth, Independence (obs. Fri 3 Jul),
            // Labor, Thanksgiving, Christmas
            20454, 20472, 20500, 20546, 20598, 20623, 20637, 20703, 20783, 20812,
            // 2027: New Year, MLK, Presidents, Good Friday, Memorial, Juneteenth (obs. Fri 18 Jun),
            // Independence (obs. Mon 5 Jul), Labor, Thanksgiving, Christmas (obs. Fri 24 Dec)
            20819, 20836, 20864, 20903, 20969, 20987, 21004, 21067, 21147, 21176
        ];
        for (uint256 i; i < closed.length; i++) {
            holidays[closed[i]] = true;
            emit HolidaySet(closed[i], true);
        }
        // 13:00 early closes: Fri 2026-11-27, Thu 2026-12-24, Fri 2027-11-26.
        uint16[3] memory early = [20784, 20811, 21148];
        for (uint256 i; i < early.length; i++) {
            earlyClose[early[i]] = EARLY_CLOSE_SECONDS;
            emit EarlyCloseSet(early[i], EARLY_CLOSE_SECONDS);
        }
    }

    function setHoliday(uint256 day, bool closed) external onlyOwner {
        holidays[day] = closed;
        emit HolidaySet(day, closed);
    }

    /// @dev 0 clears the early close; otherwise the session must close after the open and no later than 16:00.
    function setEarlyClose(uint256 day, uint256 secondsAfterMidnight) external onlyOwner {
        if (secondsAfterMidnight != 0 && (secondsAfterMidnight <= OPEN_SECONDS || secondsAfterMidnight > CLOSE_SECONDS))
        {
            revert InvalidEarlyClose(secondsAfterMidnight);
        }
        earlyClose[day] = secondsAfterMidnight;
        emit EarlyCloseSet(day, secondsAfterMidnight);
    }

    function isOpen(uint256 ts) public view returns (bool) {
        uint256 offset = _dst(ts) ? 4 hours : 5 hours;
        if (ts < offset) return false;
        uint256 local = ts - offset;
        uint256 day = local / 1 days;
        uint256 weekday = (day + 4) % 7; // 0 = Sunday
        uint256 secs = local % 1 days;
        return weekday != 0 && weekday != 6 && !holidays[day] && secs >= OPEN_SECONDS && secs < _close(day);
    }

    function nextTransition(uint256 ts) external view returns (uint256) {
        uint256 day = ts / 1 days;
        for (uint256 i; i < 370; i++) {
            uint256 d = day + i;
            uint256 offset = _dst(d * 1 days + 12 hours) ? 4 hours : 5 hours;
            uint256 open = d * 1 days + OPEN_SECONDS + offset;
            uint256 close = d * 1 days + _close(d) + offset;
            if (open > ts && isOpen(open)) return open;
            if (close > ts && isOpen(close - 1)) return close;
        }
        revert NoTransitionWithinYear(ts);
    }

    function _close(uint256 day) private view returns (uint256) {
        uint256 e = earlyClose[day];
        return e == 0 ? CLOSE_SECONDS : e;
    }

    /// @dev US DST: second Sunday of March 02:00 EST (07:00 UTC) to first Sunday of November 02:00 EDT (06:00 UTC).
    function _dst(uint256 ts) private pure returns (bool) {
        uint256 y = _yearOf(ts / 1 days);
        uint256 march = _daysFromCivil(y, 3, 1);
        uint256 nov = _daysFromCivil(y, 11, 1);
        uint256 secondSunday = march + (7 - (march + 4) % 7) % 7 + 7;
        uint256 firstSunday = nov + (7 - (nov + 4) % 7) % 7;
        return ts >= secondSunday * 1 days + 7 hours && ts < firstSunday * 1 days + 6 hours;
    }

    /// @dev Gregorian year of a day number (days since 1970-01-01), Howard Hinnant's civil_from_days.
    function _yearOf(uint256 z) private pure returns (uint256) {
        z += 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        return yoe + era * 400 + (mp >= 10 ? 1 : 0);
    }

    /// @dev Day number of a Gregorian date (month 3..12 only, which is all _dst needs), days_from_civil.
    function _daysFromCivil(uint256 y, uint256 m, uint256 d) private pure returns (uint256) {
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 doy = (153 * (m - 3) + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }
}
