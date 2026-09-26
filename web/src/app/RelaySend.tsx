import { useEffect, useState } from "react";
import { isAddress, parseUnits } from "viem";
import { fmtShares } from "../lib/format";
import { RelayError, relayAmount, relaySend, relaySendJob, relayStatus, type RelaySendJob, type RelaySendStep } from "../relay";
import { toShares, type Asset } from "./assets";
import { useTx } from "./tx";
import { CopyButton, Spinner, TxPanel, shortHex } from "./ui";
import { useWallet } from "./wallet";

const DONE = ["settled", "skipped", "failed"];
/**
 * The four legs, in order. POST /demo/send returns only the deposit; GET /demo/send/<id> adds the Sui pay, the Sui
 * withdraw and the Unichain settlement over the next few minutes. Each row fills in when its hash arrives.
 */
const LEGS: { key: string; label: string; chain: RelaySendStep["chain"]; find: (s: RelaySendStep[]) => RelaySendStep | undefined }[] = [
  { key: "deposit", label: "Deposit into ShareVault", chain: "unichain", find: (s) => s.find((x) => x.chain === "unichain" && /deposit/i.test(x.step)) ?? s.find((x) => x.chain === "unichain") },
  { key: "pay", label: "Sealed pay on Sui", chain: "sui", find: (s) => s.find((x) => x.chain === "sui" && /pay/i.test(x.step)) },
  { key: "withdraw", label: "Sealed withdraw on Sui", chain: "sui", find: (s) => s.find((x) => x.chain === "sui" && /withdraw/i.test(x.step)) },
  { key: "settle", label: "Settlement on Unichain", chain: "unichain", find: (s) => s.filter((x) => x.chain === "unichain" && !/deposit/i.test(x.step)).at(-1) },
];
const STATUS: Record<RelaySendJob["status"], string> = {
  deposited: "Deposited on Unichain · waiting for the keeper to credit Sui",
  credited: "Credited on Sui · sealing the payment",
  paid: "Paid confidentially on Sui · submitting the withdrawal",
  "withdraw-submitted": "Withdrawal sealed on Sui · waiting for settlement on Unichain",
  settled: "Settled: the recipient received the other issuer's wrapper",
  skipped: "The withdrawal was skipped by the keeper",
  failed: "Failed",
};

/**
 * Send with no wallet: POST {api}/demo/send runs the real Sui confidential path on the demo relay
 * (ShareVault deposit on Unichain → sealed pay on Sui → withdraw into the other issuer on Unichain). Every step
 * shown is a real transaction the relay returns; nothing here is simulated.
 */
