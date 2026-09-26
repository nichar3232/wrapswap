import type { ReactNode } from "react";

const STEPS = [
  { n: 1, chain: "Unichain", title: "Deposit", body: "Lock wrapper shares in the ShareVault. A public ERC-20 transfer." },
  { n: 2, chain: "Sui", title: "Pay confidentially", body: "Amount and payee are Seal-encrypted; the pool publishes only a total and a Merkle root." },
  { n: 3, chain: "Unichain", title: "Withdraw", body: "The recipient withdraws into any issuer's wrapper of the same share." },
];

/**
 * Send: the confidential payment rail on Sui, bracketed by a Unichain deposit and withdrawal. `children` is the sui
 * lane's Send panel (deposit, sealed payment, withdrawal, reserves from GET /pay/reserves).
 */
export function SendOverview({ children }: { children?: ReactNode }) {
  return (
    // Two equal-height columns on desktop: the send itself on the left, how it works on the right.
    <div className="page send">
      <div className="send-main">{children}</div>
      <div className="send-side">
      <section className="card send-overview">
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
      </div>
    </div>
  );
}
