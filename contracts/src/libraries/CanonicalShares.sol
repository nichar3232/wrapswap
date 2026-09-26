// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @title CanonicalShares
/// @notice Internal share accounting (INTERFACES.md §1.9). A canonical share is 1e18; it is never a token.
/// @dev Mirrored bit-for-bit by packages/types/src/canonical.ts. Every product goes through 512-bit FullMath.
library CanonicalShares {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant PIPS = 1e6;

    /// @dev Default Convert base fee (2 bps); ParityHook makes it owner-settable up to MAX_BASE_FEE_PIPS.
    uint24 internal constant DEFAULT_BASE_FEE_PIPS = 200;
    uint24 internal constant MAX_BASE_FEE_PIPS = 5000;
    /// @dev Skew fee: 15 bps per unit of |post-trade skew|, capped at 50 bps, only on |skew|-increasing trades.
    uint24 internal constant SKEW_FEE_PIPS = 1500;
    uint24 internal constant SKEW_FEE_CAP_PIPS = 5000;

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

    /// @dev ceil(feePips * |s0 - s1| / (s0 + s1)); 0 when both are 0.
    function skewPips(uint256 shares0, uint256 shares1, uint24 feePips) internal pure returns (uint24) {
        uint256 sum = shares0 + shares1;
        if (sum == 0) return 0;
        uint256 diff = shares0 >= shares1 ? shares0 - shares1 : shares1 - shares0;
        return uint24(FullMath.mulDivRoundingUp(diff, feePips, sum));
    }

    /// @dev true iff moving inventory shares from (shares0, shares1) to (post0, post1) strictly increases |skew|.
    ///      Exact: |post skew| > |skew| <=> ceil(postDiff * sum / postSum) > diff (diff is an integer), in 512 bits.
    ///      From an empty book (sum == 0) any imbalance is an increase.
    function increasesImbalance(uint256 shares0, uint256 shares1, uint256 post0, uint256 post1)
        internal
        pure
        returns (bool)
    {
        uint256 postSum = post0 + post1;
        uint256 postDiff = post0 >= post1 ? post0 - post1 : post1 - post0;
        if (postSum == 0 || postDiff == 0) return false;
        uint256 sum = shares0 + shares1;
        if (sum == 0) return true;
        uint256 diff = shares0 >= shares1 ? shares0 - shares1 : shares1 - shares0;
        return FullMath.mulDivRoundingUp(postDiff, sum, postSum) > diff;
    }

    /// @dev Skew fee for a trade: min(ceil(1500 * |post skew|), 5000) when it increases |skew|, else 0.
    function skewFeePips(uint256 shares0, uint256 shares1, uint256 post0, uint256 post1)
        internal
        pure
        returns (uint24)
    {
        if (!increasesImbalance(shares0, shares1, post0, post1)) return 0;
        return capSkewFee(skewPips(post0, post1, SKEW_FEE_PIPS));
    }

    function capSkewFee(uint24 pips) internal pure returns (uint24) {
        return pips > SKEW_FEE_CAP_PIPS ? SKEW_FEE_CAP_PIPS : pips;
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
