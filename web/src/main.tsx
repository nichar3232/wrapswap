import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CHAINS, parseDeployment, type Deployment } from "@wrapswap/types";
import { Mark } from "./brand";
import { config } from "./config";
import { useApi, type FeedStatus } from "./hooks/useApi";
import { amount } from "./lib/format";
import { Convert } from "./app/Convert";
import { DarkCross } from "./app/DarkCross";
import { Pool } from "./app/Pool";
import { Hex, Skeleton, shortHex } from "./app/ui";
import { WalletProvider, useWallet } from "./app/wallet";
import { isDemo } from "./wallet";
import "./theme.css";
import "./style.css";

const TABS = ["Convert", "Dark Cross", "Pool"] as const;
type Tab = (typeof TABS)[number];
const TAB_PARAM: Record<Tab, string> = { Convert: "convert", "Dark Cross": "dark", Pool: "pool" };
const initialTab = (): Tab =>
  TABS.find((t) => TAB_PARAM[t] === new URLSearchParams(location.search).get("tab")) ?? "Convert";
const CHAIN = CHAINS[config.network];

// When the API is unreachable the app still knows its contracts from the committed manifest.
const bundled = import.meta.glob<unknown>("../../deployments/unichain-sepolia.json", {
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

function Account({ d }: { d: Deployment | undefined }) {
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
          </div>
          <dl>
            {d?.tokens.map((t) => (
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

function App() {
  const deployment = useApi("deployment");
  const health = useApi("health"),
    nyse = useApi("nyse"),
    fees = useApi("fees"),
    pool = useApi("pool"),
    crank = useApi("crankStatus");
  const d = deployment.data ?? fallbackDeployment;
  const [tab, setTabState] = useState<Tab>(initialTab);
  const setTab = (t: Tab) => {
    setTabState(t);
    const u = new URL(location.href);
    u.searchParams.set("tab", TAB_PARAM[t]);
    history.replaceState(null, "", u);
  };
  const feeds: FeedRow[] = [
    // The bundled manifest keeps the UI rendering but is not a live feed, so it never counts as loaded.
    { name: "Deployment", status: deployment.status },
    { name: "Network", status: health.status, healthy: health.data?.ok },
    { name: "NYSE calendar", status: nyse.status },
    { name: "Fees", status: fees.status },
    { name: "Peg guard", status: pool.status },
    { name: "Crank", status: crank.status, healthy: crank.data?.ok },
  ];
  const demo = isDemo();
  return (
    <WalletProvider d={d}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="nav">
        <a className="wordmark" href="/">
          <Mark />
          unison
        </a>
        <nav aria-label="Main navigation">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? "active" : ""} aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="wallet">
          <NetworkBadge feeds={feeds} />
          {demo && (
            <span
              className="badge demo"
              title={config.useMocks ? "Demo data and a simulated wallet: nothing is sent onchain." : "No wallet detected: a simulated wallet runs every flow. Connect a real wallet to transact."}
            >
              Demo
            </span>
          )}
          <Account d={d} />
        </div>
      </header>
      <main id="main" className="app-main">
        <h1 className="sr-only">{tab}</h1>
        {tab === "Convert" ? <Convert d={d} pool={pool} /> : tab === "Dark Cross" ? <DarkCross d={d} /> : <Pool d={d} fees={fees} nyse={nyse} />}
      </main>
    </WalletProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
