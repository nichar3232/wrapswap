import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Footer, GITHUB, Nav } from "./chrome";
import { DevDiagram } from "./Flows";
import { NETWORK_NAME, contractGroups, deployment, proofTxs, short } from "./proof";
import "../theme.css";
import "./landing.css";

/** Developers: the v4 call order per product, and every deployed contract with its explorer link. */
function Developers() {
  const groups = contractGroups(deployment);
  const txs = proofTxs(deployment);
  // The page renders after the browser's own jump to #architecture / #contracts, so jump once it exists.
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);
  return (
    <>
      <div className="black dev-page-top">
        <Nav home={false} />
      </div>
      <section className="black developers" id="architecture">
        <h2>Architecture</h2>
        <DevDiagram />
        <p className="dev-links">
          <a href={GITHUB} target="_blank" rel="noreferrer">
            Source on GitHub ↗
          </a>
          <a href="/sim.html">Market simulation: 1,500 trades on a Unichain Sepolia fork ↗</a>
        </p>
      </section>
      <section className="black proof" id="contracts">
        <h2>
          Live on {NETWORK_NAME}
          {deployment?.chainId && <span className="chain">chain {deployment.chainId}</span>}
        </h2>
        {groups.length === 0 && <p>Deployment addresses are being published.</p>}
        {groups.map((g) => (
          <div className="table-wrap" key={g.title}>
            <table>
              <caption>{g.title}</caption>
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
                {g.rows.map((r) => (
                  <tr key={r.address + r.name}>
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
        ))}
        {txs.length > 0 && (
          <div className="tx-cards" id="proof-txs">
            {txs.map((p, i) => (
              <a key={p.hash} className={`tx-card${i ? " secondary" : ""}`} href={p.url} target="_blank" rel="noreferrer">
                {p.label && <span className="tx-label">{p.label}</span>}
                <span className="mono tx-hash">{p.hash}</span>
                <span className="tx-go">View on Uniscan ↗</span>
              </a>
            ))}
          </div>
        )}
      </section>
      <Footer />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Developers />
  </StrictMode>,
);
