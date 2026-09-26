import { it, expect } from "vitest";
import { canonical as c, DEMO } from "@wrapswap/types";
it.each([
  [0n, 0n, true, 200n],
  [1n, 1n, false, 200n], // balanced: no off-hours premium
  [3n, 2n, true, 460n],
  [3n, 2n, false, 760n], // marginal skew-increasing premium ceil(1500 * 0.2)
  [1n, 0n, false, 2500n],
  [0n, 1n, true, 1500n],
  [2n, 1n, true, 634n],
])("fee table %s/%s open=%s", (a, b, open, pips) =>
  expect(c.feeBreakdown(a, b, open).totalPips).toBe(pips),
);
it("both demo variants and exact-output round up", () => {
  for (const [open, pips, out] of [
    [true, 460n, 101203425000000000000n],
    [false, 460n, 101203425000000000000n], // closed, skew-reducing trade: no premium
  ] as const) {
    const f = c.tradeFeeBreakdown(600n, 400n, false, 1n, open);
    expect(f.totalPips).toBe(pips);
    const a = { spt: DEMO.tokens.mcbAAPL.sharesPerTokenX18, decimals: 6 },
      b = { spt: 10n ** 18n, decimals: 18 };
    const q = c.parityQuote(a, b, -100000000n, f.totalPips);
    expect(q.amountOut).toBe(out);
    expect(c.parityQuote(a, b, q.amountOut, f.totalPips).amountIn).toBe(
      100000000n,
    );
    const r = c.parityQuote(a, b, 1n, f.totalPips);
    expect(r.grossOut).toBe(2n);
    expect(r.amountIn).toBe(1n);
  }
});
it("off-hours premium only for skew-increasing trades", () => {
  const up = c.tradeFeeBreakdown(11000n, 9000n, true, 200n, false);
  expect(up.closedPips).toBe(180n);
  expect(up.totalPips).toBe(510n);
  expect(c.tradeFeeBreakdown(11000n, 9000n, false, 200n, false).closedPips).toBe(0n);
  expect(c.tradeFeeBreakdown(10000n, 10000n, true, 100n, false).totalPips).toBe(215n);
  expect(c.tradeFeeBreakdown(11000n, 9000n, true, 200n, true).totalPips).toBe(330n);
});
it("demo inventory transition and dark residual match both §10 variants", () => {
  const a = { spt: DEMO.tokens.mcbAAPL.sharesPerTokenX18, decimals: 6 },
    b = { spt: DEMO.tokens.mAAPLx.sharesPerTokenX18, decimals: 18 };
  for (const v of Object.values(DEMO.variants)) {
    // Live variants carry their on-chain seed (scripts/dev/demo-variant.ts); anvil uses the §10 seed.
    const seed = (v as any).seedInventory ?? DEMO.inventory;
    const s0 = c.toSharesDown(BigInt(seed.mcbAAPL), a.spt, a.decimals),
      s1 = BigInt(seed.mAAPLx);
    const fee = c.tradeFeeBreakdown(s0, s1, true, DEMO.parityFill.shares, v.marketOpen);
    const q = c.parityQuote(
      a,
      b,
      DEMO.parityFill.amountSpecified,
      fee.totalPips,
    );
    expect(q.feeAmount).toBe(v.parityFill.feeAmount);
    const after = c.tradeFeeBreakdown(s0 + q.shares, s1 - q.grossOut, true, DEMO.dark.residual.shares, v.marketOpen);
    expect(after.totalPips).toBe(BigInt(v.residual.feePips));
    const residual = c.parityQuote(
      a,
      b,
      -DEMO.dark.residual.amountIn,
      after.totalPips,
    );
    expect(residual.amountOut).toBe(v.residual.amountOut);
    expect(residual.feeAmount).toBe(v.residual.feeAmount);
  }
});
