import { describe, expect, it } from "vitest";
import { canonical, DEMO } from "@wrapswap/types";
import { feeAtSkew } from "./fees";

// Values asserted by contracts/test/CanonicalShares.t.sol / ParityHook.t.sol against the Solidity implementation.
// The curve shows the fee of a marginal |skew|-increasing trade (2 bps base + 15 bps x |skew|); a trade that reduces
// |skew| pays the base only. There is no market-hours input (the second feeAtSkew argument is ignored).
describe("fee formula pinned to contract output", () => {
  it("matches ParityHook.feeBreakdown (trade-less view)", () => {
    const f = (s0: bigint, s1: bigint) => canonical.feeBreakdown(s0, s1).totalPips;
    expect(f(8100n * canonical.ONE, 12150n * canonical.ONE)).toBe(500n); // 200 + ceil(1500 * 0.2)
    expect(f(canonical.ONE, 0n)).toBe(1700n); // one-sided: 15 bps skew fee (cap 50 bps never binds)
    expect(f(0n, 1n)).toBe(1700n);
    expect(canonical.feeOnGross(10125n * 10n ** 16n, 200n)).toBe(20250000000000000n);
  });
  it("the demo fill reduces |skew| and pays the base only", () => {
    const t = canonical.tradeFeeBreakdown(8100n * canonical.ONE, 12150n * canonical.ONE, true, 10125n * 10n ** 16n);
    expect(t.totalPips).toBe(BigInt(DEMO.variants.anvil.parityFill.feePips));
    expect(t.reducesImbalance).toBe(true);
    expect(feeAtSkew(-0.2, true).totalPips).toBe(500n);
  });
  it("is symmetric, 2 bps at balance, 15 bps x |skew| on the increasing side", () => {
    expect(feeAtSkew(0, true).totalPips).toBe(200n);
    expect(feeAtSkew(0, false).totalPips).toBe(200n);
    expect(feeAtSkew(0.5, false).totalPips).toBe(950n);
    expect(feeAtSkew(0.5, true).totalPips).toBe(feeAtSkew(-0.5, true).totalPips);
    expect(feeAtSkew(1, true).totalPips).toBe(1700n);
  });
});
