import { CHAINS, explorerUrl } from "@wrapswap/types";

const NETWORK = "unichain-sepolia";
export const EXPLORER = CHAINS[NETWORK].explorer;
export const NETWORK_NAME = CHAINS[NETWORK].name;

/** The committed resolved manifest, every field optional so a partial file never breaks the page. */
export type ProofDeployment = {
  chainId?: number;
  contracts?: Partial<Record<string, string | null>>;
  router?: string;
  faucet?: string;
  assets?: {
    symbol: string;
    wrappers?: { platform?: string; symbol?: string; token?: string; adapter?: string }[];
    darkCrossHook?: string;
  }[];
  proofs?: { label?: string; tx?: string }[] | { swaps?: { label?: string; hash?: string }[] };
};

// Globbed rather than imported so the build still passes before the deployment file lands.
const files = import.meta.glob<ProofDeployment>("../../../deployments/unichain-sepolia.resolved.json", { eager: true, import: "default" });
export const deployment: ProofDeployment | undefined = Object.values(files)[0];

const CORE = [
  ["ParityHook", "parityHook"],
  ["WrapSwapRouter", "wrapSwapRouter"],
  ["PoolManager", "poolManager"],
  ["IssuerRegistry", "registry"],
  ["Eligibility", "eligibility"],
  ["Price oracle", "oracle"],
] as const;

export const short = (hex: string, head = 6, tail = 4) => `${hex.slice(0, head)}…${hex.slice(-tail)}`;
const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const row = (name: string, address: string) => ({ name, address, url: explorerUrl(NETWORK, "address", address)! });

/** Core contract rows from a deployment file; contracts it lacks are omitted rather than faked. */
export function proofRows(d: ProofDeployment | undefined) {
  return CORE.flatMap(([name, key]) => {
    const address = d?.contracts?.[key];
    return isAddress(address) ? [row(name, address)] : [];
  });
}

/** Every deployed contract, grouped: core, then per asset (Dark Cross hook, each wrapper and its adapter), faucet. */
export function contractGroups(d: ProofDeployment | undefined) {
  const groups: { title: string; rows: ReturnType<typeof row>[] }[] = [];
  const core = proofRows(d);
  if (core.length) groups.push({ title: "Core", rows: core });
  for (const a of d?.assets ?? []) {
    const rows = [
      ...(isAddress(a.darkCrossHook) ? [row("DarkCrossHook", a.darkCrossHook)] : []),
      ...(a.wrappers ?? []).flatMap((w) => [
        ...(isAddress(w.token) ? [row(`${w.platform ?? ""} wrapper · ${w.symbol ?? ""}`.trim(), w.token)] : []),
        ...(isAddress(w.adapter) ? [row(`${w.platform ?? ""} adapter`.trim(), w.adapter)] : []),
      ]),
    ];
    if (rows.length) groups.push({ title: a.symbol, rows });
  }
  if (isAddress(d?.faucet)) groups.push({ title: "Testnet", rows: [row("TestShareFaucet", d.faucet)] });
  return groups;
}

/** Transaction proofs recorded in the manifest ({ label, tx }[] or the older { swaps: [{ hash }] }). */
export function proofTxs(d: ProofDeployment | undefined) {
  const p = d?.proofs;
  const list = Array.isArray(p) ? p.map((x) => ({ label: x.label, hash: x.tx })) : (p?.swaps ?? []).map((x) => ({ label: x.label, hash: x.hash }));
  return list
    .filter((x): x is { label: string | undefined; hash: string } => typeof x.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(x.hash))
    .map((x) => ({ ...x, url: explorerUrl(NETWORK, "tx", x.hash)! }));
}
