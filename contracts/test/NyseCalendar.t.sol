// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {INyseCalendar} from "../src/interfaces/INyseCalendar.sol";
import {NyseCalendar} from "../src/NyseCalendar.sol";

contract NyseCalendarTest is Test {
    uint256 constant EDT = 4 hours;
    uint256 constant EST = 5 hours;
    uint256 constant OPEN = 34200; // 09:30
    uint256 constant CLOSE = 57600; // 16:00
    uint256 constant EARLY = 46800; // 13:00
    uint256 constant DAY_2026_01_01 = 20454;
    uint256 constant DAY_2026_09_29 = 20725; // Tuesday, EDT

    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");
    NyseCalendar cal;

    event HolidaySet(uint256 indexed day, bool closed);
    event EarlyCloseSet(uint256 indexed day, uint256 secondsAfterMidnight);

    function setUp() public {
        cal = new NyseCalendar(owner);
    }

    /// @dev UTC timestamp of `secs` after local midnight on ET day `day` at the given UTC offset.
    function _et(uint256 day, uint256 secs, uint256 offset) internal pure returns (uint256) {
        return day * 1 days + secs + offset;
    }

    function test_calendarKnownDates() public view {
        uint256 d = DAY_2026_09_29;
        assertEq(_et(d, 12 hours, EDT), 1790697600);
        assertTrue(cal.isOpen(_et(d, 12 hours, EDT)));
        assertFalse(cal.isOpen(_et(d, OPEN - 1, EDT))); // 09:29:59
        assertTrue(cal.isOpen(_et(d, OPEN, EDT))); // 09:30:00
        assertTrue(cal.isOpen(_et(d, CLOSE - 1, EDT))); // 15:59:59
        assertFalse(cal.isOpen(_et(d, CLOSE, EDT))); // 16:00:00
        assertEq(_et(d, OPEN, EDT), 1790688600);
        assertEq(_et(d, CLOSE, EDT), 1790712000);
        assertFalse(cal.isOpen(_et(d, 20 hours, EDT)));
        assertFalse(cal.isOpen(_et(d, 3 hours, EDT)));

        // Weekend: Sat 2026-09-26 and Sun 2026-09-27 midday.
        assertFalse(cal.isOpen(_et(d - 3, 12 hours, EDT)));
        assertFalse(cal.isOpen(_et(d - 2, 12 hours, EDT)));
        assertTrue(cal.isOpen(_et(d - 1, 12 hours, EDT))); // Monday
        assertTrue(cal.isOpen(_et(d - 4, 12 hours, EDT))); // Friday

        // All 20 2026-2027 holidays closed at 15:00 UTC (10:00/11:00 ET, mid-session on a normal day).
        uint16[20] memory hols = [
            20454, 20472, 20500, 20546, 20598, 20623, 20637, 20703, 20783, 20812,
            20819, 20836, 20864, 20903, 20969, 20987, 21004, 21067, 21147, 21176
        ];
        for (uint256 i; i < hols.length; i++) {
            uint256 day = hols[i];
            assertTrue(cal.holidays(day));
            uint256 wd = (day + 4) % 7;
            assertTrue(wd >= 1 && wd <= 5, "holiday on a weekday");
            assertFalse(cal.isOpen(day * 1 days + 15 hours));
        }
        // Days adjacent to holidays that are regular sessions stay open (e.g. Tue 2026-01-20, Mon 2026-07-06).
        assertTrue(cal.isOpen(uint256(20473) * 1 days + 15 hours));
        assertTrue(cal.isOpen(uint256(20640) * 1 days + 15 hours));
        assertFalse(cal.holidays(20455));
    }

    function test_dstBoundary() public view {
        // 2026-03-09 Monday (first weekday of EDT): 09:30 EDT = 13:30 UTC.
        assertEq(uint256(1773063000), uint256(20521) * 1 days + 13 hours + 30 minutes);
        assertTrue(cal.isOpen(1773063000));
        assertFalse(cal.isOpen(1773063000 - 1));
        assertTrue(cal.isOpen(uint256(20521) * 1 days + 19 hours + 59 minutes + 59));
        assertFalse(cal.isOpen(uint256(20521) * 1 days + 20 hours));

        // 2026-03-06 Friday (EST): 09:30 EST = 14:30 UTC; 14:29 closed; 13:30 closed.
        assertEq(uint256(1772807400), uint256(20518) * 1 days + 14 hours + 30 minutes);
        assertTrue(cal.isOpen(1772807400));
        assertFalse(cal.isOpen(1772807400 - 60));
        assertFalse(cal.isOpen(1772807400 - 1));
        assertFalse(cal.isOpen(uint256(20518) * 1 days + 13 hours + 30 minutes));
        assertTrue(cal.isOpen(uint256(20518) * 1 days + 20 hours + 59 minutes));
        assertFalse(cal.isOpen(uint256(20518) * 1 days + 21 hours));

        // 2026-11-02 Monday (first weekday of EST again): 14:30 UTC open, 14:29 closed.
        assertEq(uint256(1793629800), uint256(20759) * 1 days + 14 hours + 30 minutes);
        assertTrue(cal.isOpen(1793629800));
        assertFalse(cal.isOpen(1793629800 - 60));
        assertFalse(cal.isOpen(1793629800 - 1));
        // 2026-10-30 Friday still EDT: 13:30 UTC open.
        assertTrue(cal.isOpen(uint256(20756) * 1 days + 13 hours + 30 minutes));
        assertFalse(cal.isOpen(uint256(20756) * 1 days + 13 hours + 29 minutes));

        // nextTransition across the switch weekend lands on the correct UTC hour.
        assertEq(cal.nextTransition(uint256(20519) * 1 days + 12 hours), 1773063000); // Sat 2026-03-07 -> Mon EDT open
        assertEq(cal.nextTransition(uint256(20757) * 1 days + 12 hours), 1793629800); // Sat 2026-10-31 -> Mon EST open
    }

    function test_section10Timestamps() public view {
        assertTrue(cal.isOpen(1790692200)); // Tue 2026-09-29 10:30 EDT
        assertFalse(cal.isOpen(1790424000)); // Sat 2026-09-26 08:00 EDT
        assertEq(cal.nextTransition(1790424000), 1790602200); // Mon 2026-09-28 09:30 EDT
        // Inside the ANVIL session the next transition is that day's 16:00 close.
        assertEq(cal.nextTransition(1790692200), 1790712000);
        // Exactly at the open, the next flip is the close; exactly at the close, the next open.
        assertEq(cal.nextTransition(1790688600), 1790712000);
        assertEq(cal.nextTransition(1790712000), _et(DAY_2026_09_29 + 1, OPEN, EDT));
        // Strictly after: one second before the open returns the open.
        assertEq(cal.nextTransition(1790688600 - 1), 1790688600);
    }

    function test_earlyCloses() public view {
        uint16[3] memory early = [20784, 20811, 21148];
        uint256[3] memory closeTs = [uint256(1795802400), 1798135200, 1827252000];
        for (uint256 i; i < 3; i++) {
            uint256 day = early[i];
            assertEq(cal.earlyClose(day), EARLY);
            assertEq(_et(day, EARLY, EST), closeTs[i]);
            assertTrue(cal.isOpen(_et(day, OPEN, EST)));
            assertTrue(cal.isOpen(closeTs[i] - 1)); // 12:59:59 ET
            assertFalse(cal.isOpen(closeTs[i])); // 13:00:00 ET
            assertFalse(cal.isOpen(_et(day, 15 hours, EST)));
            assertEq(cal.nextTransition(_et(day, 10 hours, EST)), closeTs[i]);
            assertEq(cal.nextTransition(_et(day, OPEN, EST)), closeTs[i]);
        }
        // After the Fri 2026-11-27 early close the next transition is Mon 2026-11-30 09:30 EST.
        assertEq(cal.nextTransition(1795802400), _et(20787, OPEN, EST));
        // After Thu 2026-12-24 early close: Fri 25 is Christmas, weekend, so Mon 2026-12-28.
        assertEq(cal.nextTransition(1798135200), _et(20815, OPEN, EST));
    }

    function test_setEarlyCloseEventsAndErrors() public {
        uint256 day = DAY_2026_09_29;
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(INyseCalendar.InvalidEarlyClose.selector, 34200));
        cal.setEarlyClose(day, 34200);
        vm.expectRevert(abi.encodeWithSelector(INyseCalendar.InvalidEarlyClose.selector, 57601));
        cal.setEarlyClose(day, 57601);
        vm.expectRevert(abi.encodeWithSelector(INyseCalendar.InvalidEarlyClose.selector, 1));
        cal.setEarlyClose(day, 1);

        vm.expectEmit(true, false, false, true, address(cal));
        emit EarlyCloseSet(day, 43200);
        cal.setEarlyClose(day, 43200); // 12:00
        vm.stopPrank();
        assertEq(cal.earlyClose(day), 43200);
        assertTrue(cal.isOpen(_et(day, 43200 - 1, EDT)));
        assertFalse(cal.isOpen(_et(day, 43200, EDT)));
        assertEq(cal.nextTransition(_et(day, 10 hours, EDT)), _et(day, 43200, EDT));

        vm.startPrank(owner);
        cal.setEarlyClose(day, 34201); // boundary: valid
        assertEq(cal.earlyClose(day), 34201);
        cal.setEarlyClose(day, 57600); // boundary: valid (= normal close)
        assertEq(cal.earlyClose(day), 57600);

        vm.expectEmit(true, false, false, true, address(cal));
        emit EarlyCloseSet(day, 0);
        cal.setEarlyClose(day, 0);
        vm.stopPrank();
        assertEq(cal.earlyClose(day), 0);
        assertTrue(cal.isOpen(_et(day, CLOSE - 1, EDT)));
        assertFalse(cal.isOpen(_et(day, CLOSE, EDT)));

        // Clearing a built-in early close restores 16:00.
        vm.prank(owner);
        cal.setEarlyClose(20784, 0);
        assertTrue(cal.isOpen(_et(20784, 15 hours, EST)));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        cal.setEarlyClose(day, 43200);
    }

    function test_setHolidayEvent() public {
        uint256 day = DAY_2026_09_29;
        assertTrue(cal.isOpen(1790692200));
        vm.expectEmit(true, false, false, true, address(cal));
        emit HolidaySet(day, true);
        vm.prank(owner);
        cal.setHoliday(day, true);
        assertTrue(cal.holidays(day));
        assertFalse(cal.isOpen(1790692200));
        // Next open skips the new holiday.
        assertEq(cal.nextTransition(_et(day - 1, CLOSE, EDT)), _et(day + 1, OPEN, EDT));

        vm.expectEmit(true, false, false, true, address(cal));
        emit HolidaySet(day, false);
        vm.prank(owner);
        cal.setHoliday(day, false);
        assertTrue(cal.isOpen(1790692200));

        // Removing a built-in holiday reopens it.
        vm.prank(owner);
        cal.setHoliday(DAY_2026_01_01, false);
        assertTrue(cal.isOpen(DAY_2026_01_01 * 1 days + 15 hours));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        cal.setHoliday(day, true);
    }

    function test_nextTransitionErrorSelector() public {
        uint256 start = DAY_2026_01_01; // holiday, so ts below is closed
        uint256 ts = start * 1 days + 15 hours;
        vm.startPrank(owner);
        for (uint256 d = start; d <= start + 380; d++) {
            uint256 wd = (d + 4) % 7;
            if (wd != 0 && wd != 6) cal.setHoliday(d, true);
        }
        vm.stopPrank();
        assertFalse(cal.isOpen(ts));
        vm.expectRevert(abi.encodeWithSelector(INyseCalendar.NoTransitionWithinYear.selector, ts));
        cal.nextTransition(ts);

        // Reopening a single day far out restores a transition.
        vm.prank(owner);
        cal.setHoliday(start + 300, false);
        uint256 wd300 = (start + 300 + 4) % 7;
        if (wd300 != 0 && wd300 != 6) {
            uint256 next = cal.nextTransition(ts);
            assertTrue(cal.isOpen(next));
            assertEq((next - 4 hours) / 1 days, start + 300);
        }
    }
}
