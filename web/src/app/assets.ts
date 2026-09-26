import type { AssetsResponse, Deployment, PoolKey } from "@wrapswap/types";

export type Token = {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  sharesPerTokenX18: string;
  issuer: string;
  underlying: string;
};
export type Platform = { name: string; token: Token };
export type DarkPair = { hook: `0x${string}`; baseToken: string; quoteToken: string; batchBlocks: number };
export type Asset = {
  symbol: string;
  platforms: Platform[];
  /** The asset's ParityHook pool (Convert routes through it). */
  pool: { id: `0x${string}`; key: PoolKey } | null;
  /** The asset's DarkCrossHook pair, when one is deployed. */
  darkCross: DarkPair | null;
};

const PLATFORM: Record<string, string> = { coinbase: "Coinbase", xstocks: "xStocks" };
export const platformName = (t: { issuer: string }) =>
  PLATFORM[t.issuer.toLowerCase()] ?? t.issuer.charAt(0).toUpperCase() + t.issuer.slice(1);

/**
 * Assets from GET /assets (unhealthy adapters are left out: they can't be converted). While /assets is loading or
 * unavailable, the deployment's per-asset manifest (deployments/<network>.resolved.json → assets) stands in.
 */
export function assetsOf(api: AssetsResponse | undefined, d: Deployment | undefined): Asset[] {
  if (api)
    return api.assets
      .map((a) => ({
        symbol: a.asset,
        platforms: a.platforms
          .filter((p) => p.healthy)
          .map((p) => ({
            name: p.platform || platformName(p),
            token: {
              address: p.address,
              symbol: p.symbol,
              decimals: p.decimals,
              sharesPerTokenX18: p.sharesPerTokenX18,
              issuer: p.issuer,
              underlying: a.asset,
            },
          })),
        pool: a.pools[0]
          ? {
              id: a.pools[0].poolId,
              key: {
                currency0: a.pools[0].currency0,
                currency1: a.pools[0].currency1,
                fee: a.pools[0].fee,
                tickSpacing: a.pools[0].tickSpacing,
                hooks: a.pools[0].hooks,
              },
            }
          : null,
        darkCross: a.darkCross
          ? { hook: a.darkCross.hook, baseToken: a.darkCross.baseToken, quoteToken: a.darkCross.quoteToken, batchBlocks: a.darkCross.batchBlocks }
          : null,
      }))
      .filter((a) => a.platforms.length >= 2);
  if (!d) return [];
  if (d.assets?.length)
    return d.assets.map((a) => ({
      symbol: a.symbol,
      platforms: a.wrappers.map((w) => ({
        name: w.platform,
        token: {
          address: w.token,
          symbol: w.symbol,
          decimals: w.decimals,
          sharesPerTokenX18: w.multiplier,
          issuer: w.platform.toLowerCase(),
          underlying: a.symbol,
        },
      })),
      pool: { id: a.pool.id, key: a.pool.key },
      darkCross:
        a.darkCross && a.darkCrossHook && a.darkBaseToken && a.darkQuoteToken
          ? { hook: a.darkCrossHook, baseToken: a.darkBaseToken, quoteToken: a.darkQuoteToken, batchBlocks: d.dark.batchBlocks }
          : null,
    }));
  const by = new Map<string, Token[]>();
  for (const t of d.tokens) by.set(t.underlying, [...(by.get(t.underlying) ?? []), t]);
  return [...by].map(([symbol, tokens]) => ({
    symbol,
    platforms: tokens.map((token) => ({ name: platformName(token), token })),
    pool: { id: d.pool.id, key: d.pool.key },
    darkCross: { hook: d.contracts.darkCrossHook, baseToken: d.dark.baseToken, quoteToken: d.dark.quoteToken, batchBlocks: d.dark.batchBlocks },
  }));
}

/** Canonical shares for a raw token amount (floor, like the contract). */
export const toShares = (raw: bigint, t: { sharesPerTokenX18: string; decimals: number }) =>
  (raw * BigInt(t.sharesPerTokenX18)) / 10n ** BigInt(t.decimals);

export const findToken = (assets: Asset[], address: string) =>
  assets.flatMap((a) => a.platforms).find((p) => p.token.address.toLowerCase() === address.toLowerCase());
