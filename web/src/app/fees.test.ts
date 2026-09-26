import { describe, expect, it } from "vitest";
import { canonical, DEMO, type QuoteResponse } from "@wrapswap/types";
import { quoteBreakdown, skewPct } from "./fees";
import { mockResponse } from "../mocks/api";

// The final fee model: base 2 bps always; skew fee min(ceil(1500·|post skew|), 5000) pips only when |skew| grows.
describe("fee formula pinned to the contract model", () => {
  const s0 = 8100n * canonical.ONE,
    s1 = 12150n * canonical.ONE; // −20% skew (§10)
  it("a rebalancing trade pays the base fee only", () => {
    const f = canonical.tradeFeeBreakdown(s0, s1, true, 101n * canonical.ONE);
    expect(f.skewPips).toBe(0n);
    expect(f.totalPips).toBe(200n);
    expect(f.reducesImbalance).toBe(true);
  });
  it("an imbalance-increasing trade pays ceil(1500·|post skew|) on top", () => {
    const f = canonical.tradeFeeBreakdown(s0, s1, false, 101n * canonical.ONE);
    const post = canonical.skewX18(s0 - 101n * canonical.ONE, s1 + 101n * canonical.ONE);
    const expected = (1500n * (post < 0n ? -post : post) + canonical.ONE - 1n) / canonical.ONE;
    expect(f.reducesImbalance).toBe(false);
    expect(f.skewPips).toBe(expected);
    expect(f.totalPips).toBe(200n + expected);
  });
  it("at full imbalance the skew fee is 1500 pips (15 bps)", () => {
    expect(canonical.tradeFeeBreakdown(99n * canonical.ONE, canonical.ONE, true, canonical.ONE).skewPips).toBe(1500n);
  });
});

// One quote, pinned: 100 mcbAAPL → mAAPLx on the §10 pool (a rebalancing trade: base fee only).
describe("You keep pinned to one quote", () => {
  const q = mockResponse("quote", "unichain-sepolia") as QuoteResponse;
  const b = quoteBreakdown(q, { sharesPerTokenX18: DEMO.tokens.mAAPLx.sharesPerTokenX18.toString(), decimals: 18 });
  it("shares in, shares out after fee, the split, keep", () => {
    expect(b.sharesIn).toBe(101_250_000_000_000_000_000n); // 101.25 shares
    expect(b.sharesOut).toBe(101_229_750_000_000_000_000n); // 101.22975 → "101.23"
    expect(b.baseFee + b.skewFee).toBe(b.sharesIn - b.sharesOut);
    expect(b.skewFee).toBe(0n);
    expect(b.reducesImbalance).toBe(true);
    expect(b.keep).toBeCloseTo(0.9998, 4);
    expect(q.amountOut).toBe(DEMO.variants["unichain-sepolia"].parityFill.amountOut.toString());
  });
  it("falls back to the shared split when the API omits the new fields", () => {
    const { sharesIn: _a, sharesOut: _b, baseFee: _c, skewFee: _d, youKeep: _e, ...old } = q;
    const o = quoteBreakdown(old, { sharesPerTokenX18: DEMO.tokens.mAAPLx.sharesPerTokenX18.toString(), decimals: 18 });
    expect(o.sharesOut).toBe(b.sharesOut);
    expect(o.baseFee).toBe(b.baseFee);
  });
  it("formats signed skew", () => {
    expect(skewPct(DEMO.skewX18.initial)).toBe("−20.00%");
    expect(skewPct(0n)).toBe("0.00%");
  });
});
