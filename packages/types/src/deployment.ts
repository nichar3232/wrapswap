import type { Deployment, Network } from "./generated/schemas.js";
import { assertDeployment } from "./generated/validators.js";

export const NETWORKS = ["anvil", "base-sepolia"] as const satisfies readonly Network[];
export const CHAIN_IDS = { anvil: 31337, "base-sepolia": 84532 } as const satisfies Record<Network, number>;

/** Repo-relative path of a network's deployment file: deployments/${NETWORK}.json. */
export const deploymentPath = (network: Network) => `deployments/${network}.json` as const;

export function parseNetwork(value: string | undefined): Network {
  if (value === "anvil" || value === "base-sepolia") return value;
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
