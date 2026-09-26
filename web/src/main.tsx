import { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from "react";
import { createRoot } from "react-dom/client";
import { CHAINS, parseDeployment, type Deployment } from "@wrapswap/types";
import { Mark } from "./brand";
import { config } from "./config";
import { useApi, type FeedStatus } from "./hooks/useApi";
import { amount } from "./lib/format";
import { assetsOf } from "./app/assets";
import { Liquidity } from "./app/Liquidity";
import { Move } from "./app/Move";
import { Portfolio } from "./app/Portfolio";
import { SendOverview } from "./app/SendOverview";
import { Hex, Skeleton, shortHex } from "./app/ui";
import type { Token } from "./app/assets";
import { WalletProvider, useWallet } from "./app/wallet";
import { isDemo } from "./wallet";
import type { MoveIntent } from "./app/types";
import "./theme.css";
import "./style.css";

const TABS = ["Portfolio", "Move", "Send", "Liquidity"] as const;
type Tab = (typeof TABS)[number];
const TAB_PARAM: Record<Tab, string> = { Portfolio: "portfolio", Move: "move", Send: "send", Liquidity: "liquidity" };
/** Old links (?tab=convert|dark|pool) land on their new homes. */
const LEGACY: Record<string, Tab> = { convert: "Move", dark: "Move", pool: "Liquidity" };
const initialAsset = () => (new URLSearchParams(location.search).get("asset") ?? "").toUpperCase();
const initialTab = (): Tab => {
  const p = new URLSearchParams(location.search).get("tab") ?? "";
  return TABS.find((t) => TAB_PARAM[t] === p) ?? LEGACY[p] ?? "Portfolio";
};
const CHAIN = CHAINS[config.network];

// When the API is unreachable the app still knows its contracts from the committed manifest.
const bundled = import.meta.glob<unknown>("../../deployments/unichain-sepolia.resolved.json", {
  eager: true,
  import: "default",
});
const fallbackDeployment = (() => {
  if (config.useMocks || config.network !== "unichain-sepolia") return undefined;
  try {
    const raw = Object.values(bundled)[0];
    return raw ? parseDeployment(raw) : undefined;
  } catch {
    return undefined;
  }
})();

type FeedRow = { name: string; status: FeedStatus; healthy?: boolean };

/** The one network badge: Unichain Sepolia, with its health as a dot; details on click. */
function NetworkBadge({ feeds }: { feeds: FeedRow[] }) {
  const [open, setOpen] = useState(false);
  const down = feeds.filter((f) => f.status !== "ok" || f.healthy === false);
  const nothing = feeds.every((f) => f.status === "loading" || f.status === "unavailable");
  const state = nothing ? "connecting" : down.length ? "degraded" : "live";
  const word: Record<FeedStatus, string> = {
    ok: "live",
    stale: "stale · retrying",
    loading: "connecting…",
    unavailable: "unavailable · retrying",
  };
  return (
    <div className="status-wrap">
      <button
        type="button"
        className={`status-pill ${state}`}
        aria-expanded={open}
        aria-controls="feed-status"
        onClick={() => setOpen(!open)}
        data-testid="status-pill"
        title={state === "connecting" ? "Connecting…" : state === "degraded" ? `Degraded: ${down.map((f) => f.name).join(", ")}` : "All feeds live"}
      >
        <span className="status-dot" aria-hidden="true" />
        {CHAIN.name}
        {state === "connecting" ? <span className="muted"> · connecting…</span> : state === "degraded" ? <span> · degraded</span> : null}
      </button>
      {open && (
        <ul className="feed-list" id="feed-status">
          {feeds.map((f) => (
            <li key={f.name}>
              <span>{f.name}</span>
              <span className={f.status === "ok" && f.healthy !== false ? "good" : f.status === "loading" ? "muted" : "warn"}>
                {f.healthy === false && f.status === "ok" ? "reporting unhealthy" : word[f.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Account({ tokens }: { tokens: Token[] }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!w.address)
    return (
      <button className="primary connect" disabled={w.busy === "connect"} aria-label="Connect wallet" onClick={() => void w.connect()}>
        {w.busy === "connect" ? "Connecting…" : "Connect"}
      </button>
    );
  if (w.wrongChain)
    return (
      <button className="warn-btn" disabled={w.busy === "switch"} onClick={() => void w.switchChain()}>
        {w.busy === "switch" ? "Switching…" : `Switch to ${w.expected.name}`}
      </button>
    );
  return (
    <div className="account" ref={ref}>
      <button
        type="button"
        className="account-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Account ${shortHex(w.address)}`}
        onClick={() => setOpen(!open)}
      >
        <span className="ok-dot" aria-hidden="true" />
        <span className="mono">{shortHex(w.address)}</span>
      </button>
      {open && (
        <div className="account-menu" role="dialog" aria-label="Wallet">
          <div className="acct-row">
            <Hex value={w.address} />
            {w.simulated && <span className="chip">simulated</span>}
            {w.relay && <span className="chip">demo relay</span>}
          </div>
          <dl>
            {tokens.map((t) => (
              <div key={t.address} className="acct-bal">
                <dt>{t.symbol}</dt>
                <dd>
                  {w.balances.status === "ok" ? (
                    amount(w.balances.values[t.address] ?? 0n, t.decimals, 4)
                  ) : w.balances.status === "loading" ? (
                    <Skeleton w="4em" />
                  ) : (
                    <span className="val-na">
                      — <small>unavailable</small>
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="acct-net">
            <span className="ok-dot" aria-hidden="true" /> {w.expected.name}
          </p>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              w.disconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function App() {
  const deployment = useApi("deployment");
  const health = useApi("health"),
    crank = useApi("crankStatus");
  const d = deployment.data ?? fallbackDeployment;
  const assetsFeed = useApi("assets", "", 30000);
  const assets = assetsOf(assetsFeed.data, d);
  const tokens = assets.flatMap((a) => a.platforms.map((p) => p.token));
  // The global asset: every panel reads and acts on this one (?asset= keeps it across reloads).
  const [assetSym, setAssetSym] = useState(initialAsset);
  const asset = assets.find((a) => a.symbol === assetSym) ?? assets[0];
  const pool = useApi("poolAsset", asset ? asset.symbol : null, 8000);
  const batch = useApi("currentBatch", asset?.darkCross ? `asset=${asset.symbol}` : null, 2000);
  const chooseAsset = (sym: string) => {
    setAssetSym(sym);
    const u = new URL(location.href);
    u.searchParams.set("asset", sym);
    history.replaceState(null, "", u);
  };
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [intent, setIntent] = useState<MoveIntent>();
  const moveFrom = (fromToken: string, mode: MoveIntent["mode"] = "convert") => {
    const owner = assets.find((a) => a.platforms.some((p) => p.token.address.toLowerCase() === fromToken.toLowerCase()));
    if (owner && owner.symbol !== asset?.symbol) chooseAsset(owner.symbol);
    setIntent({ fromToken, mode, nonce: Date.now() });
    setTab("Move");
  };
  const index = TABS.indexOf(tab);
  const setTab = (t: Tab) => {
    setTabState(t);
    const u = new URL(location.href);
    u.searchParams.set("tab", TAB_PARAM[t]);
    history.replaceState(null, "", u);
  };
  const step = (dir: 1 | -1) => {
    const next = TABS[index + dir];
    if (next) setTab(next);
  };

  // Rewrite legacy ?tab= values to the panel they now open.
  useEffect(() => {
    const u = new URL(location.href);
    if (u.searchParams.get("tab") !== TAB_PARAM[tab]) {
      u.searchParams.set("tab", TAB_PARAM[tab]);
      history.replaceState(null, "", u);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ←/→ switch panels (not while typing or adjusting a slider).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, select, textarea, [contenteditable=true]")) return;
      step(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Trackpad horizontal swipe: one panel per gesture.
  const wheel = useRef({ acc: 0, until: 0 });
  const onWheel = (e: ReactWheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) return;
    const w = wheel.current,
      now = performance.now();
    if (now < w.until) return;
    w.acc += e.deltaX;
    if (Math.abs(w.acc) > 60) {
      step(w.acc > 0 ? 1 : -1);
      w.acc = 0;
      w.until = now + 650;
    }
  };

  // The nav indicator slides under the active tab.
  const navRef = useRef<HTMLElement>(null);
  const [bar, setBar] = useState({ left: 0, width: 0 });
  useEffect(() => {
    const place = () => {
      const b = navRef.current?.querySelectorAll("button")[index] as HTMLElement | undefined;
      if (b) setBar({ left: b.offsetLeft, width: b.offsetWidth });
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [index]);

  const feeds: FeedRow[] = [
    // The bundled manifest keeps the UI rendering but is not a live feed, so it never counts as loaded.
    { name: "Deployment", status: deployment.status },
    { name: "Network", status: health.status, healthy: health.data?.ok },
    { name: "Assets", status: assetsFeed.status },
    { name: `${asset?.symbol ?? ""} pool`.trim(), status: pool.status },
    { name: "Dark Cross batches", status: batch.status },
    { name: "Crank", status: crank.status, healthy: crank.data?.ok },
  ];
  const demo = isDemo();
  const still = reducedMotion();
  return (
    <WalletProvider d={d} tokens={tokens}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="nav">
        <a className="wordmark" href="/">
          <Mark />
          unison
        </a>
        <nav aria-label="Main navigation" ref={navRef}>
          {TABS.map((t) => (
            <button key={t} className={tab === t ? "active" : ""} aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
          <span className={`tab-bar${still ? " still" : ""}`} style={{ transform: `translateX(${bar.left}px)`, width: bar.width }} aria-hidden="true" />
        </nav>
        <div className="wallet">
          <div className="asset-pick" role="radiogroup" aria-label="Asset">
            {assets.map((a) => (
              <button key={a.symbol} type="button" role="radio" aria-checked={a === asset} onClick={() => chooseAsset(a.symbol)}>
                {a.symbol}
              </button>
            ))}
          </div>
          <NetworkBadge feeds={feeds} />
          {demo && (
            <span
              className="badge demo"
              title={config.useMocks ? "Mock data (test build): nothing is sent onchain." : "Demo relay: a server-side test wallet signs real Unichain Sepolia transactions."}
            >
              Demo
            </span>
          )}
          <Account tokens={tokens} />
        </div>
      </header>
      <main id="main" className="app-main" onWheel={onWheel}>
        <h1 className="sr-only">{tab}</h1>
        <div className={`track${still ? " still" : ""}`} style={{ transform: `translateX(${-index * 100}%)` }}>
          {TABS.map((t, i) => (
            <section key={t} className="panel" aria-label={t} inert={i !== index} aria-hidden={i !== index} data-panel={TAB_PARAM[t]}>
              <div className="panel-inner">
                {t === "Portfolio" ? (
                  <Portfolio d={d} assets={assets} onMove={moveFrom} />
                ) : t === "Move" ? (
                  <Move d={d} asset={asset} pool={pool} batch={batch} intent={intent} />
                ) : t === "Send" ? (
                  <SendOverview d={d} assets={assets} />
                ) : (
                  <Liquidity asset={asset} pool={pool} onMove={moveFrom} />
                )}
              </div>
            </section>
          ))}
        </div>
      </main>
    </WalletProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
