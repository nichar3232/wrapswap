import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Mark, ThemeToggle } from "../brand";
import { proofSwaps, unichainFile } from "./flowData";
import { DevDiagram, SimpleFlow } from "./Flows";
import { Halftone } from "./Halftone";
import { OnePrice } from "./OnePrice";
import {
  EXPLORER,
  NETWORK_NAME,
  deployment,
  proofRows,
  short,
} from "./proof";
import "../theme.css";
import "./landing.css";

const GITHUB = "https://github.com/nichar3232/wrapswap";
type Link = { label: string; href: string; external?: boolean };
/** Each label scrolls to its section; its chevron opens a dropdown whose items navigate. */
const NAV: (Link & { menu: Link[] })[] = [
  {
    label: "Product",
    href: "#product",
    menu: [
      { label: "Portfolio", href: "/app?tab=portfolio" },
      { label: "Move", href: "/app?tab=move" },
      { label: "Liquidity", href: "/app?tab=liquidity" },
    ],
  },
  {
    label: "How it works",
    href: "#how-it-works",
    menu: [
      { label: "01 Instant move", href: "#how-move" },
      { label: "02 Sealed cross", href: "#how-sealed" },
      { label: "03 Liquidity", href: "#how-liquidity" },
    ],
  },
  {
    label: "Proof",
    href: "#proof",
    menu: [
      { label: "Deployed contracts", href: "#proof-contracts" },
      { label: "Uniscan ↗", href: EXPLORER, external: true },
    ],
  },
  {
    label: "Developers",
    href: "#developers",
    menu: [
      { label: "Call order", href: "#developers" },
      { label: "GitHub ↗", href: GITHUB, external: true },
    ],
  },
];
const ext = (l: Link) =>
  l.external ? { target: "_blank", rel: "noreferrer" } : {};
const STEPS = [
  {
    name: "Instant move",
    id: "move",
    tab: "move",
    title: "Parity fill.",
    body: "Move AAPL from one platform's wrapper to another's at oracle NAV, not pool price.",
  },
  {
    name: "Sealed cross",
    id: "sealed",
    tab: "move",
    title: "Batch-crossed flow.",
    body: "Large orders cross at the oracle mid in a sealed batch, off the public curve.",
  },
  {
    name: "Liquidity",
    id: "liquidity",
    tab: "liquidity",
    title: "Skew-aware fees.",
    body: "Fees lean against inventory imbalance so LPs aren't the exit.",
  },
];

function Chevron() {
  return (
    <svg className="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Film grain: an inline feTurbulence filter, no image assets. */
function Grain() {
  return (
    <svg className="grain" aria-hidden="true">
      <filter id="unison-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#unison-grain)" />
    </svg>
  );
}

function Nav() {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) =>
      ref.current?.contains(e.target as Node) || setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);
  const close = () => {
    setOpen(false);
    setMenu(null);
  };
  return (
    <header className="lnav" ref={ref}>
      <a className="logo-cell" href="/" aria-label="Unison home">
        <Mark size={24} />
      </a>
      <a className="wordmark" href="/">
        unison
      </a>
      <nav className={`lnav-items${open ? " open" : ""}`} aria-label="Sections">
        {NAV.map((item) => {
          const id = `menu-${item.href.slice(1)}`;
          const shown = menu === item.href;
          return (
            <div className="nav-item" key={item.href}>
              <a href={item.href} onClick={close}>
                {item.label}
              </a>
              <button
                type="button"
                className="chev-btn"
                aria-label={`${item.label} menu`}
                aria-expanded={shown}
                aria-controls={id}
                onClick={() => setMenu(shown ? null : item.href)}
              >
                <Chevron />
              </button>
              {shown && (
                <div className="dropdown" id={id}>
                  {item.menu.map((l) => (
                    <a key={l.href} href={l.href} onClick={close} {...ext(l)}>
                      {l.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="lnav-end">
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Menu
        </button>
        <ThemeToggle />
        <a className="launch" href="/app">
          Launch app
        </a>
      </div>
    </header>
  );
}

function Landing() {
  const hero = useRef<HTMLElement>(null);
  const rows = proofRows(deployment);
  return (
    <>
      <section className="hero" id="product" ref={hero}>
        <Grain />
        <div className="rules" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <Halftone host={hero} />
        <Nav />
        <div className="hero-copy">
          <h1>Unison</h1>
          <p>
            One price for every tokenized stock. Unison converts across issuers
            at NAV parity, natively on Uniswap v4 hooks.
          </p>
          <div className="ctas">
            <a className="launch" href="/app">
              Move your shares
            </a>
            <a className="ghost" href="#proof">
              See it onchain →
            </a>
          </div>
        </div>
      </section>

      <OnePrice />

      <section className="black how" id="how-it-works">
        <h2>How it works</h2>
        <ol className="steps3">
          {STEPS.map((s, i) => (
            <li key={s.id} id={`how-${s.id}`}>
              <span className="index">0{i + 1}</span>
              <h3>{s.name}</h3>
              <p>
                <strong>{s.title}</strong> {s.body}
              </p>
              <a href={`/app?tab=${s.tab}`}>Try it →</a>
            </li>
          ))}
        </ol>
        <SimpleFlow />
      </section>

      <section className="black developers" id="developers">
        <h2>Developers</h2>
        <DevDiagram />
        <p className="dev-links">
          <a href={GITHUB} target="_blank" rel="noreferrer">
            Source on GitHub ↗
          </a>
        </p>
      </section>

      <section className="black proof" id="proof">
        <h2>
          Live on {NETWORK_NAME}
          {deployment?.chainId && (
            <span className="chain">chain {deployment.chainId}</span>
          )}
        </h2>
        <div id="proof-contracts">
        <div className="table-wrap" hidden={rows.length === 0}>
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Address</th>
                <th>
                  <span className="sr-only">Explorer</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="mono" title={r.address}>
                    {short(r.address)}
                  </td>
                  <td className="link">
                    <a href={r.url} target="_blank" rel="noreferrer">
                      Uniscan ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
        {proofSwaps(unichainFile).length > 0 && (
          <div className="tx-cards" id="proof-swap">
            {proofSwaps(unichainFile).map((p, i) => (
              <a key={p.hash} className={`tx-card${i ? " secondary" : ""}`} href={p.url} target="_blank" rel="noreferrer">
                {p.label && <span className="tx-label">{p.label}</span>}
                <span className="mono tx-hash">{p.hash}</span>
                {p.caption && <span className="tx-caption">{p.caption}</span>}
                <span className="tx-go">
                  {p.block !== undefined ? `Block ${Number(p.block).toLocaleString("en-US")} · ` : ""}View on Uniscan ↗
                </span>
              </a>
            ))}
          </div>
        )}
      </section>

      <footer className="lfoot">
        <span className="brand">
          <Mark size={20} />
          unison
        </span>
        <span>Built at ETHGlobal Tokyo 2026 · Uniswap v4</span>
        <a href={GITHUB} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
