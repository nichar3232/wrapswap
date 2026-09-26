import { canonical, type QuoteResponse } from "@wrapswap/types";

/**
 * The fee model (ParityHook, CanonicalShares): every Convert pays the base fee (2 bps) to the LP; a trade that
 * increases |inventory skew| also pays the skew fee min(ceil(1500 × |post-trade skew|), 5000) pips to the LP; a
 * trade that reduces it pays no skew fee. Nothing depends on the clock.
 */
export const pipsToBps = (pips: bigint | number) => Number(pips) / 100;
export const skewOf = (x18: string | bigint) => Number(BigInt(x18)) / 1e18;
/** Signed skew as a percent string, e.g. "−9.78%". */
export const skewPct = (x18: string | bigint) => {
  const v = skewOf(x18) * 100;
  return `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(2)}%`;
};

export type QuoteBreakdown = {
  sharesIn: bigint;
  sharesOut: bigint;
  baseFee: bigint;
  skewFee: bigint;
  /** Fraction of the input shares kept, 0…1 (e.g. 0.999637). */
  keep: number;
  reducesImbalance: boolean;
  preSkewX18: bigint;
  postSkewX18: bigint;
};

/**
 * What a quote means in shares. Reads the API's own split (sharesIn, sharesOut, baseFee, skewFee, youKeep: the
 * figures from ParityHook.quote()); an older API without them gets the same split from the shared formula.
 */
export function quoteBreakdown(q: QuoteResponse, tokenOut: { sharesPerTokenX18: string; decimals: number }): QuoteBreakdown {
  const sharesIn = BigInt(q.sharesIn ?? q.shares);
  const sharesOut = q.sharesOut
    ? BigInt(q.sharesOut)
    : canonical.toSharesDown(BigInt(q.amountOut), BigInt(tokenOut.sharesPerTokenX18), tokenOut.decimals);
  let baseFee: bigint, skewFee: bigint;
  if (q.baseFee !== undefined && q.skewFee !== undefined) {
    baseFee = BigInt(q.baseFee);
    skewFee = BigInt(q.skewFee);
  } else {
    const fee = sharesIn - sharesOut,
      total = BigInt(q.fee.totalPips);
    baseFee = total ? (fee * BigInt(q.fee.basePips)) / total : 0n;
    skewFee = fee - baseFee;
  }
  const keep = q.youKeep !== undefined ? Number(q.youKeep) : sharesIn ? Number((sharesOut * 1_000_000n) / sharesIn) / 1e6 : 0;
  return {
    sharesIn,
    sharesOut,
    baseFee,
    skewFee,
    keep,
    reducesImbalance: q.reducesImbalance ?? q.fee.reducesImbalance,
    preSkewX18: BigInt(q.preSkewX18 ?? q.fee.skewX18),
    postSkewX18: BigInt(q.postSkewX18 ?? q.fee.postSkewX18),
  };
}

/**
 * True when the inventory gap is larger than every indexed Convert together could have opened: each conversion pays
 * the base fee on its input, so volume = baseShares × 1e6 / basePips, and a conversion of v shares widens
 * |L − R| by at most 2v. A larger gap was set by the pool keeper (depositInventory / withdrawInventory).
 */
export function keeperSetInventory(p: {
  wrappers: { inventoryShares: string }[];
  directions: { totalPips: number; skewFeePips: number }[];
  lpFees: { baseShares: string };
}): boolean {
  const [l, r] = p.wrappers.map((x) => BigInt(x.inventoryShares));
  if (l === undefined || r === undefined) return false;
  const gap = l > r ? l - r : r - l;
  const basePips = Math.min(...p.directions.map((x) => x.totalPips - x.skewFeePips));
  if (!(basePips > 0)) return false;
  const volume = (BigInt(p.lpFees.baseShares) * 1_000_000n) / BigInt(basePips);
  return gap > 2n * volume;
}
