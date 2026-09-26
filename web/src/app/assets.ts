import type { Deployment } from "@wrapswap/types";

export type Token = Deployment["tokens"][number];
export type Platform = { name: string; token: Token };
export type Asset = {
  symbol: string;
  platforms: Platform[];
  /** A Dark Cross pair exists for this asset (both wrappers are the hook's base/quote tokens). */
  darkCross: boolean;
};

const PLATFORM: Record<string, string> = { coinbase: "Coinbase", xstocks: "xStocks" };
export const platformName = (t: { issuer: string }) =>
  PLATFORM[t.issuer] ?? t.issuer.charAt(0).toUpperCase() + t.issuer.slice(1);

/**
 * Assets and their platforms, from the deployment's tokens (grouped by underlying). There is no /assets route yet;
 * when it lands, it replaces this without changing the shape. Only what is deployed appears.
 */
export function assetsOf(d: Deployment | undefined): Asset[] {
  if (!d) return [];
  const by = new Map<string, Token[]>();
  for (const t of d.tokens) by.set(t.underlying, [...(by.get(t.underlying) ?? []), t]);
  const dark = [d.dark.baseToken.toLowerCase(), d.dark.quoteToken.toLowerCase()];
  return [...by].map(([symbol, tokens]) => ({
    symbol,
    platforms: tokens.map((token) => ({ name: platformName(token), token })),
    darkCross: tokens.filter((t) => dark.includes(t.address.toLowerCase())).length === 2,
  }));
}

/** Canonical shares for a raw token amount (floor, like the contract). */
export const toShares = (raw: bigint, t: Token) => (raw * BigInt(t.sharesPerTokenX18)) / 10n ** BigInt(t.decimals);
