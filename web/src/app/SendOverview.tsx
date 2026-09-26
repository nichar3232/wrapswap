import { useEffect, useState } from "react";
import type { Deployment } from "@wrapswap/types";
import { config } from "../config";
import { fmtShares } from "../lib/format";
import type { Asset } from "./assets";
import { Val } from "./ui";

type Reserves = { suiTotalShares: string; vaultShares: string; vaultSharesHeld: string; invariant: boolean; checkedBlock: string };

/** GET {api}/pay/reserves (the Sui pay service). Absent until that service is deployed with the API. */
function useReserves() {
  const [state, setState] = useState<{ status: "loading" | "ok" | "unavailable"; data?: Reserves }>({ status: "loading" });
  useEffect(() => {
    if (import.meta.env.VITE_USE_MOCKS === "true") return setState({ status: "unavailable" });
    let live = true;
    const load = () =>
      fetch(`${config.apiUrl}/pay/reserves`)
        .then(async (r) => {
          if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) throw new Error();
          const data = (await r.json()) as Reserves;
          if (typeof data.suiTotalShares !== "string") throw new Error();
          if (live) setState({ status: "ok", data });
        })
        .catch(() => live && setState((s) => (s.data ? s : { status: "unavailable" })));
    void load();
    const id = setInterval(load, 20000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return state;
}

const STEPS = [
  { n: 1, chain: "Unichain", title: "Deposit", body: "Lock wrapper shares in the ShareVault. A public ERC-20 transfer." },
  { n: 2, chain: "Sui", title: "Pay confidentially", body: "Amount and payee are Seal-encrypted; the pool publishes only a total and a Merkle root." },
  { n: 3, chain: "Unichain", title: "Withdraw", body: "The recipient withdraws into any issuer's wrapper of the same share." },
];
const SEES: [string, string, string, string][] = [
  ["Public chain", "Hidden", "Visible (submits a sealed payment)", "Hidden"],
  ["Keeper", "Visible", "Visible", "Visible"],
  ["Recipient", "Visible", "Only if the memo names them", "Visible"],
];

/** Send: the confidential payment rail on Sui, bracketed by a Unichain deposit and withdrawal. */
export function SendOverview({ d: _d, assets: _assets }: { d: Deployment | undefined; assets: Asset[] }) {
  const reserves = useReserves();
  return (
    <div className="page send">
      <section className="card">
        <h2 className="card-title">Send</h2>
        <ol className="send-steps">
          {STEPS.map((s) => (
            <li key={s.n}>
              <span className="dot">{s.n}</span>
              <div>
                <strong>{s.title}</strong> <span className="chip">{s.chain}</span>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="parity-line">Confidential, not anonymous. Operator-blind enclave on roadmap.</p>
      </section>
      <div className="send-grid">
        <section className="card" aria-label="Who sees what">
          <h3 className="card-title">Who sees what (payment on Sui)</h3>
          <div className="table-scroll">
            <table className="sees">
              <thead>
                <tr>
                  <th />
                  <th>Amount</th>
                  <th>Sender</th>
                  <th>Recipient</th>
                </tr>
              </thead>
              <tbody>
                {SEES.map(([who, ...cells]) => (
                  <tr key={who}>
                    <th scope="row">{who}</th>
                    {cells.map((c, i) => (
                      <td key={i} className={c === "Hidden" ? "good" : ""}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">Deposits and withdrawals on Unichain are ordinary token transfers.</p>
        </section>
        <section className="card" aria-label="Reserves">
          <h3 className="card-title">Reserves</h3>
          <div className="tiles two">
            <div className="tile">
              <span className="tile-k">Sui pool total</span>
              <span className="tile-v">
                <Val status={reserves.status} w="4em">
                  {reserves.data && fmtShares(reserves.data.suiTotalShares)} <small>sh</small>
                </Val>
              </span>
            </div>
            <div className="tile">
              <span className="tile-k">ShareVault custody</span>
              <span className="tile-v">
                <Val status={reserves.status} w="4em">
                  {reserves.data && fmtShares(reserves.data.vaultSharesHeld)} <small>sh</small>
                </Val>
              </span>
              {reserves.data && <span className={`tile-s ${reserves.data.invariant ? "good" : "warn"}`}>{reserves.data.invariant ? "1:1 backed" : "settling"} · block {reserves.data.checkedBlock}</span>}
            </div>
          </div>
        </section>
      </div>
      <section className="card uses">
        <p>
          <strong>Private compensation</strong> — payroll, contractors, grants; hides company burn and runway.
        </p>
        <p>
          <strong>Private settlement</strong> — fund-to-fund, OTC, M&amp;A, where the amount itself is exploitable information.
        </p>
        <p className="ladder">Dark Cross protects the order before the trade. Send protects the amount after it.</p>
      </section>
    </div>
  );
}
