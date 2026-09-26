import { it, expect } from "vitest";
import { canonical as c, DEMO } from "@wrapswap/types";
// Trade-less view: base + the fee a marginal |skew|-increasing trade pays, min(ceil(1500 * |skew|), 5000).
it.each([
  [0n, 0n, 200n],
  [1n, 1n, 200n], // balanced: no skew fee
  [3n, 2n, 500n], // ceil(1500 * 0.2)
  [1n, 0n, 1700n], // one-sided: 15 bps
  [0n, 1n, 1700n],
  [2n, 1n, 700n],
])("fee view %s/%s", (a, b, pips) => expect(c.feeBreakdown(a, b).totalPips).toBe(pips));
it("rebalancing trade pays the base only; exact-output rounds up", () => {
  const f = c.tradeFeeBreakdown(600n, 400n, false, 1n);
  expect(f.totalPips).toBe(200n);
  expect(f.reducesImbalance).toBe(true);
  const a = { spt: DEMO.tokens.mcbAAPL.sharesPerTokenX18, decimals: 6 },
    b = { spt: 10n ** 18n, decimals: 18 };
  const q = c.parityQuote(a, b, -100000000n, f.totalPips);
  expect(q.amountOut).toBe(101229750000000000000n);
  expect(c.parityQuote(a, b, q.amountOut, f.totalPips).amountIn).toBe(100000000n);
  const r = c.parityQuote(a, b, 1n, f.totalPips);
  expect(r.grossOut).toBe(2n);
  expect(r.amountIn).toBe(1n);
});
it("skew fee only for imbalance-increasing trades (mirrors CanonicalShares.t.sol)", () => {
  const up = c.tradeFeeBreakdown(11000n, 9000n, true, 200n);
  expect(up.skewPips).toBe(180n);
  expect(up.totalPips).toBe(380n);
  expect(up.reducesImbalance).toBe(false);
  expect(c.tradeFeeBreakdown(11000n, 9000n, false, 200n).skewPips).toBe(0n);
  expect(c.tradeFeeBreakdown(10000n, 10000n, true, 100n).totalPips).toBe(215n);
  expect(c.tradeFeeBreakdown(11000n, 9000n, false, 1500n).skewPips).toBe(0n); // 0.10 -> 0.05 through balance
  expect(c.tradeFeeBreakdown(0n, 0n, true, 10n ** 18n).skewPips).toBe(1500n);
});
it("demo inventory transition and dark residual match both §10 variants", () => {
  const a = { spt: DEMO.tokens.mcbAAPL.sharesPerTokenX18, decimals: 6 },
    b = { spt: DEMO.tokens.mAAPLx.sharesPerTokenX18, decimals: 18 };
  for (const v of Object.values(DEMO.variants)) {
    // Live variants carry their on-chain seed (scripts/dev/demo-variant.ts); anvil uses the §10 seed.
    const seed = (v as any).seedInventory ?? DEMO.inventory;
    const s0 = c.toSharesDown(BigInt(seed.mcbAAPL), a.spt, a.decimals),
      s1 = BigInt(seed.mAAPLx);
    const fee = c.tradeFeeBreakdown(s0, s1, true, DEMO.parityFill.shares);
    const q = c.parityQuote(
      a,
      b,
      DEMO.parityFill.amountSpecified,
      fee.totalPips,
    );
    expect(q.feeAmount).toBe(v.parityFill.feeAmount);
    const after = c.tradeFeeBreakdown(s0 + q.shares, s1 - q.grossOut, true, DEMO.dark.residual.shares);
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
