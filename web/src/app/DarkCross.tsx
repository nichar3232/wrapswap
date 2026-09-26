import { useEffect, useRef, useState } from "react";
import { encodeAbiParameters, formatUnits, keccak256, parseUnits, toHex, zeroAddress, type Hash } from "viem";
import { canonical, type Address, type BatchPhase, type Deployment } from "@wrapswap/types";
import { useApi, type Feed } from "../hooks/useApi";
import { amount, duration, fmtShares } from "../lib/format";
import { approve, darkSend, escrowAvailable, verifyOrder } from "../wallet";
import { toShares, type Asset, type Platform } from "./assets";
import { pipsToBps } from "./fees";
import { useTx } from "./tx";
import type { MoveIntent } from "./types";
import { Empty, Hex, Spinner, TxPanel, Val } from "./ui";
import { useWallet } from "./wallet";

const zero32 = toHex(new Uint8Array(32));
/** Default limit: 0.5% through the oracle midpoint, so a small mid move before settlement still crosses. */
const LIMIT_BPS = 50n;

type Stage = "committed" | "revealed" | "settled" | "missed";
type Order = {
  hook: Address;
  asset: string;
  account: Address;
  batchId: string;
  sellBase: boolean;
  lockToken: Address;
  amount: bigint;
  limit: bigint;
  salt: Hash;
  stage: Stage;
  simulated: boolean;
  txs: { commit?: Hash; reveal?: Hash };
};

// The salt must survive a reload until the order is revealed, so the open order is kept in this browser.
const storeKey = (hook: string, account: string) => `unison:dark:${hook.toLowerCase()}:${account.toLowerCase()}`;
function loadOrder(hook: string, account: string): Order | undefined {
  try {
    const raw = localStorage.getItem(storeKey(hook, account));
    if (!raw) return undefined;
    const o = JSON.parse(raw);
    return { ...o, amount: BigInt(o.amount), limit: BigInt(o.limit) };
  } catch {
    return undefined;
  }
}
function saveOrder(o: Order | undefined, hook: string, account: string) {
  try {
    if (o) localStorage.setItem(storeKey(hook, account), JSON.stringify({ ...o, amount: String(o.amount), limit: String(o.limit) }));
    else localStorage.removeItem(storeKey(hook, account));
  } catch {
    /* storage blocked: the order lives for this session only */
  }
}

const PHASES: { key: BatchPhase; label: string }[] = [
  { key: "COMMIT", label: "Commit" },
  { key: "REVEAL", label: "Reveal" },
  { key: "SETTLE", label: "Settle" },
];

/** Seconds left in the current phase, counting down between polls. */
function useCountdown(batch: Feed<"currentBatch">) {
  const [now, setNow] = useState(Date.now());
  const at = useRef({ key: "", t: Date.now() });
  const data = batch.data;
  const key = data ? `${data.batchId}:${data.phase}:${data.blockNumber}` : "";
  if (key !== at.current.key) at.current = { key, t: Date.now() };
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  if (!data) return undefined;
  // Unichain Sepolia produces a block per second, so blocks left stand in when the API omits secondsRemaining.
  const base = data.secondsRemaining ?? Math.max(0, Number(data.phaseEndsBlock) - Number(data.blockNumber));
  return Math.max(0, base - (now - at.current.t) / 1000);
}

