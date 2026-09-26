import { explorerUrl } from "@wrapswap/types";
import "./verify.css";

/**
 * The Verify footer on every page (landing and app): the deployed contracts, each linked to its explorer; the MCP
 * endpoint; the source. Addresses come from the committed manifests, never typed here.
 */
export const GITHUB = "https://github.com/nichar3232/wrapswap";
export const MCP_URL = "https://nichars-mac-mini.tail43cacc.ts.net/mcp";
export const CLAUDE_CODE_CMD = `claude mcp add unison --transport http ${MCP_URL}`;
const SUI_EXPLORER = "https://suiscan.xyz/testnet";

type Manifest = {
  contracts?: { parityHook?: string | null; wrapSwapRouter?: string | null };
  router?: string;
  assets?: { symbol: string; darkCrossHook?: string }[];
  send?: { shareVault?: string };
};
type SuiManifest = { sui?: { packageId?: string } };
// Globbed so the bundle still builds before a manifest lands.
const first = <T,>(m: Record<string, T>) => Object.values(m)[0];
const evm = first(import.meta.glob<Manifest>("../../deployments/unichain-sepolia.resolved.json", { eager: true, import: "default" }));
const sui = first(import.meta.glob<SuiManifest>("../../deployments/sui-testnet.json", { eager: true, import: "default" }));

const isEvm = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isSui = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

export type VerifyLink = { name: string; address: string; url: string };
/** ParityHook, DarkCross per asset, router, ShareVault (Unichain Sepolia), Sui package (Sui testnet); missing ones omitted. */
export function verifyLinks(d: Manifest | undefined = evm, s: SuiManifest | undefined = sui): VerifyLink[] {
  const unichain = (name: string, a: unknown) => (isEvm(a) ? [{ name, address: a, url: explorerUrl("unichain-sepolia", "address", a)! }] : []);
  const pkg = s?.sui?.packageId;
  return [
    ...unichain("ParityHook", d?.contracts?.parityHook),
    ...(d?.assets ?? []).flatMap((a) => unichain(`DarkCross ${a.symbol}`, a.darkCrossHook)),
    ...unichain("Router", d?.contracts?.wrapSwapRouter ?? d?.router),
    ...unichain("ShareVault", d?.send?.shareVault),
    ...(isSui(pkg) ? [{ name: "Sui package", address: pkg, url: `${SUI_EXPLORER}/object/${pkg}` }] : []),
  ];
}

const short = (hex: string) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

export function VerifyFooter() {
  const links = verifyLinks();
  return (
    <footer className="verify" id="verify" aria-labelledby="verify-h">
      <h2 id="verify-h">Verify</h2>
      <p className="verify-line" data-line="contracts">
        <span className="verify-k">Contracts</span>
        <span className="verify-v">
          {links.length === 0 && <span>Deployment addresses are being published.</span>}
          {links.map((l) => (
            <a key={l.name} href={l.url} target="_blank" rel="noreferrer" title={l.address}>
              {l.name} <span className="mono">{short(l.address)}</span> ↗
            </a>
          ))}
        </span>
      </p>
      <p className="verify-line" data-line="mcp">
        <span className="verify-k">MCP</span>
        <span className="verify-v">
          <code className="mono">{MCP_URL}</code>
          <code className="mono">{CLAUDE_CODE_CMD}</code>
        </span>
      </p>
      <p className="verify-line" data-line="source">
        <span className="verify-k">Source</span>
        <span className="verify-v">
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </span>
      </p>
    </footer>
  );
}
