// Reference implementation of the CanonicalShares library and ParityHook/DarkCrossHook arithmetic (INTERFACES.md §1).
// Bit-for-bit mirror of the Solidity rounding rules; used by the API for display math and by `make types` to verify §10.
export const ONE = 10n ** 18n;
export const PIPS = 1_000_000n;
/** Default Convert base fee (2 bps); ParityHook.baseFeePips is owner-settable up to MAX_BASE_FEE_PIPS. */
export const BASE_FEE_PIPS = 200n;
export const MAX_BASE_FEE_PIPS = 5000n;
/** Skew fee: 15 bps per unit of |post-trade skew|, capped at 50 bps, only on trades that increase |skew|. */
export const SKEW_FEE_PIPS = 1500n;
export const SKEW_FEE_CAP_PIPS = 5000n;
export const PEG_GUARD_BPS = 50n;
export const CROSS_FEE_PIPS = 100n;

const pow10 = (d: number | bigint) => 10n ** BigInt(d);
export const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
export const mulDivUp = (a: bigint, b: bigint, d: bigint) => {
  const p = a * b;
  return p / d + (p % d === 0n ? 0n : 1n);
};
const abs = (x: bigint) => (x < 0n ? -x : x);

export const toSharesDown = (amount: bigint, spt: bigint, decimals: number) => mulDiv(amount, spt, pow10(decimals));
export const toSharesUp = (amount: bigint, spt: bigint, decimals: number) => mulDivUp(amount, spt, pow10(decimals));
export const fromSharesDown = (shares: bigint, spt: bigint, decimals: number) => mulDiv(shares, pow10(decimals), spt);
export const fromSharesUp = (shares: bigint, spt: bigint, decimals: number) => mulDivUp(shares, pow10(decimals), spt);
export const parityPriceX18 = (spt0: bigint, spt1: bigint) => mulDiv(spt0, ONE, spt1);

export function skewX18(shares0: bigint, shares1: bigint): bigint {
  const sum = shares0 + shares1;
  if (sum === 0n) return 0n;
  const diff = shares0 - shares1;
  const q = (abs(diff) * ONE) / sum;
  return diff < 0n ? -q : q;
}

export function skewPips(shares0: bigint, shares1: bigint, skewFeePips = SKEW_FEE_PIPS): bigint {
  const sum = shares0 + shares1;
  return sum === 0n ? 0n : mulDivUp(skewFeePips, abs(shares0 - shares1), sum);
}

export type FeeBreakdown = {
  basePips: bigint;
  skewPips: bigint;
  totalPips: bigint;
  /** Pre-trade skew, 1e18 signed. */
  skewX18: bigint;
  /** Post-trade skew (equals skewX18 in the trade-less view). */
  postSkewX18: bigint;
  /** true when the trade does not increase |skew| (skewPips = 0). */
  reducesImbalance: boolean;
};

/** CanonicalShares.increasesImbalance: |post skew| > |skew|, exact. */
export function increasesImbalance(shares0: bigint, shares1: bigint, post0: bigint, post1: bigint): boolean {
  const postSum = post0 + post1;
  const postDiff = abs(post0 - post1);
  if (postSum === 0n || postDiff === 0n) return false;
  const sum = shares0 + shares1;
  if (sum === 0n) return true;
  return mulDivUp(postDiff, sum, postSum) > abs(shares0 - shares1);
}

const capSkew = (pips: bigint) => (pips > SKEW_FEE_CAP_PIPS ? SKEW_FEE_CAP_PIPS : pips);

/** CanonicalShares.skewFeePips: min(ceil(1500 * |post skew|), 5000) if the trade increases |skew|, else 0. */
export const skewFeePips = (shares0: bigint, shares1: bigint, post0: bigint, post1: bigint) =>
  increasesImbalance(shares0, shares1, post0, post1) ? capSkew(skewPips(post0, post1, SKEW_FEE_PIPS)) : 0n;

/** CanonicalShares.postTradeShares: `shares` canonical shares move in on side 0 (zeroForOne) or side 1; out side floored at 0. */
export function postTradeShares(shares0: bigint, shares1: bigint, zeroForOne: boolean, shares: bigint): [bigint, bigint] {
  if (zeroForOne) return [shares0 + shares, shares1 > shares ? shares1 - shares : 0n];
  return [shares0 > shares ? shares0 - shares : 0n, shares1 + shares];
}

/**
 * IParityHook.feeBreakdown (trade-less view): the fee a marginal |skew|-increasing trade pays now,
 * base + min(ceil(1500 * |skew|), 5000).
 */
