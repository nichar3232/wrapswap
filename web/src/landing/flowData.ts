import { explorerUrl } from "@wrapswap/types";

/** Raw deployment JSON as committed; every field optional so a partial or missing file never breaks the page. */
export type UnichainFile = {
  chainId?: number;
  contracts?: Partial<Record<string, string | null>>;
  tokens?: { symbol?: string; issuer?: string; address?: string; underlying?: string }[];
};
export type SuiFile = Record<string, unknown>;

// Globbed so the build passes before either file lands.
const unichainFiles = import.meta.glob<UnichainFile>("../../../deployments/unichain-sepolia.resolved.json", { eager: true, import: "default" });
const suiFiles = import.meta.glob<SuiFile>("../../../deployments/sui-testnet.json", { eager: true, import: "default" });
export const unichainFile: UnichainFile | undefined = Object.values(unichainFiles)[0];
export const suiFile: SuiFile | undefined = Object.values(suiFiles)[0];
export const SUI_EXPLORER = "https://suiscan.xyz/testnet";

const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isSuiId = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v);

/** First Sui id found under any of the keys, at the top level or inside objects/contracts. */
export function suiLookup(s: SuiFile | undefined, keys: string[]) {
  if (!s) return undefined;
  const scopes = [s, s.objects, s.contracts].filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  for (const scope of scopes) for (const k of keys) if (isSuiId(scope[k])) return scope[k] as string;
  return undefined;
}

export type FlowNode = { id: string; does: string; contract: string; sub?: string; href: string | null; accent?: boolean };
export type Lane = { id: "uniswap" | "dark" | "sui"; label: string; nodes: FlowNode[]; secondary?: boolean };

/**
 * Developers diagram: v4's real call order. Main lane: user → WrapSwapRouter → PoolManager.swap →
 * ParityHook.beforeSwap (adapters + oracle; fills from ERC-6909 inventory via beforeSwapReturnDelta) → delta settled.
 * Dark Cross and Sui are separate small lanes. Nodes say what they do for the user first, contract second.
 */
export function devLanes(u: UnichainFile | undefined, s: SuiFile | undefined): Lane[] {
  const c = u?.contracts ?? {};
  const link = (v: unknown) => (isAddress(v) ? explorerUrl("unichain-sepolia", "address", v) : null);
  const evm = s?.evm && typeof s.evm === "object" ? (s.evm as Record<string, unknown>) : undefined;
  const suiObject = (id?: string) => (id ? `${SUI_EXPLORER}/object/${id}` : null);
  return [
    {
      id: "uniswap",
      label: "Unichain Sepolia · Uniswap v4",
      nodes: [
        { id: "user", does: "You start a move", contract: "your wallet", href: null },
        { id: "router", does: "Checks and routes the swap", contract: "WrapSwapRouter.swapExactIn", href: link(c.wrapSwapRouter) },
        { id: "pm", does: "Runs the v4 swap", contract: "PoolManager.swap", href: link(c.poolManager) },
        {
          id: "parity",
          does: "Prices at NAV, fills from inventory",
          contract: "ParityHook.beforeSwap",
          sub: "adapters + oracle · ERC-6909 inventory via beforeSwapReturnDelta",
          href: link(c.parityHook),
          accent: true,
        },
        { id: "settle", does: "Balances settle", contract: "PoolManager delta settled", href: link(c.poolManager) },
      ],
    },
    {
      id: "dark",
      label: "Dark Cross",
      nodes: [
        { id: "commit", does: "Seal your order", contract: "DarkCrossHook.commit", href: link(c.darkCrossHook) },
        { id: "cross", does: "Cross at the oracle mid", contract: "DarkCrossHook.settle", href: link(c.darkCrossHook) },
        { id: "residual", does: "Residual through the pool", contract: "PoolManager", href: link(c.poolManager) },
      ],
    },
    {
      id: "sui",
      label: "Sui testnet · confidential payments",
      secondary: true,
      nodes: [
        { id: "vault", does: "Deposit shares", contract: "ShareVault (Unichain)", href: link(evm?.shareVault) },
        {
          id: "pay",
          does: "Pay privately",
          contract: "Unison Pay · Sui pool",
          sub: "keeper batches every 90 s",
          href: suiObject(suiLookup(s, ["pool", "poolId", "payPool", "unisonPay"])),
        },
        { id: "withdraw", does: "Recipient withdraws", contract: "WrapSwapRouter", href: link(c.wrapSwapRouter) },
      ],
    },
  ];
}
