import type { Deployment, Network } from "./generated/schemas.js";
import { assertDeployment } from "./generated/validators.js";

export const NETWORKS = ["anvil", "unichain-sepolia"] as const satisfies readonly Network[];

/** Chain facts per network. The public RPC is confirmed by eth_chainId (0x515). */
export const CHAINS = {
  anvil: { id: 31337, name: "Anvil", rpcUrl: "http://127.0.0.1:8545", explorer: null },
  "unichain-sepolia": {
    id: 1301,
    name: "Unichain Sepolia",
    rpcUrl: "https://sepolia.unichain.org",
    explorer: "https://sepolia.uniscan.xyz",
  },
} as const satisfies Record<Network, { id: number; name: string; rpcUrl: string; explorer: string | null }>;
export const CHAIN_IDS = {
  anvil: CHAINS.anvil.id,
  "unichain-sepolia": CHAINS["unichain-sepolia"].id,
} as const satisfies Record<Network, number>;

/** The live network: what web, api and crank resolve when NETWORK is unset. */
export const DEFAULT_NETWORK = "unichain-sepolia" satisfies Network;
export const DEFAULT_CHAIN = CHAINS[DEFAULT_NETWORK];

/** Block-explorer link for an address or transaction; null on networks without an explorer (anvil). */
export function explorerUrl(network: Network, kind: "address" | "tx", value: string): string | null {
  const base = CHAINS[network].explorer;
  return base && `${base}/${kind}/${value}`;
}

/** Repo-relative path of a network's deployment file: deployments/${NETWORK}.json. */
export const deploymentPath = (network: Network) => `deployments/${network}.json` as const;
/** Expanded manifest written by scripts/dev/resolve-deployment.ts from a minimal manifest plus chain reads. */
export const resolvedDeploymentPath = (network: Network) => `deployments/${network}.resolved.json` as const;
/** The minimal deploy output (chainId, deployBlock, assets[{…, parityHook, darkCross}]), not the §4 schema. */
export const isMinimalManifest = (json: any): boolean =>
  !!json && typeof json === "object" && !("network" in json) && Array.isArray(json.assets) && !!json.assets[0]?.parityHook;

/** Validates NETWORK; unset or empty resolves to DEFAULT_NETWORK. */
export function parseNetwork(value: string | undefined): Network {
  if (value === undefined || value === "") return DEFAULT_NETWORK;
  if ((NETWORKS as readonly string[]).includes(value)) return value as Network;
  throw new Error(`NETWORK must be one of ${NETWORKS.join(", ")} (got ${JSON.stringify(value)})`);
}

/** Validates a parsed deployment JSON and checks the cross-field rules of INTERFACES.md §4. */
export function parseDeployment(json: unknown): Deployment {
  const d = assertDeployment(json);
  if (CHAIN_IDS[d.network] !== d.chainId) throw new Error(`chainId ${d.chainId} does not match network ${d.network}`);
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(d.pool.key.hooks, d.contracts.parityHook)) throw new Error("pool.key.hooks must equal contracts.parityHook");
  if (d.pool.key.fee !== 8388608) throw new Error("pool.key.fee must be DYNAMIC_FEE_FLAG (8388608)");
  if (d.hooks.parityHook.flags !== "0x20c8") throw new Error("hooks.parityHook.flags must be 0x20c8");
  if ((Number.parseInt(d.contracts.parityHook.slice(-4), 16) & 0x3fff) !== 0x20c8)
    throw new Error("parityHook address flag bits must equal 0x20c8");
  const tokens = d.tokens.map((t) => t.address.toLowerCase()).sort();
  const keyed = [d.pool.key.currency0.toLowerCase(), d.pool.key.currency1.toLowerCase()];
  if (keyed[0] >= keyed[1] || tokens.join() !== keyed.join())
    throw new Error("pool.key currencies must be the two sorted issuer tokens");
  if (d.demoAccounts.accounts.some((a) => "privateKey" in (a as object))) throw new Error("private keys are forbidden");
  return d;
}