export function feeBreakdown(
  shares0: bigint,
  shares1: bigint,
  basePips: bigint = BASE_FEE_PIPS,
): FeeBreakdown {
  const skew = capSkew(skewPips(shares0, shares1, SKEW_FEE_PIPS));
  const s = skewX18(shares0, shares1);
  return { basePips, skewPips: skew, totalPips: basePips + skew, skewX18: s, postSkewX18: s, reducesImbalance: skew === 0n };
}

/**
 * Fee of an actual parity fill (IParityHook.quote / beforeSwap): base + skew fee at the post-trade skew, charged only
 * if the trade increases |skew|. `tradeShares` is fee-independent: input shares (exact input) or net output shares (exact output).
 */
export function tradeFeeBreakdown(
  shares0: bigint,
  shares1: bigint,
  zeroForOne: boolean,
  tradeShares: bigint,
  basePips: bigint = BASE_FEE_PIPS,
): FeeBreakdown {
  const [post0, post1] = postTradeShares(shares0, shares1, zeroForOne, tradeShares);
  const skew = skewFeePips(shares0, shares1, post0, post1);
  return {
    basePips,
    skewPips: skew,
    totalPips: basePips + skew,
    skewX18: skewX18(shares0, shares1),
    postSkewX18: skewX18(post0, post1),
    reducesImbalance: !increasesImbalance(shares0, shares1, post0, post1),
  };
}

export const feeOnGross = (grossOut: bigint, feePips: bigint) => mulDivUp(grossOut, feePips, PIPS);
export const grossForNet = (netOut: bigint, feePips: bigint) => mulDivUp(netOut, PIPS, PIPS - feePips);
/** "4.60" style rendering of a pip amount as basis points. */
export const pipsToBps = (pips: bigint | number) => {
  const p = BigInt(pips);
  return `${p / 100n}.${(p % 100n).toString().padStart(2, "0")}`;
};

export type Side = { spt: bigint; decimals: number };
export type ParityQuote = {
  amountIn: bigint;
  amountOut: bigint;
  grossOut: bigint;
  shares: bigint;
  feeAmount: bigint;
};

/** IParityHook.quote arithmetic; amountSpecified < 0 is exact input (pinned v4-core convention). */
export function parityQuote(tokenIn: Side, tokenOut: Side, amountSpecified: bigint, feePips: bigint): ParityQuote {
  if (amountSpecified < 0n) {
    const amountIn = -amountSpecified;
    const shares = toSharesDown(amountIn, tokenIn.spt, tokenIn.decimals);
    const grossOut = fromSharesDown(shares, tokenOut.spt, tokenOut.decimals);
    const feeAmount = feeOnGross(grossOut, feePips);
    return { amountIn, amountOut: grossOut - feeAmount, grossOut, shares, feeAmount };
  }
  const amountOut = amountSpecified;
  const grossOut = grossForNet(amountOut, feePips);
  const shares = toSharesUp(grossOut, tokenOut.spt, tokenOut.decimals);
  const amountIn = fromSharesUp(shares, tokenIn.spt, tokenIn.decimals);
  return { amountIn, amountOut, grossOut, shares, feeAmount: grossOut - amountOut };
}

export function poolPriceX18(sqrtPriceX96: bigint, dec0: number, dec1: number): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * pow10(dec0) * ONE) / ((1n << 192n) * pow10(dec1));
}

export const deviationBps = (priceX18: bigint, referenceX18: bigint) =>
  mulDivUp(abs(priceX18 - referenceX18), 10_000n, referenceX18);

/** Integer square root (floor). */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** sqrtPriceX96 for a raw price num/den (currency1 raw per currency0 raw): isqrt(floor(num * 2^192 / den)). */
export const sqrtPriceX96 = (num: bigint, den: bigint) => isqrt((num << 192n) / den);

// DarkCrossHook crossing (§1.8), whole quote per whole base, 1e18.
export const quoteAsBase = (quoteAmount: bigint, midX18: bigint, decBase: number, decQuote: number) =>
  (quoteAmount * ONE * pow10(decBase)) / (midX18 * pow10(decQuote));
export const baseAsQuote = (baseAmount: bigint, midX18: bigint, decBase: number, decQuote: number) =>
  (baseAmount * midX18 * pow10(decQuote)) / (ONE * pow10(decBase));
export const crossFee = (gross: bigint) => mulDivUp(gross, CROSS_FEE_PIPS, PIPS);
export const residualMinOut = (
  residualIn: bigint,
  limitX18: bigint,
  sellBase: boolean,
  decBase: number,
  decQuote: number,
) =>
  sellBase
    ? (residualIn * limitX18 * pow10(decQuote)) / (ONE * pow10(decBase))
    : (residualIn * ONE * pow10(decBase)) / (limitX18 * pow10(decQuote));
