import { explorerUrl } from "@wrapswap/types";

/** Raw deployment JSON as committed; every field is optional so a partial or missing file never breaks the page. */
export type UnichainFile = {
  contracts?: Partial<Record<string, string | null>>;
  tokens?: { symbol?: string; issuer?: string; address?: string }[];
};
export type SuiFile = Record<string, unknown>;

// Globbed so the build passes before either file lands.
const unichainFiles = import.meta.glob<UnichainFile>(
  "../../../deployments/unichain-sepolia.resolved.json",
  { eager: true, import: "default" },
);
const suiFiles = import.meta.glob<SuiFile>(
  "../../../deployments/sui-testnet.json",
  { eager: true, import: "default" },
);
export const unichainFile: UnichainFile | undefined =
  Object.values(unichainFiles)[0];
export const suiFile: SuiFile | undefined = Object.values(suiFiles)[0];

export const SUI_EXPLORER = "https://suiscan.xyz/testnet";

export type Rect = { x: number; y: number; w: number; h: number };
export type Node = Rect & {
  id: string;
  title: string;
  sub?: string;
  kick?: string;
  zone: "unichain" | "sui";
  accent?: boolean;
  group?: boolean;
  href: string | null;
};
export type Edge = {
  from: string;
  to: string;
  label: string;
  dir: "h" | "v";
  /** Vertical offset at the source / target anchor, to fan several edges into one side. */
  fo?: number;
  to_?: number;
};
export type Layout = {
  width: number;
  height: number;
  nodes: Node[];
  edges: (Edge & { d: string; mid: [number, number] })[];
  divider: { x1: number; y1: number; x2: number; y2: number };
  zoneLabels: { unichain: [number, number]; sui: [number, number] };
};

const isAddress = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isSuiId = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v);

/** First Sui id found under any of the keys, at the top level or inside objects/contracts. */
export function suiLookup(s: SuiFile | undefined, keys: string[]) {
  if (!s) return undefined;
  const scopes = [s, s.objects, s.contracts].filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object",
  );
  for (const scope of scopes)
    for (const k of keys) if (isSuiId(scope[k])) return scope[k] as string;
  return undefined;
}

/** A CanonicalStock / uAAPL contract (or token) in the deployment switches the centre node to the vault. */
export function hasCanonicalVault(u: UnichainFile | undefined) {
  if (!u) return false;
  const keyed = Object.entries(u.contracts ?? {}).some(
    ([k, v]) => /canonical|uaapl/i.test(k) && isAddress(v),
  );
  return keyed || !!u.tokens?.some((t) => /^uAAPL$/i.test(t.symbol ?? ""));
}

