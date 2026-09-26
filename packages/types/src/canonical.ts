// Reference implementation of the CanonicalShares library and ParityHook/DarkCrossHook arithmetic (INTERFACES.md §1).
// Bit-for-bit mirror of the Solidity rounding rules; used by the API for display math and by `make types` to verify §10.
export const ONE = 10n ** 18n;
export const PIPS = 1_000_000n;
export const BASE_FEE_PIPS = 200n;
export const SKEW_FEE_PIPS = 1300n;
export const CLOSED_FEE_PIPS = 1000n;
export const MAX_FEE_PIPS = 2500n;
export const PEG_GUARD_BPS = 50n;
export const CROSS_FEE_PIPS = 500n;

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
  closedPips: bigint;
  totalPips: bigint;
  skewX18: bigint;
  marketOpen: boolean;
};

export function feeBreakdown(shares0: bigint, shares1: bigint, marketOpen: boolean): FeeBreakdown {
  const s = skewPips(shares0, shares1);
  const closed = marketOpen ? 0n : CLOSED_FEE_PIPS;
  const raw = BASE_FEE_PIPS + s + closed;
  return {
    basePips: BASE_FEE_PIPS,
    skewPips: s,
    closedPips: closed,
    totalPips: raw > MAX_FEE_PIPS ? MAX_FEE_PIPS : raw,
    skewX18: skewX18(shares0, shares1),
    marketOpen,
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
