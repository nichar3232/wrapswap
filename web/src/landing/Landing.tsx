import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Mark, ThemeToggle } from "../brand";
import { explorerUrl } from "@wrapswap/types";
import { Diagram } from "./Diagram";
import { Halftone } from "./Halftone";
import { OnePrice } from "./OnePrice";
import {
  EXPLORER,
  NETWORK_NAME,
  PROOF_SWAP_TX,
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
      { label: "Convert", href: "/app?tab=convert" },
      { label: "Pool", href: "/app?tab=pool" },
      { label: "Dark Cross", href: "/app?tab=dark" },
    ],
  },
  {
    label: "How it works",
    href: "#how-it-works",
    menu: [
      { label: "01 Convert", href: "#how-convert" },
      { label: "02 Pool", href: "#how-pool" },
      { label: "03 Dark Cross", href: "#how-dark" },
    ],
  },
  {
    label: "Proof",
    href: "#proof",
    menu: [
      { label: "Deployed contracts", href: "#proof-contracts" },
      ...(PROOF_SWAP_TX ? [{ label: "Router swap", href: "#proof-swap" }] : []),
      { label: "Uniscan ↗", href: EXPLORER, external: true },
    ],
  },
  {
    label: "Developers",
    href: "#developers",
    menu: [
      { label: "GitHub ↗", href: GITHUB, external: true },
      { label: "Deployed contracts", href: "#proof-contracts" },
    ],
  },
];
const ext = (l: Link) =>
  l.external ? { target: "_blank", rel: "noreferrer" } : {};
const STEPS = [
  {
    name: "Convert",
    tab: "convert",
    title: "Parity fill.",
    body: "Swap one issuer's AAPL wrapper for another's at oracle NAV, not pool price.",
  },
  {
    name: "Pool",
    tab: "pool",
    title: "Skew-aware liquidity.",
    body: "Fees lean against inventory imbalance so LPs aren't the exit.",
  },
  {
    name: "Dark Cross",
    tab: "dark",
    title: "Batch-crossed flow.",
    body: "Settles at the NYSE-calendar reference, off the public curve.",
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
              Launch app
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
            <li key={s.tab} id={`how-${s.tab}`}>
              <span className="index">0{i + 1}</span>
              <h3>{s.name}</h3>
              <p>
                <strong>{s.title}</strong> {s.body}
              </p>
              <a href={`/app?tab=${s.tab}`}>Try it →</a>
            </li>
          ))}
        </ol>
        <Diagram />
      </section>

      <section className="black proof" id="proof">
        <h2>
          Live on {NETWORK_NAME}
          {deployment?.chainId && (
            <span className="chain">chain {deployment.chainId}</span>
          )}
        </h2>
        <div id="proof-contracts">
        {rows.length === 0 && (
          <p className="pending">Deployment addresses are being published.</p>
        )}
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
        {PROOF_SWAP_TX && (
          <a
            id="proof-swap"
            className="tx-card"
            href={explorerUrl("unichain-sepolia", "tx", PROOF_SWAP_TX)!}
            target="_blank"
            rel="noreferrer"
          >
            <span className="tx-label">Real router swap from a user wallet</span>
            <span className="mono tx-hash">{PROOF_SWAP_TX}</span>
            <span className="tx-caption">
              100 mcbAAPL → mAAPLx via WrapSwapRouter.swapExactIn
            </span>
            <span className="tx-go">View on Uniscan ↗</span>
          </a>
        )}
      </section>

      <footer className="lfoot" id="developers">
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
