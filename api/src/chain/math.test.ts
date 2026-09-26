import { it, expect } from "vitest";
import { canonical as c, DEMO } from "@wrapswap/types";
it.each([
  [0n, 0n, true, 200n],
  [1n, 1n, false, 1200n],
  [3n, 2n, true, 460n],
  [3n, 2n, false, 1460n],
  [1n, 0n, false, 2500n],
  [0n, 1n, true, 1500n],
  [2n, 1n, true, 634n],
])("fee table %s/%s open=%s", (a, b, open, pips) =>
  expect(c.feeBreakdown(a, b, open).totalPips).toBe(pips),
);
it("both demo variants and exact-output round up", () => {
  for (const [open, pips, out] of [
    [true, 460n, 101203425000000000000n],
    [false, 1460n, 101102175000000000000n],
  ] as const) {
    const f = c.feeBreakdown(600n, 400n, open);
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
it("demo inventory transition and dark residual match both §10 variants", () => {
  const a = { spt: DEMO.tokens.mcbAAPL.sharesPerTokenX18, decimals: 6 },
    b = { spt: DEMO.tokens.mAAPLx.sharesPerTokenX18, decimals: 18 };
  for (const v of Object.values(DEMO.variants)) {
    const s0 = c.toSharesDown(DEMO.inventory.mcbAAPL, a.spt, a.decimals),
      s1 = DEMO.inventory.mAAPLx;
    const fee = c.feeBreakdown(s0, s1, v.marketOpen);
    const q = c.parityQuote(
      a,
      b,
      DEMO.parityFill.amountSpecified,
      fee.totalPips,
    );
    expect(q.feeAmount).toBe(v.parityFill.feeAmount);
    const after = c.feeBreakdown(s0 + q.shares, s1 - q.grossOut, v.marketOpen);
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
