import { canonical } from "@wrapswap/types";

const TOTAL = 20_000n * canonical.ONE;

/**
 * Hook fee in pips at a signed inventory skew (-1…1) using the contract's own formula
 * (canonical.feeBreakdown mirrors CanonicalShares/ParityHook bit for bit).
 */
export function feeAtSkew(skew: number, marketOpen: boolean) {
  const milli = BigInt(Math.round(Math.max(-1, Math.min(1, skew)) * 1000));
  const shares0 = (TOTAL * (1000n + milli)) / 2000n;
  return canonical.feeBreakdown(shares0, TOTAL - shares0, marketOpen);
}

export const pipsToBps = (pips: bigint | number) => Number(pips) / 100;
