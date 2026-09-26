import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Footer, GITHUB, Nav } from "./chrome";
import { ConvertFlow } from "./ConvertFlow";
import { DevDiagram } from "./Flows";
import { CLAUDE_CODE_CMD, MCP_TOOLS, MCP_URL, callText, mcpDemo } from "./mcp";
import { contractGroups, deployment, proofTxs, short } from "./proof";
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
        <ConvertFlow variant="dev" />
        <DevDiagram />
        <p className="dev-links">
          <a href={GITHUB} target="_blank" rel="noreferrer">
            Source on GitHub ↗
          </a>
        </p>
      </section>
      <section className="black proof" id="contracts">
        <h2>Contracts</h2>
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
      <Agents />
      <Footer />
    </>
  );
}

/** Agents: the MCP endpoint, its six tools, how to connect Claude, and one recorded agent run end to end. */
function Agents() {
  return (
    <section className="black agents" id="agents">
      <h2>Agents</h2>
      <p className="agents-lead">
        Unison is an MCP server, so an AI agent can read the pools, quote and convert on its own. Every size is in shares of the stock. Executions go
        through the demo relay: at most 100 shares per action and 3 actions per 10 minutes.
      </p>
      <div className="mcp-endpoint">
        <span className="tile-k">MCP endpoint · Streamable HTTP</span>
        <code className="mono">{MCP_URL}</code>
      </div>
      <h3>Tools</h3>
      <ul className="mcp-tools">
        {MCP_TOOLS.map((t) => (
          <li key={t.name}>
            <code className="mono">
              {t.name}({t.args})
            </code>
            <span className={`mcp-kind ${t.kind}`}>{t.kind}</span>
            <p>{t.body}</p>
          </li>
        ))}
      </ul>
      <div className="mcp-setup">
        <div>
          <h3>Claude.ai</h3>
          <ol>
            <li>Settings → Connectors → Add custom connector.</li>
            <li>
              Name it <strong>Unison</strong> and paste the endpoint as the remote MCP server URL. No sign-in is needed.
            </li>
            <li>In a chat, turn Unison on from the tools menu and ask, for example, “Convert 50 AAPL into whichever wrapper is cheapest right now.”</li>
          </ol>
        </div>
        <div>
          <h3>Claude Code</h3>
          <pre className="mono">
            <code>{CLAUDE_CODE_CMD}</code>
          </pre>
          <p className="muted-line">Any MCP client that speaks Streamable HTTP connects the same way.</p>
        </div>
      </div>
      {mcpDemo && (
        <div className="mcp-demo" id="agent-transcript">
          <h3>Recorded agent run</h3>
          <p className="muted-line">
            {mcpDemo.client}, connected only to the endpoint above. The prompt names no tool; the agent chose each call itself.
          </p>
          <blockquote>{mcpDemo.prompt}</blockquote>
          <ol className="mcp-steps">
            {mcpDemo.steps.map((s, i) => (
              <li key={i}>
                <code className="mono">{callText(s)}</code>
                <p>{s.result.replace(/ \(https?:\/\/\S+\)/, "")}</p>
              </li>
            ))}
          </ol>
          <a className="tx-card" href={mcpDemo.explorer} target="_blank" rel="noreferrer">
            <span className="tx-label">Result · confirmed at block {mcpDemo.block.toLocaleString("en-US")}</span>
            <span className="mono tx-hash">{mcpDemo.tx}</span>
            <span className="tx-go">View on Uniscan ↗</span>
          </a>
          <p className="dev-links">
            <a href={`${GITHUB}/blob/main/${mcpDemo.source}`} target="_blank" rel="noreferrer">
              Full transcript with every tool result ↗
            </a>
          </p>
        </div>
      )}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Developers />
  </StrictMode>,
);
