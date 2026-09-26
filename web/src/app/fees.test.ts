import { describe, expect, it } from "vitest";
import { canonical, DEMO } from "@wrapswap/types";
import { feeAtSkew, inventoryAtSkew, quoteSummary, tradeFee } from "./fees";

// Values asserted by contracts/test/CanonicalShares.t.sol against the Solidity implementation.
describe("fee formula pinned to contract output", () => {
  it("matches CanonicalShares.totalFeePips", () => {
    const f = (s0: bigint, s1: bigint, open: boolean) => canonical.feeBreakdown(s0, s1, open).totalPips;
    expect(f(8100n * canonical.ONE, 12150n * canonical.ONE, true)).toBe(460n);
    expect(f(8100n * canonical.ONE, 12150n * canonical.ONE, false)).toBe(1460n);
    expect(f(canonical.ONE, 0n, false)).toBe(2500n); // capped
    expect(f(0n, 1n, false)).toBe(2500n);
    expect(canonical.feeOnGross(10125n * 10n ** 16n, 460n)).toBe(46575000000000000n);
  });
  it("the curve's skew mapping reproduces the demo pool (-20% skew)", () => {
    expect(feeAtSkew(-0.2, true).totalPips).toBe(BigInt(DEMO.variants.anvil.parityFill.feePips));
    expect(feeAtSkew(-0.2, false).totalPips).toBe(1460n); // totalFeePips(8100e18, 12150e18, false)
  });
  it("tradeFee is the shared formula plus the trade's direction", () => {
    const inv = { shares0: 8100n * canonical.ONE, shares1: 12150n * canonical.ONE };
    const in0 = tradeFee(inv, { sharesIn: 101n * canonical.ONE, inIsToken0: true }, false);
    const in1 = tradeFee(inv, { sharesIn: 101n * canonical.ONE, inIsToken0: false }, false);
    expect(in0.totalPips).toBe(canonical.feeBreakdown(inv.shares0, inv.shares1, false).totalPips);
    expect(in0.rebalances).toBe(true); // selling the scarce side back to the hook
    expect(in1.rebalances).toBe(false);
    expect(Math.abs(in0.postSkew)).toBeLessThan(0.2);
    expect(inventoryAtSkew(0).shares0).toBe(inventoryAtSkew(0).shares1);
  });
});

// One quote, pinned: 100 mcbAAPL → mAAPLx at 14.60 bps (the parity quote arithmetic, §10 closed-market figures).
describe("shares headline pinned to one quote", () => {
  const mcb = { spt: DEMO.tokens.mcbAAPL.sharesPerTokenX18, decimals: DEMO.tokens.mcbAAPL.decimals };
  const x = { spt: DEMO.tokens.mAAPLx.sharesPerTokenX18, decimals: DEMO.tokens.mAAPLx.decimals };
  const q = canonical.parityQuote(mcb, x, -DEMO.parityFill.amountIn, 1460n);
  const s = quoteSummary(
    { shares: q.shares.toString(), amountOut: q.amountOut.toString(), feeAmount: q.feeAmount.toString() },
    { sharesPerTokenX18: x.spt.toString(), decimals: x.decimals },
  );
  it("in-shares, out-shares after fee, keep% and fee amount", () => {
    expect(s.sharesIn).toBe(101_250_000_000_000_000_000n); // 101.25 shares
    expect(s.sharesOut).toBe(101_102_175_000_000_000_000n); // 101.102175 → shown as 101.10
    expect(s.keptPct).toBe(99.854);
    expect(s.feeAmount).toBe(147_825_000_000_000_000n); // 0.147825 mAAPLx → "0.15"
  });
});
