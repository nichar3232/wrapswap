import { describe, expect, it } from "vitest";
import { canonical, DEMO } from "@wrapswap/types";
import { feeAtSkew } from "./fees";

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
    expect(feeAtSkew(-0.2, false).totalPips).toBe(1460n); // CanonicalShares.t.sol: totalFeePips(8100e18, 12150e18, false)
  });
  it("is symmetric, 2 bps at balance, +10 bps off-hours, capped at 25 bps", () => {
    expect(feeAtSkew(0, true).totalPips).toBe(200n);
    expect(feeAtSkew(0, false).totalPips).toBe(1200n);
    expect(feeAtSkew(0.5, true).totalPips).toBe(feeAtSkew(-0.5, true).totalPips);
    expect(feeAtSkew(1, true).totalPips).toBe(1500n);
    expect(feeAtSkew(1, false).totalPips).toBe(2500n);
  });
});
