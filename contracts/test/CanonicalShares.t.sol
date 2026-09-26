// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CanonicalShares} from "../src/libraries/CanonicalShares.sol";

/// @notice External wrapper so library reverts surface as call reverts.
contract CanonicalSharesHarness {
    function toSharesDown(uint256 a, uint256 spt, uint8 d) external pure returns (uint256) {
        return CanonicalShares.toSharesDown(a, spt, d);
    }

    function toSharesUp(uint256 a, uint256 spt, uint8 d) external pure returns (uint256) {
        return CanonicalShares.toSharesUp(a, spt, d);
    }

    function fromSharesDown(uint256 s, uint256 spt, uint8 d) external pure returns (uint256) {
        return CanonicalShares.fromSharesDown(s, spt, d);
    }

    function fromSharesUp(uint256 s, uint256 spt, uint8 d) external pure returns (uint256) {
        return CanonicalShares.fromSharesUp(s, spt, d);
    }

    function parityPriceX18(uint256 a, uint256 b) external pure returns (uint256) {
        return CanonicalShares.parityPriceX18(a, b);
    }

    function skewX18(uint256 a, uint256 b) external pure returns (int256) {
        return CanonicalShares.skewX18(a, b);
    }

    function skewPips(uint256 a, uint256 b, uint24 f) external pure returns (uint24) {
        return CanonicalShares.skewPips(a, b, f);
    }

    function totalFeePips(uint256 a, uint256 b, uint256 p0, uint256 p1, bool open) external pure returns (uint24) {
        return CanonicalShares.totalFeePips(a, b, p0, p1, open);
    }

    function offHoursPips(uint256 a, uint256 b, uint256 p0, uint256 p1) external pure returns (uint24) {
        return CanonicalShares.offHoursPips(a, b, p0, p1);
    }

    function marginalOffHoursPips(uint256 a, uint256 b) external pure returns (uint24) {
        return CanonicalShares.marginalOffHoursPips(a, b);
    }

    function postTradeShares(uint256 a, uint256 b, bool zeroForOne, uint256 shares)
        external
        pure
        returns (uint256, uint256)
    {
        return CanonicalShares.postTradeShares(a, b, zeroForOne, shares);
    }

    function feeOnGross(uint256 g, uint24 p) external pure returns (uint256) {
        return CanonicalShares.feeOnGross(g, p);
    }

    function grossForNet(uint256 n, uint24 p) external pure returns (uint256) {
        return CanonicalShares.grossForNet(n, p);
    }

    function poolPriceX18(uint160 s, uint8 d0, uint8 d1) external pure returns (uint256) {
        return CanonicalShares.poolPriceX18(s, d0, d1);
    }

    function deviationBps(uint256 p, uint256 r) external pure returns (uint256) {
        return CanonicalShares.deviationBps(p, r);
    }
}

