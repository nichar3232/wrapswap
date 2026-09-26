import { useEffect, useState } from "react";
import { encodeAbiParameters, formatUnits, keccak256, parseUnits, toHex, type Hash } from "viem";
import type { Address, BatchPhase, Deployment } from "@wrapswap/types";
import { config } from "../config";
import { useApi } from "../hooks/useApi";
import { amount } from "../lib/format";
import { approve, darkSend, isDemo, verifyOrder } from "../wallet";
import { BatchTimeline, blocksToCross } from "./BatchTimeline";
import { useTx } from "./tx";
import { Hex, Skeleton, Spinner, TxPanel, Val } from "./ui";
import { useWallet } from "./wallet";

type SavedOrder = {
  chainId: number;
  account: Address;
  hook: Address;
  batchId: string;
  sellBase: boolean;
  amount: string;
  limit: string;
  salt: Address;
  confirmed: boolean;
  revealed?: boolean;
  settled?: boolean;
  txs: { commit?: Hash; reveal?: Hash; settle?: Hash };
  simulated: boolean;
};
const zero32 = toHex(new Uint8Array(32));
const issuer = (t: { issuer: string }) => (t.issuer === "coinbase" ? "Coinbase" : "xStocks");

export function DarkCross({ d }: { d: Deployment | undefined }) {
  const w = useWallet();
  const batch = useApi("currentBatch"),
    history = useApi("batches");
  const orders = useApi("orders", w.address || null);
  const tx = useTx();
  const storageKey = d && w.address && `wrapswap:${d.chainId}:${d.contracts.darkCrossHook}:${w.address}`;
  const [saved, setSaved] = useState<SavedOrder>();
  const [mockPhase, setMockPhase] = useState<BatchPhase>("COMMIT");
  const [sellBase, setSellBase] = useState(true);
  const [input, setInput] = useState("50");
  const [limitInput, setLimitInput] = useState("");
  const [details, setDetails] = useState(false);
  useEffect(() => {
    if (!storageKey) return setSaved(undefined);
    try {
      const value = localStorage.getItem(storageKey);
      setSaved(value ? JSON.parse(value) : undefined);
    } catch {
      setSaved(undefined);
    }
  }, [storageKey]);
  const store = (o: SavedOrder | undefined) => {
    try {
      if (o) localStorage.setItem(storageKey!, JSON.stringify(o));
      else localStorage.removeItem(storageKey!);
    } catch {
      /* storage blocked: the order lives for this page only */
    }
    setSaved(o);
  };

  // With mock data the batch never advances on its own, so the demo steps it after each action.
  const phase: BatchPhase | undefined = config.useMocks ? mockPhase : batch.data?.phase;
  const realLeft = batch.data ? Math.max(0, Number(batch.data.phaseEndsBlock) - Number(batch.data.blockNumber)) : undefined;
  const blocksLeft = config.useMocks && batch.data ? { COMMIT: realLeft!, REVEAL: 4, SETTLE: 1 }[mockPhase] : realLeft;
  const base = d?.tokens.find((t) => t.address === d.dark.baseToken),
    quote = d?.tokens.find((t) => t.address === d.dark.quoteToken);
  const sold = sellBase ? base : quote;
  const mid = batch.data?.oracle.midX18 ? BigInt(batch.data.oracle.midX18) : undefined;
  let raw = 0n;
  try {
    if (sold && /^\d+(\.\d*)?$/.test(input)) raw = parseUnits(input, sold.decimals);
  } catch {
    raw = 0n;
  }
  let limit = mid ?? 0n;
  try {
    if (/^\d+(\.\d*)?$/.test(limitInput)) limit = parseUnits(limitInput, 18);
  } catch {
    /* keep oracle mid */
  }
  const balance = sold ? w.balances.values[sold.address] : undefined;
  const stale = !!batch.data?.oracle.stale;
  const toCross = phase && blocksLeft !== undefined && d ? blocksToCross(phase, blocksLeft, d.dark) : undefined;

  const place = () =>
    tx.run("Sealed order", async (onHash) => {
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const o: SavedOrder = {
        chainId: d!.chainId,
        account: w.address!,
        hook: d!.contracts.darkCrossHook,
        batchId: batch.data!.batchId,
        sellBase,
        amount: raw.toString(),
        limit: limit.toString(),
        salt,
        confirmed: false,
        txs: {},
        simulated: isDemo(),
      };
      store(o);
      await approve(d!, w.address!, sold!.address, d!.contracts.darkCrossHook, raw, { onHash });
      await darkSend(d!, w.address!, "fund", [sold!.address, raw], { onHash });
      const hash = keccak256(
        encodeAbiParameters(
          [
            { type: "uint256" },
            { type: "address" },
            { type: "uint256" },
            { type: "address" },
            { type: "bool" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bool" },
            { type: "bytes32" },
          ],
          [BigInt(d!.chainId), d!.contracts.darkCrossHook, BigInt(o.batchId), w.address!, sellBase, raw, limit, true, salt],
        ),
      );
      const sent = await darkSend(d!, w.address!, "commit", [hash, sold!.address, raw, w.uid || zero32], { onHash });
      await verifyOrder(d!, w.address!, o.batchId, hash);
      store({ ...o, confirmed: true, txs: { commit: sent.hash } });
      if (config.useMocks) setMockPhase("REVEAL");
      w.adjust(sold!.address, -raw);
      orders.refresh();
      return { hash: sent.hash, simulated: sent.simulated, result: null };
    });
  const reveal = () =>
    tx.run("Reveal", async (onHash) => {
      const sent = await darkSend(
        d!,
        w.address!,
        "reveal",
        [saved!.sellBase, BigInt(saved!.amount), BigInt(saved!.limit), true, saved!.salt],
        { onHash },
      );
      await verifyOrder(d!, w.address!, saved!.batchId);
      store({ ...saved!, revealed: true, txs: { ...saved!.txs, reveal: sent.hash } });
      if (config.useMocks) setMockPhase("SETTLE");
      orders.refresh();
      return { hash: sent.hash, simulated: sent.simulated, result: null };
    });
  const settle = () =>
    tx.run("Cross", async (onHash) => {
      const sent = await darkSend(d!, w.address!, "settle", [BigInt(batch.data!.batchId)], { onHash });
      if (saved) store({ ...saved, settled: true, txs: { ...saved.txs, settle: sent.hash } });
      if (config.useMocks) setMockPhase("COMMIT");
      history.refresh();
      orders.refresh();
      return { hash: sent.hash, simulated: sent.simulated, result: null };
    });

  const canPlace = w.ready && w.eligible && !!batch.data && phase === "COMMIT" && raw > 0n && limit > 0n && !tx.busy &&
    !(saved && saved.confirmed && !saved.settled && saved.batchId === batch.data?.batchId) &&
    !(w.balances.status === "ok" && balance !== undefined && raw > balance);
  const placeReason = !w.address
    ? ""
    : phase && phase !== "COMMIT"
      ? `Orders open in the next commit window (${toCross ?? "—"} blocks).`
      : raw === 0n
        ? "Enter an amount."
        : w.balances.status === "ok" && balance !== undefined && raw > balance
          ? `Insufficient ${sold?.symbol} balance.`
          : w.eligibility.data && !w.eligible
            ? "A valid issuer eligibility attestation is required."
            : "";

  // Rows: this browser's order (with tx links) plus the API's orders for the wallet.
  type Row = { batchId: string; status: "sealed" | "revealed" | "filled"; txs: SavedOrder["txs"]; simulated: boolean; label: string };
  const settledIds = new Set(history.data?.items.filter((h) => h.settled).map((h) => h.batchId));
  const rows: Row[] = [];
  if (saved?.confirmed && base && quote) {
    const t = saved.sellBase ? base : quote;
    rows.push({
      batchId: saved.batchId,
      status: saved.settled || settledIds.has(saved.batchId) ? "filled" : saved.revealed ? "revealed" : "sealed",
      txs: saved.txs,
      simulated: saved.simulated,
      label: `Sell ${amount(saved.amount, t.decimals, 4)} ${t.symbol} · limit ${amount(saved.limit, 18, 4)}`,
    });
  }
  for (const o of orders.data?.items ?? [])
    if (!rows.some((r) => r.batchId === o.batchId))
      rows.push({
        batchId: o.batchId,
        status: settledIds.has(o.batchId) ? "filled" : o.revealed ? "revealed" : "sealed",
        txs: {},
        simulated: false,
        label: "Sealed order",
      });
  const last = history.data?.items.find((h) => h.settled);
  const action =
    saved?.confirmed && !saved.settled && saved.batchId === batch.data?.batchId
      ? !saved.revealed
        ? { label: "Reveal order", run: reveal, enabled: phase === "REVEAL" && w.ready && !tx.busy }
        : { label: "Settle batch", run: settle, enabled: phase === "SETTLE" && !stale && w.ready && !tx.busy }
      : undefined;

  return (
    <div className="page dark-page">
      <section className="card order-form" aria-label="Place a sealed order">
        <h2 className="card-title">Sealed order</h2>
        <div className="seg-row" role="group" aria-label="Wrapper to sell">
          {[base, quote].map((t, i) =>
            t ? (
              <button
                key={t.address}
                type="button"
                aria-pressed={sellBase === (i === 0)}
                onClick={() => {
                  setSellBase(i === 0);
                  tx.reset();
                }}
              >
                Sell {t.symbol} <small>{issuer(t)}</small>
              </button>
            ) : (
              <Skeleton key={i} w="9em" h="2.4em" />
            ),
          )}
        </div>
        <div className="form-field">
          <span className="field-top">
            <span className="field-label">Amount</span>
            {w.address && sold && (
              <span className="balance">
                Balance{" "}
                <Val status={w.balances.status} w="4em">
                  {amount(balance ?? 0n, sold.decimals, 4)} {sold.symbol}
                </Val>
                {w.balances.status === "ok" && balance !== undefined && balance > 0n && (
                  <button type="button" className="max" onClick={() => setInput(formatUnits(balance, sold.decimals))}>
                    Max
                  </button>
                )}
              </span>
            )}
          </span>
          <span className="input-row">
            <input
              className="amount"
              inputMode="decimal"
              aria-label="Order amount"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <span className="unit">{sold?.symbol}</span>
          </span>
        </div>
        <div className="form-field">
          <span className="field-label">
            Limit price · {quote?.symbol} per {base?.symbol}
          </span>
          <span className="input-row">
            <input
              className="amount small"
              inputMode="decimal"
              aria-label="Limit price"
              placeholder={mid ? formatUnits(mid, 18) : "oracle mid"}
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
            />
            {limitInput && mid && (
              <button type="button" className="link-btn" onClick={() => setLimitInput("")}>
                Use oracle mid
              </button>
            )}
          </span>
          <span className="hint">{limitInput ? (sellBase ? "Minimum price you accept." : "Maximum price you pay.") : "Defaults to the oracle mid."}</span>
        </div>
        {placeReason && !action && (
          <p role="alert" className="block-reason">
            {placeReason}
          </p>
        )}
        {!w.address ? (
          <button className="primary wide" disabled={!!w.busy} onClick={() => void w.connect()}>
            {w.busy === "connect" ? "Connecting…" : "Connect to trade"}
          </button>
        ) : w.wrongChain ? (
          <button className="primary wide" disabled={!!w.busy} onClick={() => void w.switchChain()}>
            Switch to {w.expected.name}
          </button>
        ) : action ? (
          <button className="primary wide" disabled={!action.enabled} aria-busy={tx.busy || undefined} onClick={action.run}>
            {tx.busy && <Spinner />}
            {action.label}
          </button>
        ) : (
          <button className="primary wide" disabled={!canPlace} aria-busy={tx.busy || undefined} onClick={place}>
            {tx.busy && <Spinner />}
            Place sealed order
          </button>
        )}
        <TxPanel
          tx={tx.state}
          onRetry={tx.retry}
          receipt={() =>
            tx.state.step === "confirmed" && (
              <p>
                <span className="ok-dot" aria-hidden="true" />{" "}
                {tx.state.label === "Sealed order"
                  ? "Order sealed. Reveal it in the reveal window; the secret is saved in this browser."
                  : tx.state.label === "Reveal"
                    ? "Reveal confirmed. It crosses at the oracle mid when the batch settles."
                    : "Batch crossed: your order filled at the oracle mid; any residual routed through ParityHook."}
                {tx.state.simulated ? " (simulated)" : ""}
                {tx.state.hash && (
                  <>
                    {" "}
                    <Hex value={tx.state.hash} kind="tx" simulated={tx.state.simulated} />
                  </>
                )}
              </p>
            )
          }
        />
      </section>

      <div className="dark-side">
        <section className="card batch-status" aria-label="Current batch">
          <p className="status-line" role="timer">
            <Val status={batch.status} w="16em">
              {phase === "SETTLE" ? (
                <>
                  <strong>Crossing now</strong>
                </>
              ) : (
                <>
                  Next cross in <strong>{toCross} blocks</strong>
                  {config.network === "unichain-sepolia" && toCross !== undefined && <span className="muted"> (≈ {toCross} s)</span>}
                </>
              )}
              <span className="muted"> · crosses at the 30-min oracle mid</span>
            </Val>
          </p>
          {d ? <BatchTimeline phase={batch.data ? phase : undefined} blocksLeft={blocksLeft} dark={d.dark} /> : <Skeleton w="100%" h="34px" />}
          <p className="mid-line">
            Oracle mid{" "}
            <Val status={batch.status} w="5em">
              {mid ? (
                <strong>
                  {amount(mid, 18, 4)} {quote?.symbol}/{base?.symbol}
                </strong>
              ) : (
                <span className="val-na">
                  — <small>unavailable</small>
                </span>
              )}
            </Val>
            {stale && <span className="warn"> · stale, crossing paused</span>}
          </p>
          <button type="button" className="disclosure" aria-expanded={details} onClick={() => setDetails(!details)}>
            Details
          </button>
          {details &&
            (last && base && quote ? (
              <dl className="quote">
                <dt>Last crossed batch</dt>
                <dd>#{last.batchId}</dd>
                <dt>Crossed</dt>
                <dd>
                  {amount(last.crossedBase, base.decimals, 4)} {base.symbol} ↔ {amount(last.crossedQuote, quote.decimals, 4)} {quote.symbol}
                </dd>
                <dt>Residual to pool</dt>
                <dd>
                  {amount(last.residualBaseIn, base.decimals, 4)} {base.symbol}
                </dd>
                {last.settledTx && (
                  <>
                    <dt>Transaction</dt>
                    <dd>
                      <Hex value={last.settledTx} kind="tx" simulated={config.useMocks} />
                    </dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="muted">
                <Val status={history.status} w="12em">
                  No batch has crossed yet.
                </Val>
              </p>
            ))}
        </section>

        {rows.length > 0 && (
          <section className="card" aria-label="Your orders">
            <h2 className="card-title">Your orders</h2>
            <ul className="orders">
              {rows.map((r) => (
                <li key={r.batchId}>
                  <span>
                    Batch #{r.batchId} · {r.label}
                  </span>
                  <span className={`chip ${r.status === "filled" ? "good" : r.status === "revealed" ? "warn" : ""}`}>{r.status}</span>
                  <span className="order-txs">
                    {(["commit", "reveal", "settle"] as const).map(
                      (k) =>
                        r.txs[k] && (
                          <span key={k} className="order-tx">
                            {k} <Hex value={r.txs[k]!} kind="tx" simulated={r.simulated} />
                          </span>
                        ),
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

      </div>
    </div>
  );
}
