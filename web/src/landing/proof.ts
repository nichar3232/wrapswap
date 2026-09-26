export const EXPLORER = "https://sepolia.basescan.org";
export const SWAP_TX =
  "0xcfb8a68923d238f234d0b1274e875e02ad622865cd4eda6964d45c443d492c12";

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
export function proofRows(d: {
  contracts: Partial<Record<string, string>>;
}) {
  return CONTRACTS.flatMap(([name, key]) => {
    const address = d.contracts[key];
    return address
      ? [{ name, address, url: `${EXPLORER}/address/${address}` }]
      : [];
  });
}
