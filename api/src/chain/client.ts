import "./runtime.js";
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, getAddress, type Abi } from "viem";
import {
  abis,
  parseDeployment,
  parseNetwork,
  deploymentPath,
  resolvedDeploymentPath,
  isMinimalManifest,
  type Deployment,
} from "@wrapswap/types";
// Unichain Sepolia (1301) is the default network; NETWORK=anvil selects the offline stack. Set before `rpc` below
// is read, and before every entrypoint (all import this module) checks its required env.
process.env.NETWORK ||= "unichain-sepolia";
if (process.env.NETWORK === "unichain-sepolia") process.env.RPC_URL ||= "https://sepolia.unichain.org";
export function loadDeployment(
  network = process.env.NETWORK,
  root = process.cwd(),
): Deployment {
  const n = parseNetwork(network);
  const read = (p: string) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
  let raw = read(deploymentPath(n));
  // A minimal manifest is expanded from the chain by scripts/dev/resolve-deployment.ts (run by live-up).
  if (isMinimalManifest(raw))
    try {
      raw = read(resolvedDeploymentPath(n));
    } catch {
      throw Error(`${deploymentPath(n)} is minimal: run scripts/dev/resolve-deployment.ts first`);
    }
  const d = parseDeployment(raw);
  if (d.network !== n) throw Error("Deployment network mismatch");
  return JSON.parse(
    JSON.stringify(d, (_, v) =>
      typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)
        ? getAddress(v.toLowerCase())
        : v,
    ),
  );
}
export const manifest = loadDeployment;
export const rpc = process.env.RPC_URL;
export const publicClient = createPublicClient({
  transport: http(rpc || `http://127.0.0.1:${process.env.ANVIL_PORT ?? 18504}`),
});
export const contractAbis: Record<string, Abi> = {
  parityHook: abis.IParityHook,
  darkCrossHook: abis.IDarkCrossHook,
  eligibility: abis.IEASEligibility,
  oracle: abis.IMockPriceOracle,
  registry: abis.IIssuerRegistry,
  calendar: abis.INyseCalendar,
};
export const stringify = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export const json = (value: unknown): any =>
  JSON.parse(stringify(value), (_, v) =>
    typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)
      ? v.toLowerCase()
      : v,
  );
export function chainReader(d: Deployment, client: any = publicClient) {
  return async (
    contract: string,
    functionName: string,
    args: unknown[] = [],
    blockNumber?: bigint,
  ): Promise<any> =>
    client.readContract({
      address: d.contracts[contract as keyof typeof d.contracts],
      abi: contractAbis[contract],
      functionName,
      args,
      blockNumber,
    });
}

/** One Deployment view per asset with a DarkCrossHook (its hook, pair, tokens and pool); the whole deployment if the
 *  manifest is single-asset. The crank runs one worker per view. */
export function assetViews(d: Deployment): Deployment[] {
  const assets = (d.assets ?? []).filter((a) => a.darkCrossHook && a.darkBaseToken && a.darkQuoteToken);
  if (!assets.length) return [d];
  const eqa = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  return assets.map((a) => ({
    ...d,
    contracts: { ...d.contracts, darkCrossHook: a.darkCrossHook! },
    pool: a.pool,
    dark: { ...d.dark, baseToken: a.darkBaseToken!, quoteToken: a.darkQuoteToken! },
    tokens: a.wrappers.map(
      (w) =>
        d.tokens.find((t) => eqa(t.address, w.token)) ?? {
          symbol: w.symbol,
          name: w.symbol,
          address: w.token,
          decimals: w.decimals,
          issuer: w.platform === "Coinbase" ? "coinbase" : "xstocks",
          underlying: a.symbol,
          mock: d.demoMode,
          adapter: w.adapter,
          adapterKind: w.platform === "Coinbase" ? "B20Multiplier" : "XStocksMultiplier",
          sharesPerTokenX18: w.multiplier,
          darkRole: eqa(w.token, a.darkBaseToken!) ? "base" : "quote",
        },
    ),
  })) as Deployment[];
}

