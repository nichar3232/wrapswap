import { useEffect, useRef, useState } from "react";
import { encodeAbiParameters, formatUnits, isAddress, keccak256, parseUnits, toHex, zeroAddress, type Hash } from "viem";
import { canonical, type Address, type BatchPhase, type Deployment, type Route } from "@wrapswap/types";
import { Fees, RouteBadge } from "../components";
import { config } from "../config";
import { useApi, type Feed } from "../hooks/useApi";
import { amount } from "../lib/format";
import { allowance, approve, convertExactIn, darkSend, isDemo, swapOutcome, verifyOrder } from "../wallet";
import { assetsOf, toShares, type Platform } from "./assets";
import { BatchTimeline, blocksToCross } from "./BatchTimeline";
import { pipsToBps, quoteSummary } from "./fees";
import { SwapAnatomy, type SwapPath } from "./SwapAnatomy";
import { useTx } from "./tx";
import type { MoveIntent } from "./types";
import { Hex, Skeleton, Spinner, TxPanel, Val } from "./ui";
import { useWallet } from "./wallet";

/** Share counts always with two decimals, e.g. "101.25", "101.10". */
export const fmtShares = (x: bigint | string) => {
  const [w, f = ""] = amount(x, 18, 2).split(".");
  return `${w}.${f.padEnd(2, "0")}`;
};
const STEPS = ["From", "To", "How", "Review", "Done"] as const;
const zero32 = toHex(new Uint8Array(32));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type InstantReceipt = {
  kind: "instant";
  hash?: Hash;
  simulated: boolean;
  sharesIn: bigint;
  sharesOut: bigint;
  amountOut: bigint;
  feeAmount: bigint;
  feeBps: string;
  path: SwapPath;
  exact: boolean;
};
type SealedPhase = "sealing" | "sealed" | "revealed" | "crossed";
type Sealed = {
  phase: SealedPhase;
  simulated: boolean;
  batchId: string;
  sellBase: boolean;
  amount: bigint;
  limit: bigint;
  salt: Address;
  mid: bigint;
  txs: { commit?: Hash; reveal?: Hash; settle?: Hash };
  crossedOut?: bigint;
  crossFee?: bigint;
  residualIn?: bigint;
  residualOut?: bigint;
};

