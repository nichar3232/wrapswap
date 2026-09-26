import { CHAINS, explorerUrl } from "@wrapswap/types";

const NETWORK = "unichain-sepolia";
export const EXPLORER = CHAINS[NETWORK].explorer;
export const NETWORK_NAME = CHAINS[NETWORK].name;


type ProofDeployment = {
  chainId?: number;
  contracts: Partial<Record<string, string>>;
};

// Globbed rather than imported so the build still passes before the deployment file lands.
const files = import.meta.glob<ProofDeployment>(
  "../../../deployments/unichain-sepolia.resolved.json",
  { eager: true, import: "default" },
);
export const deployment: ProofDeployment | undefined = Object.values(files)[0];

const CONTRACTS = [
  ["ParityHook", "parityHook"],
  ["DarkCrossHook", "darkCrossHook"],
  ["WrapSwapRouter", "wrapSwapRouter"],
  ["IssuerRegistry", "registry"],
  ["PoolManager", "poolManager"],
] as const;

export const short = (hex: string, head = 6, tail = 4) =>
  `${hex.slice(0, head)}…${hex.slice(-tail)}`;

/** Proof-table rows read from a deployment file; contracts it lacks are omitted rather than faked. */
export function proofRows(d: ProofDeployment | undefined) {
  return CONTRACTS.flatMap(([name, key]) => {
    const address = d?.contracts[key];
    return address
      ? [{ name, address, url: explorerUrl(NETWORK, "address", address)! }]
      : [];
  });
}
