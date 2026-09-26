import { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { SimpleFlow } from "./Flows";
import { Footer, Grain, Nav } from "./chrome";
import { Halftone } from "./Halftone";
import { OnePrice } from "./OnePrice";
import "../theme.css";
import "./landing.css";

/** The three products, one line each. */
const PRODUCTS = [
  {
    name: "Convert",
    id: "convert",
    href: "/app?tab=move",
    body: "Move a stock between issuers' wrappers at share parity, instantly, through a Uniswap v4 hook.",
  },
  {
    name: "Dark Cross",
    id: "dark",
    href: "/app?tab=move&mode=dark",
    body: "Sealed batch orders cross at the 30-min midpoint, hidden until matched.",
  },
  {
    name: "Send",
    id: "send",
    href: "/app?tab=send",
    body: "Pay in shares confidentially on Sui; the recipient withdraws into any issuer's wrapper.",
  },
];

function Landing() {
  const hero = useRef<HTMLElement>(null);
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
            <a className="ghost" href="/developers#contracts">
              See it onchain →
            </a>
          </div>
        </div>
      </section>

      <OnePrice />

      <section className="black how" id="how-it-works">
        <h2>How it works</h2>
        <ol className="steps3">
          {PRODUCTS.map((s, i) => (
            <li key={s.id} id={`how-${s.id}`}>
              <span className="index">0{i + 1}</span>
              <h3>{s.name}</h3>
              <p>{s.body}</p>
              <a href={s.href}>Try it →</a>
            </li>
          ))}
        </ol>
        <SimpleFlow />
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
