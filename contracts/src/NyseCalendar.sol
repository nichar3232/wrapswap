// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Regular sessions only; exchange early-close sessions can be configured through setEarlyClose.
contract NyseCalendar is Ownable {
    mapping(uint256 => bool) public holidays;
    mapping(uint256 => uint256) public earlyClose;
    event HolidaySet(uint256 day, bool closed);

    constructor(address o) Ownable(o) {
        holidays[20454] = true;
        holidays[20472] = true;
        holidays[20500] = true;
        holidays[20546] = true;
        holidays[20598] = true;
        holidays[20623] = true;
        holidays[20637] = true;
        holidays[20703] = true;
        holidays[20783] = true;
        holidays[20812] = true;
        holidays[20819] = true;
        holidays[20836] = true;
        holidays[20864] = true;
        holidays[20903] = true;
        holidays[20969] = true;
        holidays[20987] = true;
        holidays[21004] = true;
        holidays[21067] = true;
        holidays[21147] = true;
        holidays[21176] = true;
    }

    function setHoliday(uint256 day, bool closed) external onlyOwner {
        holidays[day] = closed;
        emit HolidaySet(day, closed);
    }

    function setEarlyClose(uint256 day, uint256 secondsAfterMidnight) external onlyOwner {
        require(secondsAfterMidnight >= 34200 && secondsAfterMidnight <= 57600);
        earlyClose[day] = secondsAfterMidnight;
    }

    function isOpen(uint256 ts) public view returns (bool) {
        uint256 offset = _dst(ts) ? 4 hours : 5 hours;
        if (ts < offset) return false;
        uint256 local = ts - offset;
        uint256 day = local / 1 days;
        uint256 weekday = (day + 4) % 7;
        uint256 close = earlyClose[day] == 0 ? 57600 : earlyClose[day];
        return weekday != 0 && weekday != 6 && !holidays[day] && local % 1 days >= 34200 && local % 1 days < close;
    }

    function nextTransition(uint256 ts) external view returns (uint256) {
        uint256 day = ts / 1 days;
        for (uint256 i; i < 370; i++) {
            uint256 d = day + i;
            uint256 offset = _dst(d * 1 days + 12 hours) ? 4 hours : 5 hours;
            uint256 open = d * 1 days + 34200 + offset;
            uint256 close = d * 1 days + (earlyClose[d] == 0 ? 57600 : earlyClose[d]) + offset;
            if (open > ts && isOpen(open)) return open;
            if (close > ts && isOpen(close - 1)) return close;
        }
        revert("no transition within year");
    }

    function _dst(uint256 ts) private pure returns (bool) {
        uint256 y = 1970;
        uint256 d = ts / 1 days;
        while (d >= (_leap(y) ? 366 : 365)) {
            d -= (_leap(y) ? 366 : 365);
            y++;
        }
        uint256 jan = ts / 1 days - d;
        uint256 march = jan + 31 + (_leap(y) ? 29 : 28);
        uint256 nov = march + 245;
        uint256 secondSunday = march + (7 - (march + 4) % 7) % 7 + 7;
        uint256 firstSunday = nov + (7 - (nov + 4) % 7) % 7;
        return ts >= secondSunday * 1 days + 7 hours && ts < firstSunday * 1 days + 6 hours;
    }

    function _leap(uint256 y) private pure returns (bool) {
        return y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    }
}
