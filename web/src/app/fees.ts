import { canonical } from "@wrapswap/types";

/**
 * The single place the UI prices a conversion. Everything (quote notes, Pool hero, fee curve, demo data) goes
 * through tradeFee(), which calls the shared formula in @wrapswap/types (canonical.*, the bit-for-bit mirror of
 * the contract).
 *
 * The shared formula today is canonical.feeBreakdown(shares0, shares1, marketOpen): pre-trade skew and a flat
 * off-hours add-on, so both directions cost the same. The announced model (off-hours = 15 bps × |post-trade skew|,
 * only on trades that increase |skew|) is not in the shared package yet; when it lands, call it here with the
 * trade (post-trade shares and direction are already computed below) and the whole UI follows.
 */
export type Inventory = { shares0: bigint; shares1: bigint };
export type Trade = { sharesIn: bigint; inIsToken0: boolean };
export type TradeFee = {
  basePips: bigint;
  skewPips: bigint;
  closedPips: bigint;
  totalPips: bigint;
  marketOpen: boolean;
  preSkew: number;
  postSkew: number;
  /** The trade moves inventory toward balance (|post-trade skew| < |pre-trade skew|). */
  rebalances: boolean;
};

const skewOf = (s0: bigint, s1: bigint) => Number(canonical.skewX18(s0, s1)) / 1e18;

/** Hook inventory after a trade: the input side grows by the traded shares, the output side shrinks. */
export function postTrade(inv: Inventory, t: Trade): Inventory {
  return t.inIsToken0
    ? { shares0: inv.shares0 + t.sharesIn, shares1: inv.shares1 - t.sharesIn }
    : { shares0: inv.shares0 - t.sharesIn, shares1: inv.shares1 + t.sharesIn };
}

export function tradeFee(inv: Inventory, t: Trade, marketOpen: boolean): TradeFee {
  const post = postTrade(inv, t);
  const f = canonical.feeBreakdown(inv.shares0, inv.shares1, marketOpen);
  const preSkew = skewOf(inv.shares0, inv.shares1),
    postSkew = skewOf(post.shares0, post.shares1);
  return {
    basePips: f.basePips,
    skewPips: f.skewPips,
    closedPips: f.closedPips,
    totalPips: f.totalPips,
    marketOpen,
    preSkew,
    postSkew,
    rebalances: Math.abs(postSkew) < Math.abs(preSkew),
  };
}

/** Inventory with total shares T at a signed skew s (−1…1): shares0 − shares1 = s·T. */
export function inventoryAtSkew(skew: number, total = 20_000n * canonical.ONE): Inventory {
  const milli = BigInt(Math.round(Math.max(-1, Math.min(1, skew)) * 1000));
  const shares0 = (total * (1000n + milli)) / 2000n;
  return { shares0, shares1: total - shares0 };
}

/** Fee at a signed skew with no trade, used by the pin tests (pre-trade formula). */
export function feeAtSkew(skew: number, marketOpen: boolean) {
  const inv = inventoryAtSkew(skew);
  return canonical.feeBreakdown(inv.shares0, inv.shares1, marketOpen);
}

export const pipsToBps = (pips: bigint | number) => Number(pips) / 100;

/** What a quote means in shares: in, out after the fee, the share of value kept, and the fee in tokenOut. */
export function quoteSummary(
  q: { shares: string; amountOut: string; feeAmount: string },
  tokenOut: { sharesPerTokenX18: string; decimals: number },
) {
  const sharesIn = BigInt(q.shares);
  const sharesOut = canonical.toSharesDown(BigInt(q.amountOut), BigInt(tokenOut.sharesPerTokenX18), tokenOut.decimals);
  const keptBp = sharesIn === 0n ? 0n : (sharesOut * 1_000_000n) / sharesIn; // parts per million
  return {
    sharesIn,
    sharesOut,
    keptPct: Number(keptBp) / 10_000,
    feeAmount: BigInt(q.feeAmount),
  };
}
