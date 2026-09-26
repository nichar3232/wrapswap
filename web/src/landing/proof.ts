import { CHAINS, explorerUrl } from "@wrapswap/types";

const NETWORK = "unichain-sepolia";
export const EXPLORER = CHAINS[NETWORK].explorer;
export const NETWORK_NAME = CHAINS[NETWORK].name;
/**
 * WrapSwapRouter.swapExactIn receipts on Unichain Sepolia, verified with eth_getTransactionReceipt (status 1,
 * `to` = deployments/unichain-sepolia.json contracts.wrapSwapRouter, Transfer amounts as captioned).
 */
export const PROOF_SWAPS = [
  {
    label: "Real router swap from a user wallet",
    hash: "0xd1bfee595d7521ca50eb2d95de3012090632982994be5365877ac669e9841ff1",
    caption: "100 mcbAAPL → 101.1035925 mAAPLx",
    block: 63574001,
  },
  {
    label: "First router swap (deployer)",
    hash: "0x9b989f6b2494ad76114315fd5f9a0c1cac8bb59d5de820759eee9b14dfc2ef30",
    caption: "100 mcbAAPL → 101.10227625 mAAPLx",
    block: 63573144,
  },
] as const;

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
      ? [{ name, address, url: explorerUrl(NETWORK, "address", address)! }]
      : [];
  });
}