export function RelaySend({ assets }: { assets: Asset[] }) {
  const w = useWallet();
  // Unison Pay's ShareVault holds AAPL wrappers only.
  const asset = assets.find((a) => a.symbol === "AAPL");
  const [fromSym, setFromSym] = useState<string>();
  const [input, setInput] = useState("10");
  const [recipient, setRecipient] = useState("");
  const [job, setJob] = useState<RelaySendJob>();
  const [busyNote, setBusyNote] = useState<string | null>(null);
  /** The relay answered 409: another Sui send holds the queue. */
  const [conflict, setConflict] = useState(false);
  const tx = useTx<unknown>();

  useEffect(() => {
    if (!recipient && w.address) setRecipient(w.address);
  }, [w.address, recipient]);
  // One Sui send runs at a time on the relay: say so before the visitor spends an action.
  useEffect(() => {
    if (!w.relay) return;
    let live = true;
    const poll = async () => {
      const s = await relayStatus();
      if (live) setBusyNote(s?.sui?.busy && s.sui.busy !== job?.id ? s.sui.busy : null);
    };
    void poll();
    const id = setInterval(poll, 8000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [w.relay, job?.id]);
  // Follow the job until it settles (a missed poll is retried on the next tick).
  const jobId = job?.id,
    finished = !!job && DONE.includes(job.status);
  useEffect(() => {
    if (!jobId || finished) return;
    let live = true;
    const id = setInterval(() => {
      relaySendJob(jobId).then((j) => live && setJob(j), () => undefined);
    }, 4000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [jobId, finished]);

  if (!w.relay)
    return (
      <section className="card" aria-label="Send shares">
        <p>Send needs a wallet here: the demo relay isn't available right now.</p>
        <button className="primary" disabled={w.busy === "connect"} onClick={() => void w.connect()}>
          Connect wallet
        </button>
        {w.notice && <p className="block-reason">{w.notice}</p>}
      </section>
    );
  if (!asset) return null;
  const from = asset.platforms.find((p) => p.token.symbol === fromSym) ?? asset.platforms[0];
  const to = asset.platforms.find((p) => p !== from)!;
  let raw = 0n;
  try {
    if (/^\d+(\.\d*)?$/.test(input)) raw = parseUnits(relayAmount(input), from.token.decimals);
  } catch {
    raw = 0n;
  }
  const shares = toShares(raw, from.token);
  const blocked =
    raw === 0n
      ? "Enter an amount."
      : !isAddress(recipient)
          ? "Enter the recipient's 0x address."
          : "";

  const run = async () => {
    setConflict(false);
    const done = await tx.run("Send (demo relay)", async (onHash) => {
      try {
        const j = await relaySend({ asset: asset.symbol, from: from.token.symbol, to: to.token.symbol, amount: relayAmount(input), recipient });
        onHash(j.depositTx);
        w.record({
          hash: j.depositTx,
          kind: "SEND",
          text: `Send · ${fmtShares(shares)} ${asset.symbol} sh ${from.token.symbol} → ${to.token.symbol} to ${recipient.slice(0, 6)}…${recipient.slice(-4)}`,
          simulated: false,
        });
        setJob(j);
        return { hash: j.depositTx, simulated: false, result: "sent" };
      } catch (e) {
        if (e instanceof RelayError && e.status === 409) setConflict(true);
        throw e;
      }
    });
    if (done) tx.reset();
  };

  return (
    <section className="card relay-send" aria-label="Send shares">
      <h3 className="card-title">Send {asset.symbol} shares · demo relay</h3>
      <p className="hint">Send moves AAPL wrappers only: the ShareVault holds AAPL.</p>
      {job ? (
        <>
          <p className="review-line">
            <strong>{fmtShares(BigInt(job.shares || "0") || shares)}</strong> {asset.symbol} shares · {job.from} → {job.to} · to{" "}
            <span className="mono">{shortHex(job.recipient)}</span>
          </p>
          <p className={job.status === "failed" || job.status === "skipped" ? "block-reason" : "hint"} data-testid="relay-send-status">
            {!DONE.includes(job.status) && <Spinner />} {STATUS[job.status]}
            {job.error ? ` · ${job.error}` : ""}
          </p>
          <ol className="relay-steps" aria-label="Send transactions">
            {LEGS.map((leg) => {
              const s = leg.find(job.steps);
              const waiting = !s && !DONE.includes(job.status);
              return (
                <li key={leg.key} className={s ? "leg-done" : "leg-wait"} data-leg={leg.key}>
                  <span className="chip">{leg.chain === "sui" ? "Sui" : "Unichain"}</span>
                  <span className="relay-step">{s?.step ?? leg.label}</span>
                  {s ? (
                    <span className="hex">
                      <span className="mono" title={s.tx}>
                        {shortHex(s.tx)}
                      </span>
                      <CopyButton value={s.tx} label="Copy transaction" />
                      <a className="ext" href={s.url} target="_blank" rel="noreferrer" aria-label={`View on ${s.chain === "sui" ? "Suiscan" : "Uniscan"}`}>
                        ↗
                      </a>
                    </span>
                  ) : (
                    <span className="muted small">{waiting ? <><Spinner /> waiting</> : "—"}</span>
                  )}
                </li>
              );
            })}
          </ol>
          {DONE.includes(job.status) && (
            <button type="button" className="ghost-btn" onClick={() => setJob(undefined)}>
              New send
            </button>
          )}
        </>
      ) : (
        <>
          <div className="choices" role="radiogroup" aria-label="Send from wrapper">
            {asset.platforms.map((p) => (
              <button key={p.token.address} type="button" role="radio" aria-checked={p === from} className="choice" onClick={() => setFromSym(p.token.symbol)}>
                <span className="choice-name">
                  {p.name} → {asset.platforms.find((x) => x !== p)!.name}
                </span>
                <span className="choice-sub">{p.token.symbol}</span>
              </button>
            ))}
          </div>
          <div className="input-row big">
            <input className="amount" inputMode="decimal" aria-label="Send amount" value={input} onChange={(e) => setInput(e.target.value)} />
            <span className="unit">{from.token.symbol}</span>
          </div>
          <label className="field-label" htmlFor="relay-recipient">
            Recipient on Unichain (receives {to.token.symbol})
          </label>
          <input id="relay-recipient" className="addr-input mono" spellCheck={false} value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} />
          {(busyNote || conflict) && (
            <p className="block-reason" role="status" data-testid="relay-one-at-a-time">
              One send at a time: the demo relay is already running a Sui send{busyNote ? ` (${busyNote})` : ""}. Yours can start when it finishes, usually within a few minutes.
            </p>
          )}
          {blocked && raw > 0n && <p className="block-reason">{blocked}</p>}
          <button className="primary wide" disabled={!!blocked || tx.busy || !!busyNote} onClick={() => void run()}>
            {tx.busy && <Spinner />}
            {tx.busy ? "Depositing on Unichain…" : "Send confidentially"}
          </button>
        </>
      )}
      <TxPanel tx={tx.state} onRetry={() => void run()} />
    </section>
  );
}