export function DarkCross({ d, asset, batch, intent }: { d: Deployment; asset: Asset; batch: Feed<"currentBatch">; intent?: MoveIntent }) {
  const w = useWallet();
  const pair = asset.darkCross!;
  const hook = pair.hook as Address;
  const base = asset.platforms.find((p) => p.token.address.toLowerCase() === pair.baseToken.toLowerCase())!;
  const quote = asset.platforms.find((p) => p.token.address.toLowerCase() === pair.quoteToken.toLowerCase())!;
  const [fromAddr, setFromAddr] = useState<string>();
  const [input, setInput] = useState("60");
  const [order, setOrderState] = useState<Order>();
  const tx = useTx<unknown>();
  const left = useCountdown(batch);

  useEffect(() => {
    if (intent) setFromAddr(intent.fromToken);
  }, [intent]);
  // Restore this wallet's open order for this asset.
  useEffect(() => {
    setOrderState(w.address ? loadOrder(hook, w.address) : undefined);
  }, [hook, w.address]);
  const setOrder = (o: Order | undefined) => {
    setOrderState(o);
    if (w.address) saveOrder(o, hook, w.address);
  };

  const from: Platform = [base, quote].find((p) => p?.token.address.toLowerCase() === fromAddr?.toLowerCase()) ?? base;
  const to = from === base ? quote : base;
  const sellBase = from === base;
  const a = from.token;
  let raw = 0n;
  try {
    if (/^\d+(\.\d*)?$/.test(input) && (input.split(".")[1]?.length || 0) <= a.decimals) raw = parseUnits(input, a.decimals);
  } catch {
    raw = 0n;
  }
  const balance = w.balances.values[a.address];
  const overBalance = w.balances.status === "ok" && balance !== undefined && raw > balance;

  const b = batch.data;
  const mid = b?.oracle.midX18 ? BigInt(b.oracle.midX18) : undefined;
  // Selling base accepts no less than mid − 0.5%; buying base pays no more than mid + 0.5%.
  const limit = mid ? (sellBase ? (mid * (10_000n - LIMIT_BPS)) / 10_000n : (mid * (10_000n + LIMIT_BPS)) / 10_000n) : 0n;
  const atMid =
    mid && raw > 0n
      ? (() => {
          const gross = sellBase
            ? canonical.baseAsQuote(raw, mid, base.token.decimals, quote.token.decimals)
            : canonical.quoteAsBase(raw, mid, base.token.decimals, quote.token.decimals);
          const fee = canonical.crossFee(gross);
          return { gross, fee, net: gross - fee };
        })()
      : undefined;

  const commitHash = (o: { batchId: string; sellBase: boolean; amount: bigint; limit: bigint; salt: Hash }) =>
    keccak256(
      encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "address" },
          { type: "uint256" },
          { type: "address" },
          { type: "bool" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "address" },
          { type: "bytes32" },
        ],
        [BigInt(d.chainId), hook, BigInt(o.batchId), w.address!, o.sellBase, o.amount, o.limit, zeroAddress, o.salt],
      ),
    );

  const commit = async () => {
    if (!b || !w.address) return;
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const o = { batchId: b.batchId, sellBase, amount: raw, limit, salt };
    const done = await tx.run("Sealed commit", async (onHash) => {
      await approve(d, w.address!, a.address, hook, raw, { onHash });
      await darkSend(d, hook, w.address!, "fund", [a.address, raw], { onHash });
      const h = commitHash(o);
      const sent = await darkSend(d, hook, w.address!, "commit", [h, a.address, raw, w.uid || zero32], { onHash });
      await verifyOrder(hook, w.address!, o.batchId, h);
      w.adjust(a.address, -raw);
      setOrder({
        ...o,
        hook,
        asset: asset.symbol,
        account: w.address!,
        lockToken: a.address,
        stage: "committed",
        simulated: sent.simulated,
        txs: { commit: sent.hash },
      });
      return { hash: sent.hash, simulated: sent.simulated, result: "committed" };
    });
    if (done) tx.reset();
  };

  const revealing = useRef(false);
  const reveal = async () => {
    if (!order || revealing.current) return;
    revealing.current = true;
    const done = await tx.run("Reveal", async (onHash) => {
      const sent = await darkSend(d, hook, w.address!, "reveal", [order.sellBase, order.amount, order.limit, zeroAddress, order.salt], { onHash });
      await verifyOrder(hook, w.address!, order.batchId);
      setOrder({ ...order, stage: "revealed", txs: { ...order.txs, reveal: sent.hash } });
      return { hash: sent.hash, simulated: sent.simulated, result: "revealed" };
    });
    if (done) tx.reset();
    revealing.current = false;
  };

  // Stage transitions from the live batch: reveal in the reveal window (automatic when the demo signs), missed if
  // the batch moved on unrevealed, settled once the batch detail says so.
  const current = b ? BigInt(b.batchId) : undefined;
  const mine = order ? BigInt(order.batchId) : undefined;
  useEffect(() => {
    if (!order || current === undefined || mine === undefined || tx.busy) return;
    if (order.stage === "committed" && current === mine && b?.phase === "REVEAL" && w.demo) void reveal();
    if (order.stage === "committed" && (current > mine || (current === mine && b?.phase === "SETTLE"))) setOrder({ ...order, stage: "missed" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.stage, current, b?.phase, w.demo]);
  const waitingSettle = !!order && order.stage === "revealed" && current !== undefined && (current > mine! || b?.phase === "SETTLE");
  const detail = useApi("batch", order && (waitingSettle || order.stage === "settled") ? `${order.batchId}?asset=${order.asset}` : null, 4000);
  useEffect(() => {
    if (order?.stage === "revealed" && detail.data?.batch.settled) setOrder({ ...order, stage: "settled" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.batch.settled, order?.stage]);

  const history = useApi("batches", `asset=${asset.symbol}&settled=true&limit=5`, 15000);

  const blocked =
    raw === 0n
      ? "Enter a size."
      : overBalance
        ? `Not enough ${a.symbol} on ${from.name}.`
        : b?.oracle.stale
          ? "The oracle midpoint is stale; commits reopen after the next update."
          : b && b.phase !== "COMMIT"
            ? `Commits reopen with the next batch (${left !== undefined ? duration(left) : "—"} left in ${b.phase.toLowerCase()}).`
            : "";

  return (
    <div className="dark">
      <BatchStrip batch={batch} left={left} order={order} />

      {order ? (
        <OrderCard
          order={order}
          asset={asset}
          base={base}
          quote={quote}
          detail={detail}
          phase={b?.phase}
          currentBatch={b?.batchId}
          onReveal={() => void reveal()}
          busy={tx.busy}
          demo={w.demo}
          onDone={() => setOrder(undefined)}
          onWithdraw={async (tokens) => {
            await tx.run("Withdraw", async (onHash) => {
              const chain = await escrowAvailable(hook, w.address!, tokens.map((t) => t.token));
              let last: { hash: Hash; simulated: boolean } | undefined;
              for (const [i, t] of tokens.entries()) {
                const amt = chain ? chain[i] : t.amount;
                if (amt > 0n) {
                  last = await darkSend(d, hook, w.address!, "withdraw", [t.token, amt], { onHash });
                  w.adjust(t.token, amt);
                }
              }
              setOrder(undefined);
              return { hash: last?.hash, simulated: last?.simulated ?? true, result: "withdrawn" };
            });
          }}
        />
      ) : (
        <>
          <div className="choices" role="radiogroup" aria-label="Side">
            {[base, quote].map((p) => {
              const other = p === base ? quote : base;
              return (
                <button key={p.token.address} type="button" role="radio" aria-checked={p === from} className="choice" onClick={() => setFromAddr(p.token.address)}>
                  <span className="choice-name">
                    {p.name} → {other.name}
                  </span>
                  <span className="choice-sub">
                    {p === base ? "Sell" : "Buy"} {base.token.symbol}
                    {w.balances.status === "ok" && w.balances.values[p.token.address] !== undefined &&
                      ` · ${fmtShares(toShares(w.balances.values[p.token.address]!, p.token))} sh`}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="input-row big">
            <input className="amount" inputMode="decimal" aria-label="Size" value={input} onChange={(e) => setInput(e.target.value)} />
            <span className="unit">{a.symbol}</span>
            {balance !== undefined && balance > 0n && (
              <button type="button" className="max" onClick={() => setInput(formatUnits(balance, a.decimals))}>
                Max
              </button>
            )}
          </div>
          <section className="quote-card" aria-label="If fully crossed">
            <div className="qc-row">
              <span>Shares in</span>
              <strong>{raw > 0n ? fmtShares(toShares(raw, a)) : "0.00"}</strong>
            </div>
            <dl className="fee-rows">
              <div>
                <dt>
                  Venue fee <small>{pipsToBps(canonical.CROSS_FEE_PIPS).toFixed(2)} bp · protocol · crossed volume only</small>
                </dt>
                <dd>{atMid ? `${amount(atMid.fee, to.token.decimals, 6)} ${to.token.symbol}` : "—"}</dd>
              </div>
              <div>
                <dt>
                  Limit <small>midpoint {sellBase ? "−" : "+"}0.5%</small>
                </dt>
                <dd>
                  <Val status={batch.status} w="5em">
                    {mid ? `${amount(limit, 18, 6)} ${quote.token.symbol}/${base.token.symbol}` : "—"}
                  </Val>
                </dd>
              </div>
            </dl>
            <div className="keep-tile">
              <span className="tile-k">If fully crossed at the 30-min midpoint</span>
              <span className="keep-v">
                {atMid ? (
                  <>
                    {fmtShares(toShares(raw, a))} → <strong>{fmtShares(toShares(atMid.net, to.token))}</strong>
                  </>
                ) : (
                  "—"
                )}{" "}
                <small>{asset.symbol} shares</small>
              </span>
              <span className="tile-s">Any residual converts through the pool (base + skew · LP); anything unfilled is refunded.</span>
            </div>
          </section>
          <p className="parity-line">Hidden until matched. Public on-chain after settlement.</p>
          {blocked && raw > 0n && (
            <p role="alert" className="block-reason">
              {blocked}
            </p>
          )}
          {!w.address ? (
            <button className="primary wide" disabled={w.busy === "connect"} onClick={() => void w.connect()}>
              {w.busy === "connect" ? "Connecting…" : "Connect to commit"}
            </button>
          ) : (
            <button className="primary wide" disabled={!!blocked || tx.busy || !mid} aria-busy={tx.busy || undefined} onClick={() => void commit()}>
              {tx.busy && <Spinner />}
              {tx.state.step === "signing" ? "Confirm in wallet…" : tx.busy ? "Sealing…" : `Commit sealed order · batch #${b?.batchId ?? "—"}`}
            </button>
          )}
        </>
      )}
      <TxPanel tx={tx.state} onRetry={() => tx.retry()} />

      <History asset={asset} base={base} history={history} />
    </div>
  );
}

function BatchStrip({ batch, left, order }: { batch: Feed<"currentBatch">; left?: number; order?: Order }) {
  const b = batch.data;
  const ix = b ? PHASES.findIndex((p) => p.key === b.phase) : -1;
  return (
    <div className="batch-strip" aria-label="Current batch" data-phase={b?.phase ?? "loading"}>
      <div className="bs-head">
        <span className="tile-k">
          <Val status={batch.status} w="5em">
            Batch #{b?.batchId}
          </Val>
        </span>
        <span className="bs-left" data-testid="batch-countdown">
          {b && left !== undefined ? (
            <>
              {PHASES[ix]?.label} · <strong>{duration(left)}</strong> left
            </>
          ) : (
            " "
          )}
        </span>
      </div>
      <ol className="bs-phases">
        {PHASES.map((p, i) => (
          <li key={p.key} className={i === ix ? "on" : i < ix ? "done" : ""} aria-current={i === ix ? "step" : undefined}>
            {p.label}
          </li>
        ))}
      </ol>
      {b && (
        <p className="bs-sub">
          {b.participants} sealed order{b.participants === 1 ? "" : "s"} in this batch · midpoint{" "}
          {b.oracle.midX18 ? amount(b.oracle.midX18, 18, 6) : "—"}
          {b.oracle.stale ? " (stale)" : ""}
          {order && order.stage !== "settled" && order.batchId !== b.batchId ? ` · your order: batch #${order.batchId}` : ""}
        </p>
      )}
    </div>
  );
}

function OrderCard({
  order,
  asset,
  base,
  quote,
  detail,
  phase,
  currentBatch,
  onReveal,
  busy,
  demo,
  onDone,
  onWithdraw,
}: {
  order: Order;
  asset: Asset;
  base: Platform;
  quote: Platform;
  detail: Feed<"batch">;
  phase?: BatchPhase;
  currentBatch?: string;
  onReveal: () => void;
  busy: boolean;
  demo: boolean;
  onDone: () => void;
  onWithdraw: (tokens: { token: Address; amount: bigint }[]) => void;
}) {
  const [inTok, outTok] = order.sellBase ? [base.token, quote.token] : [quote.token, base.token];
  const steps: { key: Stage; label: string; tx?: Hash }[] = [
    { key: "committed", label: "Sealed", tx: order.txs.commit },
    { key: "revealed", label: "Revealed", tx: order.txs.reveal },
    { key: "settled", label: "Settled", tx: detail.data?.batch.settledTx ?? undefined },
  ];
  const at = ["committed", "revealed", "settled"].indexOf(order.stage);
  const me = order.account.toLowerCase();
  const fills = detail.data?.fills.filter((f) => f.account.toLowerCase() === me) ?? [];
  const cross = fills.find((f) => f.kind === "DARK-CROSS"),
    res = fills.find((f) => f.kind === "DARK-RESIDUAL");
  const crossedIn = cross ? BigInt(cross.amountIn) : 0n,
    residualIn = res ? BigInt(res.amountIn) : 0n;
  const unfilled = order.amount > crossedIn + residualIn ? order.amount - crossedIn - residualIn : 0n;
  const sh = (x: bigint | string, t: typeof inTok) => fmtShares(toShares(BigInt(x), t));
  const midX18 = detail.data?.batch.midX18;
  return (
    <section className="order-card" aria-label="Your sealed order">
      <ol className="track-steps" aria-label="Sealed order progress">
        {steps.map((s, i) => (
          <li key={s.key} className={i < at ? "done" : i === at ? "on" : ""}>
            {s.label}
            {s.tx && <Hex value={s.tx} kind="tx" simulated={order.simulated} />}
          </li>
        ))}
      </ol>
      <p className="review-line">
        <strong>{sh(order.amount, inTok)}</strong> {asset.symbol} shares · {order.sellBase ? "sell" : "buy"} {base.token.symbol} · batch #{order.batchId}
      </p>
      {order.stage === "committed" && (
        <>
          <p className="hint">
            {currentBatch === order.batchId && phase === "COMMIT"
              ? "Sealed. The reveal window opens when commits close."
              : demo
                ? "Revealing…"
                : "Reveal window open: sign the reveal to enter the cross."}
          </p>
          {!demo && phase === "REVEAL" && currentBatch === order.batchId && (
            <button className="primary wide" disabled={busy} onClick={onReveal}>
              Reveal now
            </button>
          )}
        </>
      )}
      {order.stage === "revealed" && <p className="hint">Revealed. The batch settles after the reveal window closes.</p>}
      {order.stage === "missed" && (
        <>
          <p className="block-reason">The reveal window closed before this order was revealed, so it didn't enter the cross. Its tokens stay in your escrow.</p>
          <button className="primary wide" disabled={busy} onClick={() => onWithdraw([{ token: order.lockToken, amount: order.amount }])}>
            Withdraw {amount(order.amount, inTok.decimals, 4)} {inTok.symbol}
          </button>
        </>
      )}
      {order.stage === "settled" && (
        <div className="settled" data-testid="settled-result">
          <dl className="result-rows">
            <div>
              <dt>
                Crossed at the 30-min midpoint <small>1 bp venue fee · protocol</small>
              </dt>
              <dd>
                {sh(crossedIn, inTok)} → {cross ? sh(cross.amountOut, outTok) : "0.00"} sh
                {cross?.feeAmount && (
                  <small>
                    {" "}
                    · fee {amount(cross.feeAmount, outTok.decimals, 6)} {outTok.symbol}
                  </small>
                )}
              </dd>
            </div>
            <div>
              <dt>
                Residual via Convert <small>base + skew · LP</small>
              </dt>
              <dd>
                {sh(residualIn, inTok)} → {res ? sh(res.amountOut, outTok) : "0.00"} sh
                {res?.feeAmount && (
                  <small>
                    {" "}
                    · fee {amount(res.feeAmount, outTok.decimals, 6)} {outTok.symbol}
                  </small>
                )}
              </dd>
            </div>
            <div>
              <dt>Unfilled, refunded</dt>
              <dd>{sh(unfilled, inTok)} sh</dd>
            </div>
          </dl>
          {midX18 && <p className="hint">Midpoint {amount(midX18, 18, 6)} {quote.token.symbol}/{base.token.symbol}. Proceeds and refunds are in your Dark Cross escrow.</p>}
          <div className="row-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                onWithdraw([
                  { token: outTok.address, amount: (cross ? BigInt(cross.amountOut) : 0n) + (res ? BigInt(res.amountOut) : 0n) },
                  { token: inTok.address, amount: unfilled },
                ])
              }
            >
              Withdraw to wallet
            </button>
            <button type="button" className="ghost-btn" onClick={onDone}>
              New order
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function History({ asset, base, history }: { asset: Asset; base: Platform; history: Feed<"batches"> }) {
  const items = history.data?.items.filter((x) => x.settled) ?? [];
  return (
    <section className="dark-history" aria-label="Settled batches">
      <h3 className="card-title">Settled batches · {asset.symbol}</h3>
      {history.data ? (
        items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Crossed</th>
                  <th>Venue fee</th>
                  <th>Residual</th>
                  <th>Refunded</th>
                  <th>Settlement</th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.batchId}>
                    <td>#{x.batchId}</td>
                    <td>{x.crossedShares ? fmtShares(x.crossedShares) : fmtShares(toShares(BigInt(x.crossedBase), base.token))} sh</td>
                    <td>{x.protocolFeeShares ? `${fmtShares(x.protocolFeeShares, 4)} sh` : "—"}</td>
                    <td>{x.residualFilled ? `${fmtShares(x.residualFilled.reduce((s, r) => s + toShares(BigInt(r.amountIn), asset.platforms.find((p) => p.token.address.toLowerCase() === r.tokenIn.toLowerCase())?.token ?? base.token), 0n))} sh` : "—"}</td>
                    <td>{x.unfilledRefunded ? `${fmtShares(x.unfilledRefunded.shares)} sh` : "—"}</td>
                    <td>{x.settledTx ? <Hex value={x.settledTx} kind="tx" simulated={import.meta.env.VITE_USE_MOCKS === "true"} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No settled batches for {asset.symbol} yet.</Empty>
        )
      ) : (
        <Val status={history.status} w="100%" h="4em">
          {null}
        </Val>
      )}
    </section>
  );
}
