import { explorerUrl } from "@wrapswap/types";

/** Raw deployment JSON as committed; every field is optional so a partial or missing file never breaks the page. */
export type UnichainFile = {
  contracts?: Partial<Record<string, string | null>>;
  tokens?: { symbol?: string; issuer?: string; address?: string }[];
};
export type SuiFile = Record<string, unknown>;

// Globbed so the build passes before either file lands.
const unichainFiles = import.meta.glob<UnichainFile>(
  "../../../deployments/unichain-sepolia.json",
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
  kick?: string;
  zone: "unichain" | "sui";
  accent?: boolean;
  href: string | null;
};
export type Edge = {
  from: string;
  to: string;
  label: string;
  /** "zone" edges cross between the two zones: horizontal in the wide layout, vertical in the stacked one. */
  dir: "h" | "v" | "zone";
  /** Vertical offset at the source / target anchor, to fan several edges into one side. */
  fo?: number;
  to_?: number;
  /** The same fan-out for vertical edges, as horizontal offsets. */
  fx?: number;
  tx?: number;
};
export type Layout = {
  width: number;
  height: number;
  nodes: Node[];
  edges: (Edge & { d: string; mid: [number, number] })[];
  /** Hover/hit area of the Sui zone (nothing is drawn for it). */
  suiZone: { w: number; h: number };
  /** Baseline of each zone caption. */
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

/**
 * The high-level product flow only. Issuer tokens go through the router to one of two hooks and settle on the
 * Uniswap v4 PoolManager; Unison Pay (Sui) deposits from and withdraws to issuer tokens. Adapters, oracle,
 * inventory claims, the vault and the keeper are implementation detail and deliberately left out.
 * No default arguments: callers pass the manifests (or fixtures) explicitly.
 */
export function diagramNodes(u: UnichainFile | undefined, s: SuiFile | undefined) {
  const c = u?.contracts ?? {};
  const link = (v: unknown) =>
    isAddress(v) ? explorerUrl("unichain-sepolia", "address", v) : null;
  const suiObject = (id?: string) => (id ? `${SUI_EXPLORER}/object/${id}` : null);

  // Wide layout coordinates; the stacked layout is derived in layout().
  const n: Node[] = [
    { id: "pay", title: "Unison Pay", zone: "sui", x: 24, y: 80, w: 148, h: 64, href: suiObject(suiLookup(s, ["pool", "poolId", "payPool", "unisonPay"])) },
    { id: "issuers", title: "Issuer tokens", zone: "unichain", x: 260, y: 80, w: 156, h: 64, href: null },
    { id: "router", title: "WrapSwapRouter", zone: "unichain", x: 498, y: 80, w: 168, h: 64, href: link(c.wrapSwapRouter) },
    { id: "parity", title: "ParityHook", zone: "unichain", accent: true, x: 742, y: 8, w: 168, h: 64, href: link(c.parityHook) },
    { id: "dark", title: "DarkCrossHook", zone: "unichain", x: 742, y: 152, w: 168, h: 64, href: link(c.darkCrossHook) },
    { id: "pm", kick: "UNISWAP v4", title: "PoolManager", zone: "unichain", x: 998, y: 80, w: 148, h: 64, href: link(c.poolManager) },
  ];
  const e: Edge[] = [
    { from: "issuers", to: "router", label: "CONVERT", dir: "h" },
    { from: "router", to: "parity", label: "PARITY", dir: "h" },
    { from: "router", to: "dark", label: "BATCH", dir: "h" },
    { from: "parity", to: "pm", label: "SWAP", dir: "h" },
    { from: "dark", to: "pm", label: "RESIDUAL", dir: "h" },
    { from: "issuers", to: "pay", label: "DEPOSIT", dir: "zone", fo: -12, to_: -12, fx: -40, tx: -40 },
    { from: "pay", to: "issuers", label: "WITHDRAW", dir: "zone", fo: 12, to_: 12, fx: 40, tx: 40 },
  ];
  return { nodes: n, edges: e };
}

/** Edge labels: 10px uppercase with 0.08em tracking (about 0.68em per character), plus chip padding. */
export const chipWidth = (label: string) =>
  Math.round(label.length * 10 * 0.68 + 14);

/** Rounded corner radius of the right-angle connectors. */
const CORNER = 10;

function edgePath(e: Edge, a: Rect, b: Rect): { d: string; mid: [number, number] } {
  if (e.dir === "v") {
    const lo = Math.max(a.x, b.x), hi = Math.min(a.x + a.w, b.x + b.w);
    const x = (lo < hi ? (lo + hi) / 2 : a.x + a.w / 2) + (e.fx ?? 0);
    const x3 = (lo < hi ? (lo + hi) / 2 : b.x + b.w / 2) + (e.tx ?? 0);
    const down = b.y > a.y;
    const y0 = down ? a.y + a.h : a.y,
      y3 = down ? b.y : b.y + b.h;
    const my = (y0 + y3) / 2;
    if (x === x3) return { d: `M${x} ${y0} V${y3}`, mid: [x, my] };
    const s = Math.sign(x3 - x), sy = Math.sign(y3 - y0);
    const r = Math.min(CORNER, Math.abs(x3 - x) / 2, Math.abs(y3 - y0) / 4);
    return {
      d: `M${x} ${y0} V${my - sy * r} Q${x} ${my} ${x + s * r} ${my} H${x3 - s * r} Q${x3} ${my} ${x3} ${my + sy * r} V${y3}`,
      mid: [(x + x3) / 2, my],
    };
  }
  const right = b.x > a.x;
  const x0 = right ? a.x + a.w : a.x,
    x3 = right ? b.x : b.x + b.w;
  const y0 = a.y + a.h / 2 + (e.fo ?? 0),
    y3 = b.y + b.h / 2 + (e.to_ ?? 0);
  const mx = (x0 + x3) / 2;
  if (y0 === y3) return { d: `M${x0} ${y0} H${x3}`, mid: [mx, y0] };
  const dir = Math.sign(x3 - x0), sy = Math.sign(y3 - y0);
  const r = Math.min(CORNER, Math.abs(y3 - y0) / 2, Math.abs(x3 - x0) / 4);
  return {
    d: `M${x0} ${y0} H${mx - dir * r} Q${mx} ${y0} ${mx} ${y0 + sy * r} V${y3 - sy * r} Q${mx} ${y3} ${mx + dir * r} ${y3} H${x3}`,
    mid: [mx, (y0 + y3) / 2],
  };
}

/** "wide": zones side by side (Sui on the left). "stacked": Sui on top, Unichain below. Tight to the content. */
export function layout(kind: "wide" | "stacked", data: ReturnType<typeof diagramNodes>): Layout {
  const place = (n: Node): Node => {
    if (kind === "wide") return n;
    if (n.zone === "sui") return { ...n, x: 24, y: 44 };
    return { ...n, x: n.x - 236, y: n.y + 112 };
  };
  const nodes = data.nodes.map(place);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = data.edges.map((e) => {
    const dir = e.dir === "zone" ? (kind === "wide" ? "h" : "v") : e.dir;
    return { ...e, dir, ...edgePath({ ...e, dir }, byId[e.from], byId[e.to]) } as Layout["edges"][number];
  });
  return kind === "wide"
    ? {
        width: 1170,
        height: 220,
        nodes,
        edges,
        suiZone: { w: 216, h: 220 },
        zoneLabels: { sui: [24, 67], unichain: [260, 67] },
      }
    : {
        width: 934,
        height: 332,
        nodes,
        edges,
        suiZone: { w: 934, h: 170 },
        zoneLabels: { sui: [24, 27], unichain: [232, 143] },
      };
}
