export const EXPLORER = "https://sepolia.uniscan.xyz";
export const NETWORK_NAME = "Unichain Sepolia";
/** Real router swap from a user wallet on Unichain Sepolia. Empty hides the card; fill in the 0x… hash. */
export const PROOF_SWAP_TX = "";

type ProofDeployment = {
  chainId?: number;
  contracts: Partial<Record<string, string>>;
};

// Globbed rather than imported so the build still passes before the deployment file lands.
const files = import.meta.glob<ProofDeployment>(
  "../../../deployments/unichain-sepolia.json",
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
      ? [{ name, address, url: `${EXPLORER}/address/${address}` }]
      : [];
  });
}