/** No default arguments: callers pass the manifests (or fixtures) explicitly. */
export function diagramNodes(u: UnichainFile | undefined, s: SuiFile | undefined) {
  const c = u?.contracts ?? {};
  const link = (v: unknown) =>
    isAddress(v) ? explorerUrl("unichain-sepolia", "address", v) : null;
  const token = (issuer: string) => u?.tokens?.find((t) => t.issuer === issuer)?.address;
  const vault = hasCanonicalVault(u);
  const canonical = Object.entries(c).find(([k]) => /canonical|uaapl/i.test(k))?.[1] ??
    u?.tokens?.find((t) => /^uAAPL$/i.test(t.symbol ?? ""))?.address;
  // ShareVault lives on Unichain but ships with the Sui payments deployment (sui-testnet.json → evm.shareVault).
  const evm = s?.evm && typeof s.evm === "object" ? (s.evm as Record<string, unknown>) : undefined;
  const suiObject = (id?: string) => (id ? `${SUI_EXPLORER}/object/${id}` : null);
  const suiAccount = (id?: string) => (id ? `${SUI_EXPLORER}/account/${id}` : null);

  // One layout: Unichain zone on top (primary), Sui zone below the divider; ShareVault straddles the divider.
  const n: Node[] = [
    { id: "issuers", title: "Issuer tokens", zone: "unichain", group: true, x: 24, y: 150, w: 196, h: 226, href: null },
    { id: "aaplc", title: "AAPLc", sub: "Coinbase B20", zone: "unichain", x: 38, y: 178, w: 168, h: 56, href: link(token("coinbase")) },
    { id: "aaplx", title: "AAPLx", sub: "Backed xStocks", zone: "unichain", x: 38, y: 294, w: 168, h: 56, href: link(token("xstocks")) },
    { id: "oracle", title: "Oracle · 30-min midpoint", sub: "mock on testnet", zone: "unichain", x: 300, y: 70, w: 210, h: 56, href: link(c.oracle) },
    vault
      ? { id: "center", kick: "CANONICAL VAULT", title: "uAAPL", sub: "minted 1:1 per share", zone: "unichain", x: 300, y: 205, w: 210, h: 74, href: link(canonical) }
      : { id: "center", kick: "SHARE MATH", title: "Multiplier adapters", sub: "via IssuerRegistry", zone: "unichain", x: 300, y: 205, w: 210, h: 74, href: link(c.registry) },
    { id: "router", title: "WrapSwapRouter", sub: "entry · swapExactIn", zone: "unichain", x: 300, y: 340, w: 210, h: 56, href: link(c.wrapSwapRouter) },
    { id: "dark", title: "DarkCrossHook", sub: "sealed-batch cross", zone: "unichain", x: 600, y: 68, w: 200, h: 60, href: link(c.darkCrossHook) },
    { id: "parity", title: "ParityHook", sub: "share-parity fill", zone: "unichain", accent: true, x: 600, y: 338, w: 200, h: 60, href: link(c.parityHook) },
    { id: "pm", kick: "UNISWAP v4", title: "PoolManager", zone: "unichain", x: 890, y: 209, w: 206, h: 66, href: link(c.poolManager) },
    { id: "claims", title: "ERC-6909", sub: "inventory claims", zone: "unichain", x: 890, y: 338, w: 206, h: 56, href: link(c.poolManager) },
    { id: "shareVault", title: "ShareVault", sub: "on Unichain", zone: "unichain", x: 24, y: 442, w: 180, h: 56, href: link(evm?.shareVault) },
    { id: "seal", title: "Seal + Walrus", sub: "encrypted balances & instructions", zone: "sui", x: 240, y: 520, w: 232, h: 56, href: suiObject(suiLookup(s, ["seal", "sealPolicy", "sealPolicyId", "sealPackage", "sealPackageId"])) },
    { id: "pool", title: "Unison Pay · Sui pool", sub: "root + total only", zone: "sui", x: 540, y: 520, w: 232, h: 56, href: suiObject(suiLookup(s, ["pool", "poolId", "payPool", "unisonPay"])) },
    { id: "keeper", title: "Keeper", sub: "batch every 90 s", zone: "sui", x: 840, y: 520, w: 232, h: 56, href: suiAccount(suiLookup(s, ["keeper", "keeperAddress"])) },
  ];
  const e: Edge[] = [
    { from: "aaplc", to: "center", label: vault ? "WRAP 1:1" : "NORMALIZE", dir: "h", to_: -8 },
    { from: "aaplx", to: "center", label: vault ? "WRAP 1:1" : "NORMALIZE", dir: "h", to_: 8 },
    { from: "issuers", to: "shareVault", label: "DEPOSIT", dir: "v" },
    { from: "shareVault", to: "router", label: "WITHDRAW · cross-issuer", dir: "h", fo: -12 },
    { from: "router", to: "parity", label: "EXACT-IN", dir: "h", to_: 8 },
    { from: "center", to: "parity", label: "PARITY", dir: "h", fo: 10, to_: -8 },
    { from: "center", to: "dark", label: "BATCH", dir: "h", fo: -10, to_: 8 },
    { from: "oracle", to: "dark", label: "MID", dir: "h", to_: -8 },
    { from: "parity", to: "pm", label: "SWAP", dir: "h", to_: -8 },
    { from: "dark", to: "pm", label: "RESIDUAL", dir: "h", to_: 8 },
    { from: "pm", to: "claims", label: "CLAIMS", dir: "v" },
    { from: "seal", to: "pool", label: "ENCRYPT", dir: "h" },
    { from: "keeper", to: "pool", label: "APPLY", dir: "h" },
  ];
  return { nodes: n, edges: e, vault };
}

/** Mono edge labels: 9.5px JetBrains Mono (0.6em advance) + 0.08em tracking, plus chip padding. */
export const chipWidth = (label: string) =>
  Math.round(label.length * 9.5 * 0.68 + 14);

function edgePath(e: Edge, a: Rect, b: Rect): { d: string; mid: [number, number] } {
  if (e.dir === "v") {
    const lo = Math.max(a.x, b.x), hi = Math.min(a.x + a.w, b.x + b.w);
    const x = lo < hi ? (lo + hi) / 2 : a.x + a.w / 2;
    const down = b.y > a.y;
    const y0 = down ? a.y + a.h : a.y,
      y3 = down ? b.y : b.y + b.h;
    const x3 = lo < hi ? x : b.x + b.w / 2;
    const my = (y0 + y3) / 2;
    return {
      d: `M${x} ${y0} C${x} ${my} ${x3} ${my} ${x3} ${y3}`,
      mid: [(x + x3) / 2, my],
    };
  }
  const right = b.x > a.x;
  const x0 = right ? a.x + a.w : a.x,
    x3 = right ? b.x : b.x + b.w;
  const y0 = a.y + a.h / 2 + (e.fo ?? 0),
    y3 = b.y + b.h / 2 + (e.to_ ?? 0);
  const mx = (x0 + x3) / 2;
  return {
    d: `M${x0} ${y0} C${mx} ${y0} ${mx} ${y3} ${x3} ${y3}`,
    mid: [mx, (y0 + y3) / 2],
  };
}

/** The diagram's single layout: Unichain on top, Sui below a horizontal divider that ShareVault straddles. */
export function layout(data: ReturnType<typeof diagramNodes>): Layout {
  const byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
  const edges = data.edges.map((e) => ({ ...e, ...edgePath(e, byId[e.from], byId[e.to]) }));
  return {
    width: 1120,
    height: 600,
    nodes: data.nodes,
    edges,
    divider: { x1: 16, y1: 470, x2: 1104, y2: 470 },
    zoneLabels: { unichain: [24, 36], sui: [240, 504] },
  };
}
