import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ConvertFlow } from "./ConvertFlow";
import { Footer, Grain, Nav } from "./chrome";
import { Halftone } from "./Halftone";
import { OnePrice } from "./OnePrice";
import "../theme.css";
import "./landing.css";

/** The four products, one card each (whole card links into the app). */
const PRODUCTS = [
  {
    name: "Convert",
    id: "convert",
    href: "/app?tab=move",
    body: "Swap one issuer's AAPL wrapper for another's share-for-share, based on what each wrapper represents, not the market price. Fee: 2 bps + skew, to the LP.",
  },
  {
    name: "Dark Cross",
    id: "dark",
    href: "/app?tab=move&mode=dark",
    body: "On-chain dark pool. Orders are sealed until matched, cross at the 30-minute oracle midpoint for a 1 bp venue fee, residual routes through Convert.",
  },
  {
    name: "Send",
    id: "send",
    href: "/app?tab=send",
    body: "Confidential payment on Sui. Amount hidden by Seal encryption; recipient withdraws into any issuer's wrapper.",
  },
  {
    name: "Liquidity",
    id: "liquidity",
    href: "/app?tab=liquidity",
    body: "Supply both wrappers, earn every Convert fee. Skew fee rises against imbalance so inventory stays balanced.",
  },
];

// The landing page is a slide deck: every top-level section snaps (landing.css, html.deck). Developers is not.
document.documentElement.classList.add("deck");

function Landing() {
  const hero = useRef<HTMLElement>(null);
  // The page renders after the browser's own jump to /#how-it-works etc. (e.g. from /developers), so jump once it exists.
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);
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
            One share is one share. Unison converts tokenized stocks across
            issuers at NAV parity, as a Uniswap v4 hook.
          </p>
          <div className="ctas">
            <a className="launch" href="/app">
              Move your shares
            </a>
            <a className="ghost" href="/developers#contracts">
              See it onchain →
            </a>
          </div>
        </div>
      </section>

      <OnePrice />

      <section className="black how" id="how-it-works">
        <h2>How it works</h2>
        <ol className="steps4">
          {PRODUCTS.map((s) => (
            <li key={s.id} id={`how-${s.id}`}>
              <a href={s.href}>
                <p>
                  <strong>{s.name}</strong> — {s.body}
                </p>
              </a>
            </li>
          ))}
        </ol>
        <p className="mcp-callout">
          Agents can use Unison too: connect Claude to the MCP server and ask it to convert. <a href="/developers#agents">MCP setup →</a>
        </p>
      </section>

      <section className="black flow-sec" id="flow" aria-label="Convert flow">
        <ConvertFlow />
      </section>

      <Footer />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
