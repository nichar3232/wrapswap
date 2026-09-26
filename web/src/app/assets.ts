import type { AssetsResponse, Deployment } from "@wrapswap/types";

export type Token = {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  sharesPerTokenX18: string;
  issuer: string;
  underlying: string;
};
export type Platform = { name: string; token: Token };
export type Asset = {
  symbol: string;
  platforms: Platform[];
  /** The asset's Dark Cross pair, when one is deployed (Sealed cross is offered only then). */
  darkCross: { baseToken: string; quoteToken: string } | null;
};

const PLATFORM: Record<string, string> = { coinbase: "Coinbase", xstocks: "xStocks" };
export const platformName = (t: { issuer: string }) =>
  PLATFORM[t.issuer] ?? t.issuer.charAt(0).toUpperCase() + t.issuer.slice(1);

/**
 * Assets and platforms from GET /assets (unhealthy adapters are left out: they can't be moved). While /assets is
 * loading or unavailable, the deployment's tokens stand in, grouped by underlying.
 */
export function assetsOf(api: AssetsResponse | undefined, d: Deployment | undefined): Asset[] {
  if (api)
    return api.assets
      .map((a) => ({
        symbol: a.asset,
        platforms: a.platforms
          .filter((p) => p.healthy)
          .map((p) => {
            const token: Token = {
              address: p.address,
              symbol: p.symbol,
              decimals: p.decimals,
              sharesPerTokenX18: p.sharesPerTokenX18,
              issuer: p.issuer,
              underlying: a.asset,
            };
            return { name: platformName(p), token };
          }),
        darkCross: a.darkCross ? { baseToken: a.darkCross.baseToken, quoteToken: a.darkCross.quoteToken } : null,
      }))
      .filter((a) => a.platforms.length >= 2);
  if (!d) return [];
  const by = new Map<string, Token[]>();
  for (const t of d.tokens) by.set(t.underlying, [...(by.get(t.underlying) ?? []), t]);
  const dark = [d.dark.baseToken.toLowerCase(), d.dark.quoteToken.toLowerCase()];
  return [...by].map(([symbol, tokens]) => ({
    symbol,
    platforms: tokens.map((token) => ({ name: platformName(token), token })),
    darkCross:
      tokens.filter((t) => dark.includes(t.address.toLowerCase())).length === 2
        ? { baseToken: d.dark.baseToken, quoteToken: d.dark.quoteToken }
        : null,
  }));
}

/** Canonical shares for a raw token amount (floor, like the contract). */
export const toShares = (raw: bigint, t: { sharesPerTokenX18: string; decimals: number }) =>
  (raw * BigInt(t.sharesPerTokenX18)) / 10n ** BigInt(t.decimals);
