import type { ReactNode } from "react";

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

/**
 * Send: the confidential payment rail on Sui, bracketed by a Unichain deposit and withdrawal. `children` is the sui
 * lane's Send panel (deposit, sealed payment, withdrawal, reserves from GET /pay/reserves).
 */
export function SendOverview({ children }: { children?: ReactNode }) {
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
      {children}
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
