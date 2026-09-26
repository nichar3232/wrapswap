// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @title CanonicalShares
/// @notice Internal share accounting (INTERFACES.md §1.9). A canonical share is 1e18; it is never a token.
/// @dev Mirrored bit-for-bit by packages/types/src/canonical.ts. Every product goes through 512-bit FullMath.
library CanonicalShares {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant PIPS = 1e6;

    uint24 internal constant BASE_FEE_PIPS = 200;
    uint24 internal constant SKEW_FEE_PIPS = 1300;
    /// @dev Off-hours rebalancing-lag premium at |skew| = 1 (15 bps). A same-share swap carries no underlying price risk;
    ///      off-hours the issuers cannot mint/redeem until the open, so the risk is inventory skew that cannot be
    ///      rebalanced, charged only to trades that increase it.
    uint24 internal constant OFF_HOURS_MAX_FEE_PIPS = 1500;
    uint24 internal constant MAX_FEE_PIPS = 2500;

    /// @dev floor(amount * spt / 10**dec)
    function toSharesDown(uint256 amount, uint256 sharesPerToken, uint8 decimals) internal pure returns (uint256) {
        return FullMath.mulDiv(amount, sharesPerToken, 10 ** decimals);
    }

    /// @dev ceil(amount * spt / 10**dec)
    function toSharesUp(uint256 amount, uint256 sharesPerToken, uint8 decimals) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(amount, sharesPerToken, 10 ** decimals);
    }

    /// @dev floor(shares * 10**dec / spt)
    function fromSharesDown(uint256 shares, uint256 sharesPerToken, uint8 decimals) internal pure returns (uint256) {
        return FullMath.mulDiv(shares, 10 ** decimals, sharesPerToken);
    }

    /// @dev ceil(shares * 10**dec / spt)
    function fromSharesUp(uint256 shares, uint256 sharesPerToken, uint8 decimals) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(shares, 10 ** decimals, sharesPerToken);
    }

    /// @dev floor(spt0 * 1e18 / spt1): whole token1 per whole token0.
    function parityPriceX18(uint256 spt0, uint256 spt1) internal pure returns (uint256) {
        return FullMath.mulDiv(spt0, ONE, spt1);
    }

    /// @dev (s0 - s1) * 1e18 / (s0 + s1), truncated toward zero; 0 when both are 0.
    function skewX18(uint256 shares0, uint256 shares1) internal pure returns (int256) {
        uint256 sum = shares0 + shares1;
        if (sum == 0) return 0;
        if (shares0 >= shares1) return int256(FullMath.mulDiv(shares0 - shares1, ONE, sum));
        return -int256(FullMath.mulDiv(shares1 - shares0, ONE, sum));
    }

    /// @dev ceil(skewFeePips * |s0 - s1| / (s0 + s1)); 0 when both are 0.
    function skewPips(uint256 shares0, uint256 shares1, uint24 skewFeePips) internal pure returns (uint24) {
        uint256 sum = shares0 + shares1;
        if (sum == 0) return 0;
        uint256 diff = shares0 >= shares1 ? shares0 - shares1 : shares1 - shares0;
        return uint24(FullMath.mulDivRoundingUp(diff, skewFeePips, sum));
    }

    /// @dev Off-hours premium for a trade moving inventory shares from (shares0, shares1) to (post0, post1):
    ///      ceil(1500 * |post0 - post1| / (post0 + post1)) when the trade increases |skew|, else 0.
    ///      |skew| comparison is exact (cross-multiplied), so an unchanged or reduced |skew| pays nothing.
    function offHoursPips(uint256 shares0, uint256 shares1, uint256 post0, uint256 post1)
        internal
        pure
        returns (uint24)
    {
        uint256 sum = shares0 + shares1;
        uint256 postSum = post0 + post1;
        if (postSum == 0) return 0;
        uint256 diff = shares0 >= shares1 ? shares0 - shares1 : shares1 - shares0;
        uint256 postDiff = post0 >= post1 ? post0 - post1 : post1 - post0;
        if (postDiff == 0) return 0;
        // |post skew| > |skew|  <=>  postDiff * sum / postSum > diff  <=>  ceil(postDiff * sum / postSum) > diff
        // (diff is an integer), evaluated in 512 bits. From an empty book (sum == 0) any imbalance is an increase.
        if (sum != 0 && FullMath.mulDivRoundingUp(postDiff, sum, postSum) <= diff) return 0;
        return uint24(FullMath.mulDivRoundingUp(postDiff, OFF_HOURS_MAX_FEE_PIPS, postSum));
    }

    /// @dev Premium a marginal skew-increasing trade pays now: ceil(1500 * |shares0 - shares1| / (shares0 + shares1)).
    ///      0 when balanced. Used by the trade-less feeBreakdown(key) view.
    function marginalOffHoursPips(uint256 shares0, uint256 shares1) internal pure returns (uint24) {
        return skewPips(shares0, shares1, OFF_HOURS_MAX_FEE_PIPS);
    }

    /// @dev Inventory shares after a parity fill of `shares` canonical shares (zeroForOne: side 0 in, side 1 out).
    ///      The out side is floored at 0 (an unfillable trade falls through; its fee is still well defined).
    function postTradeShares(uint256 shares0, uint256 shares1, bool zeroForOne, uint256 shares)
        internal
        pure
        returns (uint256 post0, uint256 post1)
    {
        if (zeroForOne) return (shares0 + shares, shares1 > shares ? shares1 - shares : 0);
        return (shares0 > shares ? shares0 - shares : 0, shares1 + shares);
    }

    /// @dev min(200 + skewPips(pre) + (open ? 0 : offHoursPips(pre, post)), 2500)
    function totalFeePips(uint256 shares0, uint256 shares1, uint256 post0, uint256 post1, bool marketOpen)
        internal
        pure
        returns (uint24)
    {
        uint256 total = uint256(BASE_FEE_PIPS) + skewPips(shares0, shares1, SKEW_FEE_PIPS)
            + (marketOpen ? 0 : uint256(offHoursPips(shares0, shares1, post0, post1)));
        return total > MAX_FEE_PIPS ? MAX_FEE_PIPS : uint24(total);
    }

    /// @dev ceil(gross * pips / 1e6)
    function feeOnGross(uint256 grossOut, uint24 feePips) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(grossOut, feePips, PIPS);
    }

    /// @dev ceil(net * 1e6 / (1e6 - pips))
    function grossForNet(uint256 netOut, uint24 feePips) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(netOut, PIPS, PIPS - feePips);
    }

    /// @dev floor(s^2 * 10^dec0 * 1e18 / (2^192 * 10^dec1)), exact for every uint160 s and dec <= 18.
    ///      With D = 2^192 * 10^dec1 and K = 10^dec0 * 1e18: s^2 = A*D + R, so the result is A*K + floor(R*K/D).
    function poolPriceX18(uint160 sqrtPriceX96, uint8 dec0, uint8 dec1) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        uint256 d = (uint256(1) << 192) * 10 ** dec1;
        uint256 k = 10 ** dec0 * ONE;
        uint256 a = FullMath.mulDiv(s, s, d);
        uint256 r = mulmod(s, s, d);
        return a * k + FullMath.mulDiv(r, k, d);
    }

    /// @dev ceil(|price - reference| * 1e4 / reference)
    function deviationBps(uint256 priceX18, uint256 referenceX18) internal pure returns (uint256) {
        uint256 diff = priceX18 >= referenceX18 ? priceX18 - referenceX18 : referenceX18 - priceX18;
        return FullMath.mulDivRoundingUp(diff, 1e4, referenceX18);
    }
}
