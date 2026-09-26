import { useEffect, useState } from "react";
import { formatUnits, parseUnits, type Hash } from "viem";
import type { Deployment, Route } from "@wrapswap/types";
import { FeeRows } from "../components";
import { useApi, type Feed } from "../hooks/useApi";
import { amount, fmtShares } from "../lib/format";
import { allowance, approve, convertExactIn, convertedOf } from "../wallet";
import { toShares, type Asset } from "./assets";
import { quoteBreakdown, skewPct } from "./fees";
import { useTx } from "./tx";
import type { MoveIntent } from "./types";
import { Hex, Spinner, TxPanel, Val } from "./ui";
import { useWallet } from "./wallet";

type Receipt = {
  hash?: Hash;
  simulated: boolean;
  /** Figures read from the ParityHook Converted event (false: the quote the trade executed against). */
  exact: boolean;
  from: string;
  to: string;
  basePips: number;
  skewPips: number;
  sharesIn: bigint;
  sharesOut: bigint;
  baseFee: bigint;
  skewFee: bigint;
  preSkew: bigint;
  postSkew: bigint;
  amountOut: bigint;
};

/** Convert: one wrapper to the other at share parity, through the asset's ParityHook pool. */
export function Convert({ d, asset, pool, intent }: { d: Deployment; asset: Asset; pool: Feed<"poolAsset">; intent?: MoveIntent }) {
  const w = useWallet();
  const [fromAddr, setFromAddr] = useState<string>();
  const [input, setInput] = useState("100");
  const [approvedKey, setApprovedKey] = useState("");
  const [receipt, setReceipt] = useState<Receipt>();
  const tx = useTx<unknown>();

  useEffect(() => {
    if (!intent) return;
    setFromAddr(intent.fromToken);
    setReceipt(undefined);
    tx.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.nonce]);

  const from = asset.platforms.find((p) => p.token.address.toLowerCase() === fromAddr?.toLowerCase()) ?? asset.platforms[0];
  const to = asset.platforms.find((p) => p !== from)!;
  const a = from.token,
    b = to.token;

  let raw = 0n;
  try {
    if (/^\d+(\.\d*)?$/.test(input) && (input.split(".")[1]?.length || 0) <= a.decimals) raw = parseUnits(input, a.decimals);
  } catch {
    raw = 0n;
  }
  const balance = w.balances.values[a.address];
  const overBalance = w.balances.status === "ok" && balance !== undefined && raw > balance;

  // The quote (GET /quote → ParityHook.quote()), and the route when a wallet is known (eligibility, peg guard).
  const params = raw > 0n ? new URLSearchParams({ tokenIn: a.address, tokenOut: b.address, amount: raw.toString(), kind: "exactIn" }) : null;
  const quote = useApi("quote", params ? params.toString() : null, 6000);
  if (params && w.address) {
    params.set("swapper", w.address);
    params.set("allowDark", "false");
    if (w.uid) params.set("attestationUid", w.uid);
  }
  const route = useApi("route", w.address && params ? params.toString() : null, 6000);
  const q = route.data?.quote ?? quote.data;
  const qb = q ? quoteBreakdown(q, b) : undefined;
  const activeRoute: Route | undefined =
    w.address && w.eligibility.data && !w.eligible ? "BLOCKED-ELIGIBILITY" : route.data?.route || (q ? (q.fillable ? "PARITY" : "FALL-THROUGH") : undefined);
  const output = route.data?.route === "FALL-THROUGH" ? route.data.fallThrough?.amountOut : q?.amountOut;
  const minOut = output ? (BigInt(output) * 995n) / 1000n : 0n;
  const quoteStatus = !params ? "ok" : route.data ? "ok" : quote.status;

  const router = d.contracts.wrapSwapRouter ?? d.router ?? undefined;
  const approvalKey = `${w.address}:${a.address}:${raw}`;
  useEffect(() => {
    if (w.demo && !w.relay) return;
    if (!w.ready || !router || raw === 0n) return;
    let live = true;
    allowance(a.address, w.address!, router).then(
      (v) => live && v >= raw && setApprovedKey(approvalKey),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [w.demo, w.relay, w.ready, w.address, a.address, router, raw, approvalKey]);

  const blocked =
    raw === 0n
      ? "Enter an amount."
      : overBalance
        ? `Not enough ${a.symbol} on ${from.name}.`
        : activeRoute === "BLOCKED-ELIGIBILITY"
          ? "This wallet has no issuer eligibility attestation, which Convert requires."
          : activeRoute === "BLOCKED-PEG"
            ? route.data?.reason || "Paused: the pool is more than 50 bps from NAV parity."
            : activeRoute === "FALL-THROUGH"
              ? "Hook inventory is short for this size. Try a smaller amount."
              : "";

  const run = async () => {
    if (!w.address || !q || !qb || !asset.pool) return;
    if (approvedKey !== approvalKey) {
      const ok = await tx.run("Approval", async (onHash) => {
        const spender = router ?? d.contracts.swapRouter;
        if (!spender) throw new Error("NoRouter");
        const sent = await approve(d, w.address!, a.address, spender, raw, { onHash });
        setApprovedKey(approvalKey);
        return { hash: sent.hash, simulated: sent.simulated, result: "approved" };
      });
      if (!ok) return;
    }
    const done = await tx.run("Convert", async (onHash) => {
      const sent = await convertExactIn(d, asset.pool!.key, w.address!, a.address, raw, minOut, w.uid, { onHash, recipient: w.address });
      const c = sent.receipt ? convertedOf(sent.receipt, b.address, w.address!) : undefined;
      const out = c?.amountOut ?? BigInt(output!);
      setApprovedKey("");
      w.adjust(a.address, -raw);
      w.adjust(b.address, out);
      pool.refresh();
      setReceipt({
        hash: sent.hash,
        simulated: sent.simulated,
        exact: !!c,
        from: from.name,
        to: to.name,
        basePips: q.fee.basePips,
        skewPips: q.fee.skewPips,
        sharesIn: qb.sharesIn,
        sharesOut: c?.sharesOut ?? qb.sharesOut,
        baseFee: c?.baseFee ?? qb.baseFee,
        skewFee: c?.skewFee ?? qb.skewFee,
        preSkew: qb.preSkewX18,
        postSkew: c?.postSkew ?? qb.postSkewX18,
        amountOut: out,
      });
      return { hash: sent.hash, simulated: sent.simulated, result: "converted" };
    });
    // The receipt card carries the result; clear the pending panel so it isn't shown twice.
    if (done) tx.reset();
  };

  if (receipt)
    return (
      <div className="receipt" aria-live="polite">
        <p className="receipt-title">
          <span className="ok-dot" aria-hidden="true" /> Converted{receipt.simulated ? " (mock)" : ""}
        </p>
        <p className="review-line">
          <strong>{fmtShares(receipt.sharesIn)}</strong> {asset.symbol} shares on {receipt.from} → <strong>{fmtShares(receipt.sharesOut)}</strong> on {receipt.to}
        </p>
        <FeeRows
          basePips={receipt.basePips}
          skewPips={receipt.skewFee === 0n ? 0 : receipt.skewPips}
          baseFee={receipt.baseFee}
          skewFee={receipt.skewFee}
          reducesImbalance={receipt.skewFee === 0n}
        />
        <dl className="receipt-rows">
          <div>
            <dt>Received</dt>
            <dd>
              {amount(receipt.amountOut, b.decimals, 6)} {b.symbol}
            </dd>
          </div>
          <div>
            <dt>Pool skew</dt>
            <dd data-testid="receipt-skew">
              {skewPct(receipt.preSkew)} → {skewPct(receipt.postSkew)}
            </dd>
          </div>
          {receipt.hash && (
            <div>
              <dt>Transaction</dt>
              <dd>
                <Hex value={receipt.hash} kind="tx" simulated={receipt.simulated} />
              </dd>
            </div>
          )}
        </dl>
        {!receipt.exact && !receipt.simulated && <p className="hint">Figures from the executed quote; the Converted event wasn't in the receipt.</p>}
        <button type="button" className="ghost-btn" onClick={() => setReceipt(undefined)}>
          Convert again
        </button>
      </div>
    );

  return (
    <div className="convert">
      <div className="pair">
        <div className="choices" role="radiogroup" aria-label="From wrapper">
          {asset.platforms.map((p) => (
            <button key={p.token.address} type="button" role="radio" aria-checked={p === from} className="choice" onClick={() => setFromAddr(p.token.address)}>
              <span className="choice-name">{p.name}</span>
              <span className="choice-sub">
                {p.token.symbol}
                {w.balances.status === "ok" && w.balances.values[p.token.address] !== undefined &&
                  ` · ${fmtShares(toShares(w.balances.values[p.token.address]!, p.token))} sh`}
              </span>
            </button>
          ))}
        </div>
        <button type="button" className="flip" aria-label={`Flip: convert ${to.name} to ${from.name}`} onClick={() => setFromAddr(to.token.address)}>
          ⇄
        </button>
        <p className="pair-line">
          {from.name} → <strong>{to.name}</strong>
        </p>
      </div>
      <div className="input-row big">
        <input className="amount" inputMode="decimal" aria-label="Amount" value={input} onChange={(e) => setInput(e.target.value)} />
        <span className="unit">{a.symbol}</span>
        {balance !== undefined && balance > 0n && (
          <button type="button" className="max" onClick={() => setInput(formatUnits(balance, a.decimals))}>
            Max
          </button>
        )}
      </div>

      <section className="quote-card" aria-label="Quote" aria-live="polite">
        <div className="qc-row">
          <span>Shares in</span>
          <strong>
            <Val status={quoteStatus} w="4em">
              {qb ? fmtShares(qb.sharesIn) : raw > 0n ? "—" : "0.00"}
            </Val>
          </strong>
        </div>
        {qb && q ? (
          <FeeRows basePips={q.fee.basePips} skewPips={q.fee.skewPips} baseFee={qb.baseFee} skewFee={qb.skewFee} reducesImbalance={qb.reducesImbalance} />
        ) : (
          <Val status={quoteStatus} w="100%" h="2.4em">
            {null}
          </Val>
        )}
        <div className="keep-tile" data-testid="you-keep">
          <span className="tile-k">You keep</span>
          <span className="keep-v">
            {qb ? (
              <>
                {fmtShares(qb.sharesIn)} → <strong>{fmtShares(qb.sharesOut)}</strong>
              </>
            ) : (
              "—"
            )}{" "}
            <small>{asset.symbol} shares</small>
          </span>
          {qb && <span className="tile-s">{(qb.keep * 100).toFixed(2)}% · pool skew {skewPct(qb.preSkewX18)} → {skewPct(qb.postSkewX18)}</span>}
        </div>
      </section>
      <p className="parity-line">Same share, converted at parity. Price gap between issuers is not charged.</p>

      {blocked && raw > 0n && (
        <p role="alert" className="block-reason">
          {blocked}
        </p>
      )}
      {!w.address ? (
        <button className="primary wide" disabled={w.busy === "connect"} onClick={() => void w.connect()}>
          {w.busy === "connect" ? "Connecting…" : "Connect to convert"}
        </button>
      ) : (
        <button className="primary wide" disabled={!!blocked || tx.busy || !qb} aria-busy={tx.busy || undefined} onClick={() => void run()}>
          {tx.busy && <Spinner />}
          {tx.state.step === "signing" ? "Confirm in wallet…" : tx.busy ? "Converting…" : approvedKey === approvalKey || (w.demo && !w.relay) ? "Convert" : "Approve and convert"}
        </button>
      )}
      {w.notice && <p className="block-reason">{w.notice}</p>}
      <TxPanel tx={tx.state} onRetry={() => void run()} />
    </div>
  );
}