contract CanonicalSharesTest is Test {
    CanonicalSharesHarness h;

    uint160 constant SQRT_MCB_C0 = 79721800701433069633245772272326702;
    uint160 constant SQRT_MAAPLX_C0 = 78737580939686982353822;

    function setUp() public {
        h = new CanonicalSharesHarness();
    }

    function test_section19Vectors() public view {
        // Share conversions (§10 fill: 100 mcbAAPL (6 dec) at spt 1.0125).
        assertEq(h.toSharesDown(100000000, 1.0125e18, 6), 101.25e18);
        assertEq(h.toSharesUp(100000000, 1.0125e18, 6), 101.25e18);
        assertEq(h.fromSharesDown(101.25e18, 1e18, 18), 101.25e18);
        assertEq(h.fromSharesUp(101.25e18, 1e18, 18), 101.25e18);
        assertEq(h.fromSharesDown(101.25e18, 1.0125e18, 6), 100000000);
        // Residual: 10 mcbAAPL.
        assertEq(h.toSharesDown(10000000, 1.0125e18, 6), 10.125e18);
        // Parity.
        assertEq(h.parityPriceX18(1.0125e18, 1e18), 1.0125e18);
        assertEq(h.parityPriceX18(1e18, 1.0125e18), 987654320987654320);
        // Skew: inventory 8000 mcbAAPL -> 8100 shares vs 12150 shares.
        assertEq(h.skewX18(8100e18, 12150e18), -0.2e18);
        assertEq(h.skewX18(12150e18, 8100e18), 0.2e18);
        assertEq(h.skewX18(0, 0), 0);
        assertEq(h.skewPips(8100e18, 12150e18, 1300), 260);
        assertEq(h.skewPips(0, 0, 1300), 0);
        // Fees. The §10 parity fill (101.25 shares of mcbAAPL in) reduces |skew| 0.20 -> 0.19: no off-hours premium.
        assertEq(h.totalFeePips(8100e18, 12150e18, 8201.25e18, 12048.75e18, true), 460);
        assertEq(h.totalFeePips(8100e18, 12150e18, 8201.25e18, 12048.75e18, false), 460);
        // The same size the other way increases |skew| to 0.21: + ceil(1500 * 0.21) = 315 pips off-hours.
        assertEq(h.totalFeePips(8100e18, 12150e18, 7998.75e18, 12251.25e18, true), 460);
        assertEq(h.totalFeePips(8100e18, 12150e18, 7998.75e18, 12251.25e18, false), 775);
        assertEq(h.marginalOffHoursPips(8100e18, 12150e18), 300);
        assertEq(h.totalFeePips(0, 0, 0, 0, true), 200);
        assertEq(h.feeOnGross(101.25e18, 460), 46575000000000000);
        assertEq(h.feeOnGross(101.25e18, 775), 78468750000000000);
        assertEq(h.grossForNet(101.25e18 - 46575000000000000, 460), 101.25e18);
        assertEq(h.grossForNet(0, 460), 0);
        // Pool price: exact floor (reference computed with arbitrary precision) and within 1 bps of parity.
        uint256 p = h.poolPriceX18(SQRT_MCB_C0, 6, 18);
        assertEq(p, 1012499999999999999);
        assertEq(p, _refPoolPrice(SQRT_MCB_C0, 6, 18));
        assertLe(h.deviationBps(p, 1.0125e18), 1);
        assertEq(h.deviationBps(p, 1.0125e18), 1); // ceil of a 1-wei deviation
        assertEq(h.poolPriceX18(SQRT_MAAPLX_C0, 18, 6), 987654320987654320);
        // Deviation.
        assertEq(h.deviationBps(1.0125e18, 1.0125e18), 0);
        assertEq(h.deviationBps(1.005e18, 1e18), 50);
        assertEq(h.deviationBps(0.995e18, 1e18), 50);
        assertEq(h.deviationBps(1.005e18 + 1, 1e18), 51);
    }

    function testFuzz_downLeUp(uint256 amount, uint256 spt, uint8 dec) public view {
        amount = bound(amount, 0, 1e36);
        spt = bound(spt, 1, 1e24);
        dec = uint8(bound(dec, 0, 18));
        uint256 down = h.toSharesDown(amount, spt, dec);
        uint256 up = h.toSharesUp(amount, spt, dec);
        assertLe(down, up);
        assertLe(up - down, 1);
        assertEq(up == down, mulmod(amount, spt, 10 ** dec) == 0);

        uint256 fd = h.fromSharesDown(amount, spt, dec);
        uint256 fu = h.fromSharesUp(amount, spt, dec);
        assertLe(fd, fu);
        assertLe(fu - fd, 1);
        assertEq(fu == fd, mulmod(amount, 10 ** dec, spt) == 0);
    }

    function testFuzz_roundTripNeverGainsShares(uint256 amount, uint256 shares, uint256 spt, uint8 dec) public view {
        amount = bound(amount, 0, 1e36);
        shares = bound(shares, 0, 1e36);
        spt = bound(spt, 1, 1e24);
        dec = uint8(bound(dec, 0, 18));

        // Exact-in: amount -> shares -> tokens -> shares never grows.
        uint256 s0 = h.toSharesDown(amount, spt, dec);
        uint256 tokens = h.fromSharesDown(s0, spt, dec);
        assertLe(tokens, amount);
        uint256 s1 = h.toSharesDown(tokens, spt, dec);
        assertLe(s1, s0);

        // Exact-out: tokens required for `shares` (rounded up) always cover them.
        uint256 input = h.fromSharesUp(shares, spt, dec);
        assertGe(h.toSharesDown(input, spt, dec), shares);
        // Shares required to pay `amount` out (rounded up) always cover the amount.
        uint256 sharesIn = h.toSharesUp(amount, spt, dec);
        assertGe(h.fromSharesDown(sharesIn, spt, dec), amount);
    }

    function testFuzz_feeOnGrossCeil(uint256 gross, uint24 pips) public view {
        gross = bound(gross, 0, type(uint128).max);
        pips = uint24(bound(pips, 0, 1e6));
        uint256 fee = h.feeOnGross(gross, pips);
        assertGe(fee * 1e6, gross * pips);
        if (fee > 0) assertLt((fee - 1) * 1e6, gross * pips);
        assertLe(fee, gross);
    }

    /// @dev True property: gross = grossForNet(net) is the SMALLEST gross whose fee-on-gross payout covers net.
    ///      gross - feeOnGross(gross) = floor(gross * (1e6 - p) / 1e6) >= net, and gross - 1 would under-deliver.
    function testFuzz_grossForNetInverse(uint256 net, uint24 pips) public view {
        net = bound(net, 0, type(uint128).max);
        pips = uint24(bound(pips, 0, 999999));
        uint256 gross = h.grossForNet(net, pips);
        assertGe(gross, net);
        assertGe(gross - h.feeOnGross(gross, pips), net);
        if (gross > 0) {
            uint256 g1 = gross - 1;
            assertLt(g1 - h.feeOnGross(g1, pips), net);
        }
    }

    function testFuzz_skewPipsCeilAndCap(uint256 s0, uint256 s1, uint24 fee) public view {
        s0 = bound(s0, 0, type(uint128).max);
        s1 = bound(s1, 0, type(uint128).max);
        uint24 p = h.skewPips(s0, s1, fee);
        assertLe(p, fee);
        uint256 sum = s0 + s1;
        uint256 diff = s0 >= s1 ? s0 - s1 : s1 - s0;
        if (sum == 0) {
            assertEq(p, 0);
            return;
        }
        assertGe(uint256(p) * sum, diff * fee);
        if (p > 0) assertLt(uint256(p - 1) * sum, diff * fee);
        // Symmetric in its arguments.
        assertEq(h.skewPips(s1, s0, fee), p);
        // skewX18 magnitude truncates.
        int256 sk = h.skewX18(s0, s1);
        uint256 mag = sk >= 0 ? uint256(sk) : uint256(-sk);
        assertLe(mag * sum, diff * 1e18);
        assertGt((mag + 1) * sum, diff * 1e18);
        if (mag != 0) assertEq(sk > 0, s0 > s1);
    }

    function testFuzz_poolPriceX18MatchesReference(uint160 s, uint8 dec0, uint8 dec1) public view {
        s = uint160(bound(uint256(s), TickMath.MIN_SQRT_PRICE, type(uint160).max));
        dec0 = uint8(bound(dec0, 0, 18));
        dec1 = uint8(bound(dec1, 0, 18));
        assertEq(h.poolPriceX18(s, dec0, dec1), _refPoolPrice(s, dec0, dec1));
    }

    function test_poolPriceX18Extremes() public view {
        uint8[3] memory ds = [uint8(0), 6, 18];
        for (uint256 i; i < 3; i++) {
            for (uint256 j; j < 3; j++) {
                assertEq(h.poolPriceX18(type(uint160).max, ds[i], ds[j]), _refPoolPrice(type(uint160).max, ds[i], ds[j]));
                assertEq(
                    h.poolPriceX18(TickMath.MAX_SQRT_PRICE, ds[i], ds[j]),
                    _refPoolPrice(TickMath.MAX_SQRT_PRICE, ds[i], ds[j])
                );
                assertEq(
                    h.poolPriceX18(TickMath.MIN_SQRT_PRICE, ds[i], ds[j]),
                    _refPoolPrice(TickMath.MIN_SQRT_PRICE, ds[i], ds[j])
                );
            }
        }
        // 2^96 is price 1: equal decimals give exactly 1e18.
        assertEq(h.poolPriceX18(uint160(1 << 96), 18, 18), 1e18);
        assertEq(h.poolPriceX18(uint160(1 << 96), 6, 18), 1e6);
    }

    function testFuzz_deviationBpsCeil(uint256 price, uint256 ref) public view {
        price = bound(price, 0, type(uint128).max);
        ref = bound(ref, 1, type(uint128).max);
        uint256 d = h.deviationBps(price, ref);
        uint256 diff = price >= ref ? price - ref : ref - price;
        assertGe(d * ref, diff * 1e4);
        if (d > 0) assertLt((d - 1) * ref, diff * 1e4);
        assertEq(d == 0, price == ref);
    }

    function test_deviationBpsZeroReferenceReverts() public {
        vm.expectRevert();
        h.deviationBps(1, 0);
    }

    function test_totalFeeCappedAt2500() public view {
        // |skew| 0.90 -> 0.95 off-hours: 200 + 1170 + 1425 = 2795, capped.
        assertEq(h.totalFeePips(950e18, 50e18, 975e18, 25e18, false), 2500);
        assertEq(h.totalFeePips(950e18, 50e18, 975e18, 25e18, true), 1370);
        // Fully one-sided: |skew| cannot grow, so off-hours adds nothing; base + skew = 1500.
        assertEq(h.totalFeePips(1e18, 0, 2e18, 0, false), 1500);
        assertEq(h.totalFeePips(type(uint128).max, 0, type(uint128).max, 0, false), 1500);
        // From an empty book any fill is maximally skewing.
        assertEq(h.offHoursPips(0, 0, 1e18, 0), 1500);
    }

    function test_offHoursBalancedPoolIsNearBase() public view {
        // 100 shares into a balanced 10k/10k book: |post skew| = 0.01 -> ceil(15) pips; total 2.15 bps.
        assertEq(h.offHoursPips(10000e18, 10000e18, 10100e18, 9900e18), 15);
        assertEq(h.totalFeePips(10000e18, 10000e18, 10100e18, 9900e18, false), 215);
        assertEq(h.totalFeePips(10000e18, 10000e18, 10100e18, 9900e18, true), 200);
        assertEq(h.marginalOffHoursPips(10000e18, 10000e18), 0);
    }

    function test_offHoursImbalanceIncreasing() public view {
        // |skew| 0.10 -> 0.12 (share-for-share move of 200 out of 20k): premium ceil(1500 * 0.12) = 180.
        assertEq(h.offHoursPips(11000e18, 9000e18, 11200e18, 8800e18), 180);
        assertEq(h.totalFeePips(11000e18, 9000e18, 11200e18, 8800e18, false), 200 + 130 + 180);
        // Mirror orientation pays the same.
        assertEq(h.totalFeePips(9000e18, 11000e18, 8800e18, 11200e18, false), 510);
    }

    function test_offHoursRebalancingPaysNothing() public view {
        // |skew| 0.10 -> 0.08, and a trade that crosses through balance to a smaller |skew| (0.10 -> 0.05).
        assertEq(h.offHoursPips(11000e18, 9000e18, 10800e18, 9200e18), 0);
        assertEq(h.offHoursPips(11000e18, 9000e18, 9500e18, 10500e18), 0);
        assertEq(h.totalFeePips(11000e18, 9000e18, 10800e18, 9200e18, false), 330);
        // Crossing to an equal |skew| on the other side is not an increase; beyond it is.
        assertEq(h.offHoursPips(11000e18, 9000e18, 9000e18, 11000e18), 0);
        assertEq(h.offHoursPips(11000e18, 9000e18, 8999e18, 11001e18), 151);
    }

    function test_marketOpenUnchanged() public view {
        // Open market: base + pre-trade skew only, whatever the trade does.
        assertEq(h.totalFeePips(8100e18, 12150e18, 7998.75e18, 12251.25e18, true), 460);
        assertEq(h.totalFeePips(1e18, 0, 1e18, 0, true), 1500);
        assertEq(h.totalFeePips(1, 1, 2, 0, true), 200);
    }

    function test_postTradeShares() public view {
        (uint256 a, uint256 b) = h.postTradeShares(100, 50, true, 30);
        assertEq(a, 130);
        assertEq(b, 20);
        (a, b) = h.postTradeShares(100, 50, false, 30);
        assertEq(a, 70);
        assertEq(b, 80);
        (a, b) = h.postTradeShares(100, 50, true, 80); // out side floored at 0
        assertEq(a, 180);
        assertEq(b, 0);
    }

    function testFuzz_totalFeeBounds(uint256 s0, uint256 s1, uint256 size, bool zeroForOne, bool open) public view {
        s0 = bound(s0, 0, 1 << 120);
        s1 = bound(s1, 0, 1 << 120);
        size = bound(size, 0, 1 << 120);
        (uint256 p0, uint256 p1) = h.postTradeShares(s0, s1, zeroForOne, size);
        uint24 off = h.offHoursPips(s0, s1, p0, p1);
        uint24 t = h.totalFeePips(s0, s1, p0, p1, open);
        assertLe(off, 1500);
        assertLe(t, 2500);
        assertGe(t, 200);
        uint256 raw = 200 + uint256(h.skewPips(s0, s1, 1300)) + (open ? 0 : off);
        assertEq(t, raw > 2500 ? 2500 : raw);
        // A premium is only ever charged when |skew| strictly grows (cross-multiplied, exact).
        uint256 d = s0 > s1 ? s0 - s1 : s1 - s0;
        uint256 pd = p0 > p1 ? p0 - p1 : p1 - p0;
        if (off > 0 && s0 + s1 > 0) assertGt(pd * (s0 + s1), d * (p0 + p1));
        if (pd * (s0 + s1) <= d * (p0 + p1) && s0 + s1 > 0) assertEq(off, 0);
    }

    // ---------------------------------------------------------------- reference

    /// @dev floor(s^2 * 10^dec0 * 1e18 / (2^192 * 10^dec1)) via explicit 512-bit arithmetic:
    ///      floor(floor(s^2 * K / 2^192) / 10^dec1) with s^2 * K held as (hi, lo).
    function _refPoolPrice(uint160 sqrtP, uint8 dec0, uint8 dec1) internal pure returns (uint256) {
        uint256 s = uint256(sqrtP);
        uint256 k = 10 ** uint256(dec0) * 1e18;
        (uint256 sqHi, uint256 sqLo) = _mul512(s, s); // sqHi < 2^64
        (uint256 h1, uint256 l1) = _mul512(sqLo, k);
        uint256 hi = sqHi * k + h1; // < 2^184, no overflow
        uint256 lo = l1;
        uint256 shifted = (hi << 64) | (lo >> 192); // (hi,lo) >> 192; hi < 2^184 so fits
        return shifted / 10 ** uint256(dec1);
    }

    function _mul512(uint256 a, uint256 b) internal pure returns (uint256 hi, uint256 lo) {
        unchecked {
            lo = a * b;
            uint256 mm = mulmod(a, b, type(uint256).max);
            hi = mm - lo - (mm < lo ? 1 : 0);
        }
    }
}