export function Move({ d, pool, intent }: { d: Deployment | undefined; pool: Feed<"pool">; intent?: MoveIntent }) {
  const w = useWallet();
  const assets = assetsOf(d);
  const [assetIx, setAssetIx] = useState(0);
  const asset = assets[assetIx];
  const [step, setStep] = useState(0);
  const [fromAddr, setFromAddr] = useState<string>();
  const [toAddr, setToAddr] = useState<string>();
  const [input, setInput] = useState("100");
  const [deliver, setDeliver] = useState<"me" | "other">("me");
  const [other, setOther] = useState("");
  const [method, setMethod] = useState<"instant" | "sealed">("instant");
  const [limitInput, setLimitInput] = useState("");
  const [details, setDetails] = useState(false);
  const [receipt, setReceipt] = useState<InstantReceipt>();
  const [sealed, setSealed] = useState<Sealed>();
  const [approvedKey, setApprovedKey] = useState("");
  const tx = useTx<unknown>();

  // Portfolio / Liquidity hand over a starting point.
  useEffect(() => {
    if (!intent || !d) return;
    const ix = assets.findIndex((a) => a.platforms.some((p) => p.token.address.toLowerCase() === intent.fromToken.toLowerCase()));
    if (ix >= 0) setAssetIx(ix);
    setFromAddr(intent.fromToken);
    setToAddr(undefined);
    setStep(0);
    setReceipt(undefined);
    setSealed(undefined);
    tx.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.nonce, d]);

  const demo = isDemo();
  const bal = (p: Platform) => w.balances.values[p.token.address];
  // In real-wallet mode only platforms holding this asset can be moved from.
  const sources = (asset?.platforms ?? []).filter((p) => demo || w.balances.status !== "ok" || (bal(p) ?? 0n) > 0n);
  const from = sources.find((p) => p.token.address === fromAddr) ?? sources[0];
  const dests = (asset?.platforms ?? []).filter((p) => p !== from);
  const to = dests.find((p) => p.token.address === toAddr) ?? dests[0];
  const a = from?.token,
    b = to?.token;

  let raw = 0n;
  try {
    if (a && /^\d+(\.\d*)?$/.test(input) && (input.split(".")[1]?.length || 0) <= a.decimals) raw = parseUnits(input, a.decimals);
  } catch {
    raw = 0n;
  }
  const balance = from ? bal(from) : undefined;
  const overBalance = w.balances.status === "ok" && balance !== undefined && raw > balance;
  const otherValid = isAddress(other) && other.toLowerCase() !== zeroAddress;
  const recipient = deliver === "me" ? w.address : otherValid ? (other as Address) : undefined;

  // Instant quote (and the route, which checks eligibility for the swapper).
  const params =
    a && b && raw > 0n ? new URLSearchParams({ tokenIn: a.address, tokenOut: b.address, amount: raw.toString(), kind: "exactIn" }) : null;
  const quote = useApi("quote", params ? params.toString() : null);
  if (params) {
    params.set("swapper", w.address || a!.address);
    params.set("allowDark", "false");
    if (w.uid) params.set("attestationUid", w.uid);
  }
  const route = useApi("route", w.address && params ? params.toString() : null);
  const q = w.address ? route.data?.quote ?? quote.data : quote.data;
  const activeRoute: Route | undefined =
    w.address && w.eligibility.data && !w.eligible
      ? "BLOCKED-ELIGIBILITY"
      : route.data?.route || (q ? (q.fillable ? "PARITY" : "FALL-THROUGH") : undefined);
  const output = route.data?.route === "FALL-THROUGH" ? route.data.fallThrough?.amountOut : q?.amountOut;
  const summary = q && b && output ? quoteSummary({ ...q, amountOut: output }, b) : undefined;
  const minOut = output ? (BigInt(output) * 995n) / 1000n : 0n;
  const quoteStatus = !params ? "ok" : w.address ? (route.data ? "ok" : route.status) : quote.status;

  // Sealed cross: DarkCrossHook crosses at the oracle mid; crossed volume pays CROSS_FEE_PIPS (canonical.crossFee),
  // any unmatched residual routes through the ParityHook pool at its fee.
  const batch = useApi("currentBatch");
  const history = useApi("batches", "", 8000);
  const accountFills = useApi("fills", sealed && w.address ? `account=${w.address}` : null, 6000);
  const mid = batch.data?.oracle.midX18 ? BigInt(batch.data.oracle.midX18) : undefined;
  const base = d?.tokens.find((t) => t.address === d.dark.baseToken),
    quoteTok = d?.tokens.find((t) => t.address === d.dark.quoteToken);
  const sellBase = !!a && !!base && a.address === base.address;
  let limit = mid ?? 0n;
  try {
    if (/^\d+(\.\d*)?$/.test(limitInput)) limit = parseUnits(limitInput, 18);
  } catch {
    /* oracle mid */
  }
  const cross = (price: bigint) => {
    if (!base || !quoteTok || price === 0n || raw === 0n) return undefined;
    const gross = sellBase
      ? canonical.baseAsQuote(raw, price, base.decimals, quoteTok.decimals)
      : canonical.quoteAsBase(raw, price, base.decimals, quoteTok.decimals);
    const fee = canonical.crossFee(gross);
    return { gross, fee, net: gross - fee };
  };
  const atMid = mid ? cross(mid) : undefined;
  const atLimit = limit ? cross(limit) : undefined;
  const phase: BatchPhase | undefined = batch.data?.phase;
  const blocksLeft = batch.data ? Math.max(0, Number(batch.data.phaseEndsBlock) - Number(batch.data.blockNumber)) : undefined;
  const toCross = phase && blocksLeft !== undefined && d ? blocksToCross(phase, blocksLeft, d.dark) : undefined;
  const sealedAvailable = !!asset?.darkCross && deliver === "me";
  useEffect(() => {
    if (!sealedAvailable && method === "sealed") setMethod("instant");
  }, [sealedAvailable, method]);

  const router = d?.contracts.wrapSwapRouter ?? undefined;
  const approvalKey = `${w.address}:${a?.address}:${raw}`;
  useEffect(() => {
    if (demo || !w.ready || !a || !router || raw === 0n || method !== "instant") return;
    let live = true;
    allowance(a.address, w.address!, router).then(
      (v) => live && v >= raw && setApprovedKey(approvalKey),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [demo, w.ready, w.address, a, router, raw, approvalKey, method]);

  const blockedReason =
    raw === 0n
      ? "Enter an amount."
      : overBalance
        ? `Not enough ${a?.symbol} on ${from?.name}.`
        : activeRoute === "BLOCKED-ELIGIBILITY"
          ? "This wallet has no issuer eligibility attestation. A valid issuer eligibility attestation is required."
          : activeRoute === "BLOCKED-PEG"
            ? route.data?.reason || "Paused: the pool is more than 50 bps from NAV parity."
            : "";

  const runInstant = async () => {
    if (approvedKey !== approvalKey) {
      const ok = await tx.run("Approval", async (onHash) => {
        const sent = await approve(d!, w.address!, a!.address, router ?? d!.contracts.swapRouter, raw, { onHash });
        setApprovedKey(approvalKey);
        return { hash: sent.hash, simulated: sent.simulated, result: "approved" };
      });
      if (!ok) return;
    }
    const done = await tx.run("Conversion", async (onHash) => {
      const sent = await convertExactIn(d!, w.address!, a!.address, raw, minOut, w.uid, { onHash, recipient });
      const outcome = sent.receipt && recipient ? swapOutcome(sent.receipt, b!.address, recipient) : undefined;
      const out = outcome?.amountOut ?? BigInt(output!);
      const s = quoteSummary({ ...q!, amountOut: out.toString() }, b!);
      setApprovedKey("");
      w.adjust(a!.address, -raw);
      if (recipient?.toLowerCase() === w.address?.toLowerCase()) w.adjust(b!.address, out);
      setReceipt({
        kind: "instant",
        hash: sent.hash,
        simulated: sent.simulated,
        sharesIn: s.sharesIn,
        sharesOut: s.sharesOut,
        amountOut: out,
        feeAmount: s.feeAmount,
        feeBps: q!.fee.totalBps,
        path: outcome?.path ?? (activeRoute === "FALL-THROUGH" ? "fall-through" : "inventory"),
        exact: !!outcome?.amountOut,
      });
      setStep(4);
      return { hash: sent.hash, simulated: sent.simulated, result: "converted" };
    });
    // The Done step carries the receipt; clear the Review step's panel so it isn't shown twice.
    if (done) tx.reset();
  };

  const commitHash = (o: { batchId: string; sellBase: boolean; amount: bigint; limit: bigint; salt: Address }) =>
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
          { type: "bool" },
          { type: "bytes32" },
        ],
        [BigInt(d!.chainId), d!.contracts.darkCrossHook, BigInt(o.batchId), w.address!, o.sellBase, o.amount, o.limit, true, o.salt],
      ),
    );
  const runSealed = async () => {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const o = { batchId: batch.data!.batchId, sellBase, amount: raw, limit, salt };
    const done = await tx.run("Sealed order", async (onHash) => {
      await approve(d!, w.address!, a!.address, d!.contracts.darkCrossHook, raw, { onHash });
      await darkSend(d!, w.address!, "fund", [a!.address, raw], { onHash });
      const h = commitHash(o);
      const sent = await darkSend(d!, w.address!, "commit", [h, a!.address, raw, w.uid || zero32], { onHash });
      await verifyOrder(d!, w.address!, o.batchId, h);
      w.adjust(a!.address, -raw);
      setSealed({ ...o, phase: "sealed", simulated: sent.simulated, mid: mid!, txs: { commit: sent.hash } });
      setStep(4);
      return { hash: sent.hash, simulated: sent.simulated, result: "sealed" };
    });
    if (done) tx.reset();
  };

  // Sealed tracker. Demo: each phase takes ~4 s with simulated txs. Real wallet: reveal in the reveal window
  // (the wallet signs), then the crank settles; the receipt comes from this account's fills for the batch.
  const revealing = useRef(false);
  const reveal = async () => {
    if (!sealed || revealing.current) return;
    revealing.current = true;
    await tx.run("Reveal", async (onHash) => {
      const sent = await darkSend(d!, w.address!, "reveal", [sealed.sellBase, sealed.amount, sealed.limit, true, sealed.salt], { onHash });
      await verifyOrder(d!, w.address!, sealed.batchId);
      setSealed((s) => s && { ...s, phase: "revealed", txs: { ...s.txs, reveal: sent.hash } });
      return { hash: sent.hash, simulated: sent.simulated, result: "revealed" };
    });
    revealing.current = false;
  };
  useEffect(() => {
    if (!sealed || !sealed.simulated) return;
    let live = true;
    (async () => {
      if (sealed.phase === "sealed") {
        await pause(4000);
        if (live) await reveal();
      } else if (sealed.phase === "revealed") {
        await pause(4000);
        if (!live) return;
        const settle = await darkSend(d!, w.address!, "settle", [BigInt(sealed.batchId)]).catch(() => undefined);
        const c = cross(sealed.mid);
        if (!live || !c) return;
        w.adjust(b!.address, c.net);
        setSealed((s) => s && { ...s, phase: "crossed", crossedOut: c.net, crossFee: c.fee, residualIn: 0n, residualOut: 0n, txs: { ...s.txs, settle: settle?.hash } });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sealed?.phase, sealed?.simulated]);
  // Real wallet: finish when the batch settles.
  useEffect(() => {
    if (!sealed || sealed.simulated || sealed.phase === "crossed") return;
    const settled = history.data?.items.find((h) => h.batchId === sealed.batchId && h.settled);
    if (!settled) return;
    const mine = accountFills.data?.items.filter((f) => f.batchId === sealed.batchId) ?? [];
    const crossFill = mine.find((f) => f.kind === "DARK-CROSS"),
      residual = mine.find((f) => f.kind === "DARK-RESIDUAL");
    setSealed((s) =>
      s && {
        ...s,
        phase: "crossed",
        crossedOut: crossFill ? BigInt(crossFill.amountOut) : 0n,
        crossFee: crossFill?.feeAmount ? BigInt(crossFill.feeAmount) : 0n,
        residualIn: residual ? BigInt(residual.amountIn) : 0n,
        residualOut: residual ? BigInt(residual.amountOut) : 0n,
        txs: { ...s.txs, settle: settled.settledTx ?? undefined },
      },
    );
  }, [sealed, history.data, accountFills.data]);

  const reset = () => {
    setStep(0);
    setReceipt(undefined);
    setSealed(undefined);
    tx.reset();
  };
  const underlying = asset?.symbol ?? "";
  const sharesIn = a ? toShares(raw, a) : 0n;
  const sealedSharesOut = atMid && b ? toShares(atMid.net, b) : undefined;
  const reviewOut = method === "instant" ? summary?.sharesOut : sealedSharesOut;
  const rate = a && b ? (BigInt(a.sharesPerTokenX18) * 10n ** 18n) / BigInt(b.sharesPerTokenX18) : undefined;
  const canNext = [
    !!a && raw > 0n && !overBalance,
    !!b && (deliver === "me" || otherValid),
    method === "instant" ? !!summary && !activeRoute?.startsWith("BLOCKED") : !!atMid && !!batch.data && !batch.data.oracle.stale,
  ];

  const stepPanel = (i: number, body: React.ReactNode) => (
    <section className="step" aria-label={`Step ${i + 1}: ${STEPS[i]}`} inert={i !== step} aria-hidden={i !== step}>
      <div className="step-body">{body}</div>
    </section>
  );
  const nextBtn = (i: number) => (
    <button className="primary wide" disabled={!canNext[i]} onClick={() => setStep(i + 1)}>
      Next
    </button>
  );

  return (
    <div className="page move">
      <div className="card move-card">
        <div className="move-head">
          {step > 0 && step < 4 ? (
            <button type="button" className="back" onClick={() => setStep(step - 1)} aria-label="Back">
              ← Back
            </button>
          ) : (
            <span />
          )}
          <ol className="stepper" aria-label="Move steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
                <span className="dot">{i + 1}</span> {s}
              </li>
            ))}
          </ol>
        </div>
        <div className="steps-viewport">
          <div className="steps-track" style={{ transform: `translateX(${-step * 100}%)` }}>
            {stepPanel(
              0,
              <>
                <h2 className="step-title">
                  Move {underlying || <Skeleton w="3em" />} from
                  {assets.length > 1 && (
                    <select className="token inline" aria-label="Asset" value={assetIx} onChange={(e) => setAssetIx(Number(e.target.value))}>
                      {assets.map((x, i) => (
                        <option key={x.symbol} value={i}>
                          {x.symbol}
                        </option>
                      ))}
                    </select>
                  )}
                </h2>
                <div className="choices" role="radiogroup" aria-label="From platform">
                  {sources.map((p) => (
                    <button
                      key={p.token.address}
                      type="button"
                      role="radio"
                      aria-checked={p === from}
                      className="choice"
                      onClick={() => setFromAddr(p.token.address)}
                    >
                      <span className="choice-name">{p.name}</span>
                      <span className="choice-sub">
                        {p.token.symbol}
                        {w.balances.status === "ok" && bal(p) !== undefined && ` · ${fmtShares(toShares(bal(p)!, p.token))} shares`}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="input-row big">
                  <input
                    className="amount"
                    inputMode="decimal"
                    aria-label="Move amount"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                  />
                  <span className="unit">{a?.symbol}</span>
                  {balance !== undefined && balance > 0n && (
                    <button type="button" className="max" onClick={() => setInput(formatUnits(balance, a!.decimals))}>
                      Max
                    </button>
                  )}
                </div>
                <p className="hint">
                  {a && raw > 0n ? `${fmtShares(sharesIn)} ${underlying} shares` : " "}
                  {overBalance && <span className="warn"> · not enough on {from?.name}</span>}
                </p>
                {nextBtn(0)}
              </>,
            )}
            {stepPanel(
              1,
              <>
                <h2 className="step-title">To</h2>
                <div className="choices" role="radiogroup" aria-label="To platform">
                  {dests.map((p) => (
                    <button key={p.token.address} type="button" role="radio" aria-checked={p === to} className="choice" onClick={() => setToAddr(p.token.address)}>
                      <span className="choice-name">{p.name}</span>
                      <span className="choice-sub">{p.token.symbol}</span>
                    </button>
                  ))}
                </div>
                {/* Instant (WrapSwapRouter.swapExactIn) takes a recipient, so delivery to another address is offered. */}
                <div className="deliver">
                  <span className="field-label">Deliver to</span>
                  <div className="seg-row" role="radiogroup" aria-label="Deliver to">
                    <button type="button" role="radio" aria-checked={deliver === "me"} onClick={() => setDeliver("me")}>
                      My wallet {w.address && <small className="mono">{w.address.slice(0, 6)}…{w.address.slice(-4)}</small>}
                    </button>
                    <button type="button" role="radio" aria-checked={deliver === "other"} onClick={() => setDeliver("other")}>
                      Another address
                    </button>
                  </div>
                  {deliver === "other" && (
                    <>
                      <input
                        className="addr-input mono"
                        aria-label="Recipient address"
                        placeholder="0x…"
                        value={other}
                        spellCheck={false}
                        onChange={(e) => setOther(e.target.value.trim())}
                        aria-invalid={other !== "" && !otherValid}
                      />
                      {other !== "" && !otherValid && (
                        <p role="alert" className="block-reason">
                          Enter a valid 0x address (40 hex characters, not the zero address).
                        </p>
                      )}
                    </>
                  )}
                </div>
                {nextBtn(1)}
              </>,
            )}
            {stepPanel(
              2,
              <>
                <h2 className="step-title">How</h2>
                <div className={`methods${sealedAvailable ? "" : " single"}`} role="radiogroup" aria-label="Method">
                  <button type="button" role="radio" aria-checked={method === "instant"} className="method" onClick={() => setMethod("instant")}>
                    <span className="method-name">Instant</span>
                    <span className="method-big">
                      <Val status={quoteStatus} w="4em">
                        {summary ? fmtShares(summary.sharesOut) : "—"}
                      </Val>{" "}
                      <small>{underlying} shares</small>
                    </span>
                    <span className="method-row">You keep {summary ? `${summary.keptPct.toFixed(2)}%` : "—"}</span>
                    <span className="method-row">
                      Fee {q ? `${q.fee.totalBps} bps · ${amount(q.feeAmount, b!.decimals, 4)} ${b!.symbol}` : "—"}
                    </span>
                    {q && !q.fee.marketOpen && (
                      <span className={`method-row ${q.fee.closedPips === 0 ? "good" : "warn"}`}>
                        {q.fee.closedPips === 0
                          ? "Rebalancing trade: no off-hours fee"
                          : `Market closed: +${pipsToBps(q.fee.closedPips).toFixed(2)} bps off-hours`}
                      </span>
                    )}
                    <span className="method-row muted">Settles now on Uniswap v4</span>
                  </button>
                  {sealedAvailable && (
                    <button type="button" role="radio" aria-checked={method === "sealed"} className="method" onClick={() => setMethod("sealed")}>
                      <span className="method-name">Sealed cross</span>
                      <span className="method-big">
                        <Val status={batch.status} w="4em">
                          {sealedSharesOut !== undefined ? fmtShares(sealedSharesOut) : "—"}
                        </Val>{" "}
                        <small>{underlying} shares if crossed</small>
                      </span>
                      <span className="method-row">
                        Worst case at your limit: {atLimit ? `${amount(atLimit.net, b!.decimals, 4)} ${b!.symbol}` : "—"}
                      </span>
                      <span className="method-row">
                        Fee {pipsToBps(canonical.CROSS_FEE_PIPS).toFixed(2)} bps on crossed volume · residual pays the pool fee
                      </span>
                      <span className="method-row muted">
                        Next cross in {toCross ?? "—"} blocks{config.network === "unichain-sepolia" && toCross !== undefined ? ` (≈ ${toCross} s)` : ""}
                      </span>
                    </button>
                  )}
                </div>
                {method === "sealed" && sealedAvailable && (
                  <div className="limit-row">
                    <span className="field-label">
                      Limit · {quoteTok?.symbol} per {base?.symbol}
                    </span>
                    <div className="input-row">
                      <input
                        className="amount small"
                        inputMode="decimal"
                        aria-label="Limit price"
                        value={limitInput || (mid ? formatUnits(mid, 18) : "")}
                        onChange={(e) => setLimitInput(e.target.value)}
                      />
                      {mid && limit === mid && <span className="chip good">= oracle mid</span>}
                    </div>
                  </div>
                )}
                {blockedReason && (
                  <p role="alert" className="block-reason">
                    {blockedReason}
                  </p>
                )}
                {nextBtn(2)}
              </>,
            )}
            {stepPanel(
              3,
              <>
                <h2 className="step-title">Review</h2>
                <p className="review-line" aria-live="polite">
                  <strong>{fmtShares(sharesIn)}</strong> {underlying} shares on <strong>{from?.name}</strong> →{" "}
                  <strong>{reviewOut !== undefined ? fmtShares(reviewOut) : "—"}</strong> {underlying} shares on <strong>{to?.name}</strong>
                </p>
                <dl className="review">
                  <dt>Recipient</dt>
                  <dd>{recipient ? (deliver === "me" ? "My wallet" : <Hex value={recipient} />) : "—"}</dd>
                  <dt>Method</dt>
                  <dd>{method === "instant" ? "Instant" : `Sealed cross · batch #${batch.data?.batchId ?? "—"}`}</dd>
                  <dt>Fee</dt>
                  <dd>
                    {method === "instant"
                      ? q
                        ? `${q.fee.totalBps} bps · ${amount(q.feeAmount, b!.decimals, 4)} ${b!.symbol}`
                        : "—"
                      : atMid
                        ? `${pipsToBps(canonical.CROSS_FEE_PIPS).toFixed(2)} bps on crossed volume · ${amount(atMid.fee, b!.decimals, 4)} ${b!.symbol}`
                        : "—"}
                  </dd>
                  {method === "instant" && summary && (
                    <>
                      <dt>You keep</dt>
                      <dd>{summary.keptPct.toFixed(2)}%</dd>
                    </>
                  )}
                </dl>
                {blockedReason && (
                  <p role="alert" className="block-reason">
                    {blockedReason}
                  </p>
                )}
                <button
                  className="primary wide"
                  disabled={!!blockedReason || tx.busy || !canNext[2] || !w.address}
                  aria-busy={tx.busy || undefined}
                  onClick={() => void (method === "instant" ? runInstant() : runSealed())}
                >
                  {tx.busy && <Spinner />}
                  {tx.state.step === "signing" ? "Confirm in wallet…" : tx.busy ? "Moving…" : "Move"}
                </button>
                <TxPanel tx={tx.state} onRetry={() => void (method === "instant" ? runInstant() : runSealed())} />
                <button type="button" className="disclosure" aria-expanded={details} onClick={() => setDetails(!details)}>
                  Details
                </button>
                {details && (
                  <div className="details-panel">
                    <dl className="quote">
                      <dt>NAV reference</dt>
                      <dd>{rate !== undefined ? `${amount(rate, 18, 6)} ${b!.symbol}/${a!.symbol}` : "—"}</dd>
                      <dt>Rate</dt>
                      <dd>{rate !== undefined ? `1 ${a!.symbol} = ${amount(rate, 18, 6)} ${b!.symbol}` : "—"}</dd>
                      <dt>Route</dt>
                      <dd>{method === "instant" ? activeRoute ? <RouteBadge route={activeRoute} /> : "—" : "Dark Cross batch"}</dd>
                      <dt>Peg guard</dt>
                      <dd>
                        <Val status={pool.status} w="6em">
                          {pool.data &&
                            (pool.data.pegTripped ? (
                              <span className="bad">Tripped · {pool.data.deviationBps} bps from NAV</span>
                            ) : (
                              <span className="good">Clear · {pool.data.deviationBps} bps from NAV</span>
                            ))}
                        </Val>
                      </dd>
                      <dt>Minimum received</dt>
                      <dd>
                        {method === "instant"
                          ? output
                            ? `${amount(minOut, b!.decimals, 6)} ${b!.symbol} (0.5% slippage)`
                            : "—"
                          : atLimit
                            ? `${amount(atLimit.net, b!.decimals, 6)} ${b!.symbol} (your limit)`
                            : "—"}
                      </dd>
                    </dl>
                    {method === "instant" && q && (
                      <div data-testid="fee-breakdown">
                        <Fees fee={q.fee} open />
                      </div>
                    )}
                    <SwapAnatomy path={receipt?.path ?? (activeRoute === "BLOCKED-PEG" ? "peg" : undefined)} />
                  </div>
                )}
              </>,
            )}
            {stepPanel(
              4,
              <>
                {receipt && (
                  <div className="receipt">
                    <p className="receipt-title">
                      <span className="ok-dot" aria-hidden="true" /> Conversion confirmed{receipt.simulated ? " (simulated)" : ""}
                    </p>
                    <p className="review-line">
                      <strong>{fmtShares(receipt.sharesIn)}</strong> {underlying} shares on {from?.name} → <strong>{fmtShares(receipt.sharesOut)}</strong>{" "}
                      {underlying} shares on {to?.name}
                    </p>
                    <dl>
                      <dt>Received</dt>
                      <dd>
                        {amount(receipt.amountOut, b!.decimals, 6)} {b!.symbol}
                        {!receipt.exact && <span className="muted"> (quoted)</span>}
                      </dd>
                      <dt>Recipient</dt>
                      <dd>{deliver === "me" ? "My wallet" : recipient && <Hex value={recipient} />}</dd>
                      <dt>Fee</dt>
                      <dd>
                        {amount(receipt.feeAmount, b!.decimals, 4)} {b!.symbol} · {receipt.feeBps} bps
                      </dd>
                      {receipt.hash && (
                        <>
                          <dt>Transaction</dt>
                          <dd>
                            <Hex value={receipt.hash} kind="tx" simulated={receipt.simulated} />
                          </dd>
                        </>
                      )}
                    </dl>
                  </div>
                )}
                {sealed && (
                  <div className="tracker">
                    <ol className="track-steps" aria-label="Sealed cross progress">
                      {(["sealed", "revealed", "crossed"] as const).map((p, i) => {
                        const order = ["sealed", "revealed", "crossed"].indexOf(sealed.phase);
                        return (
                          <li key={p} className={i < order ? "done" : i === order ? "on" : ""}>
                            {p === "sealed" ? "Sealed" : p === "revealed" ? "Revealed" : "Crossed"}
                            {sealed.txs[p === "sealed" ? "commit" : p === "revealed" ? "reveal" : "settle"] && (
                              <Hex value={sealed.txs[p === "sealed" ? "commit" : p === "revealed" ? "reveal" : "settle"]!} kind="tx" simulated={sealed.simulated} />
                            )}
                          </li>
                        );
                      })}
                    </ol>
                    {d && sealed.phase !== "crossed" && (
                      <BatchTimeline
                        phase={sealed.simulated ? (sealed.phase === "sealed" ? "COMMIT" : "REVEAL") : phase}
                        blocksLeft={sealed.simulated ? 2 : blocksLeft}
                        dark={d.dark}
                      />
                    )}
                    {!sealed.simulated && sealed.phase === "sealed" && phase === "REVEAL" && (
                      <button className="primary wide" disabled={tx.busy} onClick={() => void reveal()}>
                        Reveal now
                      </button>
                    )}
                    {sealed.phase === "crossed" && (
                      <div className="receipt">
                        <p className="receipt-title">
                          <span className="ok-dot" aria-hidden="true" /> Crossed at the oracle mid{sealed.simulated ? " (simulated)" : ""}
                        </p>
                        <dl>
                          <dt>Shares</dt>
                          <dd>
                            {fmtShares(toShares(sealed.amount, a!))} → {fmtShares(toShares(sealed.crossedOut ?? 0n, b!))} {underlying}
                          </dd>
                          <dt>Crossed at mid</dt>
                          <dd>
                            {amount(sealed.mid, 18, 4)} · {amount(sealed.crossedOut ?? 0n, b!.decimals, 4)} {b!.symbol}
                          </dd>
                          <dt>Residual via pool</dt>
                          <dd>
                            {amount(sealed.residualIn ?? 0n, a!.decimals, 4)} {a!.symbol} → {amount(sealed.residualOut ?? 0n, b!.decimals, 4)} {b!.symbol}
                          </dd>
                          <dt>Fees</dt>
                          <dd>
                            {amount(sealed.crossFee ?? 0n, b!.decimals, 4)} {b!.symbol} ({pipsToBps(canonical.CROSS_FEE_PIPS).toFixed(2)} bps on crossed volume)
                          </dd>
                        </dl>
                        {sealed.simulated && <p className="hint">Simulated: assumes your whole order matched in the batch.</p>}
                      </div>
                    )}
                    {sealed.phase !== "crossed" && <TxPanel tx={tx.state} onRetry={() => void reveal()} />}
                  </div>
                )}
                <button type="button" className="ghost-btn" onClick={reset}>
                  Move again
                </button>
              </>,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
