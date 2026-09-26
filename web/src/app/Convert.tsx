import { useEffect, useState } from "react";
import { formatUnits, parseUnits, type Hash } from "viem";
import type { Deployment, Route } from "@wrapswap/types";
import { Fees, RouteBadge } from "../components";
import { useApi, type Feed } from "../hooks/useApi";
import { amount } from "../lib/format";
import { allowance, approve, convertExactIn, isDemo, swapOutcome } from "../wallet";
import { SwapAnatomy, type SwapPath } from "./SwapAnatomy";
import { useTx } from "./tx";
import { Hex, Skeleton, Spinner, TxPanel, Val } from "./ui";
import { useWallet } from "./wallet";

const issuer = (t: { issuer: string }) => (t.issuer === "coinbase" ? "Coinbase" : "xStocks");
/** Share counts always with two decimals, e.g. "101.25", "101.10". */
const shares = (x: bigint | string) => {
  const [w, f = ""] = amount(x, 18, 2).split(".");
  return `${w}.${f.padEnd(2, "0")}`;
};
/** Share of value kept after the hook fee, e.g. 1460 pips → "99.85%". */
const keptPct = (pips: number) => `${((1_000_000 - pips) / 10_000).toFixed(2)}%`;

type Receipt = {
  hash?: Hash;
  simulated: boolean;
  amountIn: bigint;
  amountOut: bigint;
  shares: bigint;
  sharesOut: bigint;
  feeBps: string;
  path: SwapPath;
  exact: boolean;
  feeAmount: bigint;
  tokenIn: string;
  tokenOut: string;
};

export function Convert({ d, pool }: { d: Deployment | undefined; pool: Feed<"pool"> }) {
  const w = useWallet();
  const [reverse, setReverse] = useState(false);
  const [input, setInput] = useState("100");
  const [approvedKey, setApprovedKey] = useState("");
  const [details, setDetails] = useState(false);
  const [session, setSession] = useState<Receipt[]>([]);
  const tx = useTx<Receipt | "approved">();

  const tokens = d?.tokens;
  const [a, b] = tokens ? (reverse ? [tokens[1], tokens[0]] : [tokens[0], tokens[1]]) : [];
  let raw = 0n;
  const validFormat = !!a && /^\d+(\.\d*)?$/.test(input) && (input.split(".")[1]?.length || 0) <= a.decimals;
  try {
    if (validFormat) raw = parseUnits(input, a!.decimals);
  } catch {
    raw = 0n;
  }
  const params =
    a && b && raw > 0n
      ? new URLSearchParams({ tokenIn: a.address, tokenOut: b.address, amount: raw.toString(), kind: "exactIn" })
      : null;
  const quote = useApi("quote", params ? params.toString() : null);
  if (params) {
    params.set("swapper", w.address || a!.address);
    params.set("allowDark", "false");
    if (w.uid) params.set("attestationUid", w.uid);
  }
  const route = useApi("route", w.address && params ? params.toString() : null);
  const fills = useApi("fills", w.address ? "" : null, 15000);
  const q = w.address ? route.data?.quote ?? quote.data : quote.data;
  const activeRoute: Route | undefined =
    w.address && w.eligibility.data && !w.eligible
      ? "BLOCKED-ELIGIBILITY"
      : route.data?.route || (q ? (q.fillable ? "PARITY" : "FALL-THROUGH") : undefined);
  const output = route.data?.route === "FALL-THROUGH" ? route.data.fallThrough?.amountOut : q?.amountOut;
  const minOut = output ? (BigInt(output) * 995n) / 1000n : 0n;
  const router = d?.contracts.wrapSwapRouter ?? undefined;
  const approvalKey = `${w.address}:${a?.address}:${raw}`;
  const balance = a ? w.balances.values[a.address] : undefined;
  const insufficient = w.balances.status === "ok" && balance !== undefined && raw > balance;

  // Live wallet: skip the approval when the router already has enough allowance.
  useEffect(() => {
    if (isDemo() || !w.ready || !a || !router || raw === 0n) return;
    let live = true;
    allowance(a.address, w.address!, router).then(
      (v) => live && v >= raw && setApprovedKey(approvalKey),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [w.ready, w.address, a, router, raw, approvalKey]);

  const quoteStatus = !params ? "ok" : w.address ? (route.data ? "ok" : route.status) : quote.status;
  const blockedReason = !params
    ? input.trim() === ""
      ? "Enter an amount."
      : `Enter a positive amount, up to ${a?.decimals ?? 18} decimals.`
    : activeRoute === "BLOCKED-ELIGIBILITY"
      ? "This wallet has no issuer eligibility attestation. A valid issuer eligibility attestation is required."
      : activeRoute === "BLOCKED-PEG"
        ? route.data?.reason || "Paused: the pool is more than 50 bps from NAV parity."
        : insufficient
          ? `Insufficient ${a!.symbol} balance.`
          : "";
  const blocked =
    !!blockedReason || !q || !output || quoteStatus !== "ok" || activeRoute?.startsWith("BLOCKED") || tx.busy;
  const approved = approvedKey === approvalKey;

  const doApprove = () =>
    tx.run("Approval", async (onHash) => {
      const sent = await approve(d!, w.address!, a!.address, router ?? d!.contracts.swapRouter, raw, { onHash });
      setApprovedKey(approvalKey);
      return { hash: sent.hash, simulated: sent.simulated, result: "approved" as const };
    });
  const doConvert = () =>
    tx.run("Conversion", async (onHash) => {
      const sent = await convertExactIn(d!, w.address!, a!.address, raw, minOut, w.uid, { onHash });
      const outcome = sent.receipt ? swapOutcome(sent.receipt, b!.address, w.address!) : undefined;
      const path: SwapPath = outcome?.path ?? (activeRoute === "FALL-THROUGH" ? "fall-through" : "inventory");
      const out = outcome?.amountOut ?? BigInt(output!);
      setApprovedKey("");
      w.adjust(a!.address, -raw);
      w.adjust(b!.address, out);
      const r: Receipt = {
        hash: sent.hash,
        simulated: sent.simulated,
        amountIn: raw,
        amountOut: out,
        shares: BigInt(q!.shares),
        sharesOut: (out * BigInt(b!.sharesPerTokenX18)) / 10n ** BigInt(b!.decimals),
        feeBps: q!.fee.totalBps,
        path,
        exact: !!outcome?.amountOut,
        feeAmount: BigInt(q!.feeAmount),
        tokenIn: a!.symbol,
        tokenOut: b!.symbol,
      };
      setSession((s) => [r, ...s].slice(0, 5));
      fills.refresh();
      return { hash: sent.hash, simulated: sent.simulated, result: r };
    });

  const primary = (() => {
    if (!d) return { label: "Loading…", disabled: true, onClick: () => undefined };
    if (!w.address)
      return { label: w.busy === "connect" ? "Connecting…" : "Connect to convert", disabled: !!w.busy, onClick: w.connect };
    if (w.wrongChain) return { label: `Switch to ${w.expected.name}`, disabled: !!w.busy, onClick: w.switchChain };
    if (tx.state.step === "signing") return { label: "Confirm in wallet…", disabled: true, busy: true, onClick: () => undefined };
    if (tx.state.step === "pending")
      return { label: approved ? "Converting…" : "Approving…", disabled: true, busy: true, onClick: () => undefined };
    return approved
      ? { label: "Convert through ParityHook", disabled: blocked, onClick: doConvert }
      : { label: "Approve token", disabled: blocked, onClick: doApprove };
  })();

  const rate = a && b ? (BigInt(a.sharesPerTokenX18) * 10n ** 18n) / BigInt(b.sharesPerTokenX18) : undefined;
  const underlying = a?.underlying ?? "AAPL";
  const recent = [
    ...session,
    ...(fills.data?.items ?? [])
      .filter(
        (f) =>
          (f.kind === "PARITY" || f.kind === "FALL-THROUGH") &&
          f.account.toLowerCase() === w.address?.toLowerCase() &&
          !session.some((s) => s.hash === f.txHash),
      )
      .map((f) => {
        const ti = tokens?.find((t) => t.address === f.tokenIn),
          to = tokens?.find((t) => t.address === f.tokenOut);
        return {
          hash: f.txHash as Hash,
          simulated: false,
          amountIn: BigInt(f.amountIn),
          amountOut: BigInt(f.amountOut),
          shares: BigInt(f.shares ?? "0"),
          sharesOut: to ? (BigInt(f.amountOut) * BigInt(to.sharesPerTokenX18)) / 10n ** BigInt(to.decimals) : 0n,
          feeBps: f.feePips === null ? "—" : (f.feePips / 100).toFixed(2),
          path: (f.kind === "FALL-THROUGH" ? "fall-through" : "inventory") as SwapPath,
          exact: true,
          feeAmount: BigInt(f.feeAmount ?? "0"),
          tokenIn: ti?.symbol ?? "",
          tokenOut: to?.symbol ?? "",
        };
      }),
  ].slice(0, 5);

  const field = (side: "from" | "to") => {
    const t = side === "from" ? a : b;
    const bal = t ? w.balances.values[t.address] : undefined;
    return (
      <div className="field">
        <div className="field-top">
          <span className="field-label">{side === "from" ? "You convert" : "You receive"}</span>
          <span className="balance">
            {w.address && t ? (
              <>
                Balance{" "}
                <Val status={w.balances.status} w="4em">
                  {amount(bal ?? 0n, t.decimals, 4)} {t.symbol}
                </Val>
                {side === "from" && w.balances.status === "ok" && bal !== undefined && bal > 0n && (
                  <button type="button" className="max" onClick={() => setInput(formatUnits(bal, t.decimals))}>
                    Max
                  </button>
                )}
              </>
            ) : null}
          </span>
        </div>
        <div className="field-row">
          {side === "from" ? (
            <input
              className="amount"
              aria-label="Conversion amount"
              inputMode="decimal"
              placeholder="0"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (!tx.busy) tx.reset();
              }}
            />
          ) : (
            <output className="amount" aria-label="You receive">
              {params ? (
                <Val status={quoteStatus} w="5em" h="1.1em">
                  {output ? amount(output, b!.decimals, 4) : "0"}
                </Val>
              ) : (
                "0"
              )}
              {b && <span className="unit"> {b.symbol}</span>}
            </output>
          )}
          {tokens ? (
            <select
              className="token"
              aria-label={side === "from" ? "From token" : "To token"}
              value={t!.address}
              onChange={(e) =>
                setReverse(side === "from" ? e.target.value === tokens[1].address : e.target.value === tokens[0].address)
              }
            >
              {tokens.map((x) => (
                <option key={x.address} value={x.address}>
                  {x.symbol} · {issuer(x)}
                </option>
              ))}
            </select>
          ) : (
            <Skeleton w="8em" h="2.2em" />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <section className="card convert" aria-label="Convert">
        <div className="convert-inputs">
          {field("from")}
          <button
            type="button"
            className="flip"
            aria-label="Reverse direction"
            onClick={() => {
              setReverse(!reverse);
              tx.reset();
            }}
          >
            ↓
          </button>
          {field("to")}
          {input.trim() !== "" && !params && tokens && (
            <p role="alert" className="field-error">
              Enter a positive amount, up to {a!.decimals} decimals.
            </p>
          )}
        </div>

        <div className="convert-summary">
          <p className="share-line" aria-live="polite">
            {[a, b].map((t, i) => (
              <span key={i} className="share-side">
                {i === 1 && (
                  <span className="arrow" aria-hidden="true">
                    →
                  </span>
                )}
                <span className="share-n">
                  {q ? shares(q.shares) : params ? <Val status={quoteStatus} w="3.5em" h="0.9em">—</Val> : "0.00"}
                </span>
                <span className="share-u">
                  {" "}
                  {underlying} shares{i === 0 ? " " : ""}
                </span>
                <span className="share-w">{t ? issuer(t) : <Skeleton w="5em" />}</span>
              </span>
            ))}
          </p>
          {q && output && (
            <p className="token-line">
              {amount(q.amountIn, a!.decimals, 6)} {a!.symbol} → {amount(output, b!.decimals, 6)} {b!.symbol}
            </p>
          )}
          <div className="cost">
            <div>
              <span className="cost-k">You keep</span>
              <span className="cost-v">{q ? keptPct(q.fee.totalPips) : "—"}</span>
              <span className="cost-s">of value</span>
            </div>
            <div data-testid="fee-breakdown">
              <span className="cost-k">Fee</span>
              <span className="cost-v">{q ? `${q.fee.totalBps} bps` : "— bps"}</span>
              <span className="cost-s">{q ? `${amount(q.feeAmount, b!.decimals, 4)} ${b!.symbol}` : " "}</span>
            </div>
          </div>
          {q && !q.fee.marketOpen && <p className="market-line">Market closed: +{q.fee.closedPips / 100} bps</p>}
          {blockedReason && params !== null && (
            <p role="alert" className="block-reason">
              {blockedReason}
            </p>
          )}
          {w.notice && (
            <p role="alert" className="block-reason">
              {w.notice}
            </p>
          )}
          <button
            className="primary wide"
            disabled={primary.disabled}
            aria-busy={"busy" in primary ? true : undefined}
            onClick={() => void primary.onClick()}
          >
            {"busy" in primary && <Spinner />}
            {primary.label}
          </button>
          <TxPanel
            tx={tx.state}
            onRetry={tx.retry}
            receipt={(r) =>
              r === "approved" ? (
                <p>
                  <span className="ok-dot" aria-hidden="true" /> Approval confirmed
                  {isDemo() ? " (simulated)" : ""}. Now convert.
                </p>
              ) : (
                <div className="receipt">
                  <p className="receipt-title">
                    <span className="ok-dot" aria-hidden="true" /> Conversion confirmed
                    {r.simulated ? " (simulated)" : ""}
                  </p>
                  <dl>
                    <dt>Shares</dt>
                    <dd>
                      {shares(r.shares)} → {shares(r.shares)} {underlying}
                    </dd>
                    <dt>Tokens</dt>
                    <dd>
                      {amount(r.amountIn, a!.decimals, 6)} {r.tokenIn} → {amount(r.amountOut, b!.decimals, 6)} {r.tokenOut}
                      {!r.exact && <span className="muted"> (quoted)</span>}
                    </dd>
                    <dt>Fee</dt>
                    <dd>
                      {r.feeBps} bps · {amount(r.feeAmount, b!.decimals, 4)} {r.tokenOut}
                    </dd>
                    {r.hash && (
                      <>
                        <dt>Transaction</dt>
                        <dd>
                          <Hex value={r.hash} kind="tx" simulated={r.simulated} />
                        </dd>
                      </>
                    )}
                  </dl>
                  <button type="button" className="ghost-btn" onClick={tx.reset}>
                    Convert again
                  </button>
                </div>
              )
            }
          />
          <button
            type="button"
            className="disclosure"
            aria-expanded={details}
            aria-controls="convert-details"
            onClick={() => setDetails(!details)}
          >
            Details
          </button>
        </div>
      </section>

      {details && (
        <section className="card details-panel" id="convert-details" aria-label="Conversion details">
          <dl className="quote">
            <dt>NAV reference</dt>
            <dd>{rate !== undefined ? `${amount(rate, 18, 6)} ${b!.symbol}/${a!.symbol}` : <Skeleton w="8em" />}</dd>
            <dt>Route</dt>
            <dd>{activeRoute ? <RouteBadge route={activeRoute} /> : "—"}</dd>
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
            <dd>{output ? `${amount(minOut, b!.decimals, 6)} ${b!.symbol} (0.5% slippage)` : "—"}</dd>
          </dl>
          {q && <Fees fee={q.fee} open />}
          <h3 className="details-h">How this swap runs</h3>
          <SwapAnatomy
            path={
              session[0]?.path ?? (activeRoute === "BLOCKED-PEG" ? "peg" : undefined)
            }
          />
        </section>
      )}

      {w.address && recent.length > 0 && (
        <section className="card recent" aria-label="Your recent conversions">
          <h2 className="card-title">Your recent conversions</h2>
          <ul>
            {recent.map((r, i) => (
              <li key={(r.hash ?? "") + i}>
                <span>
                  {shares(r.shares)} {underlying} shares · {r.tokenIn} → {r.tokenOut}
                </span>
                <span className="muted">{r.feeBps} bps</span>
                {r.hash ? <Hex value={r.hash} kind="tx" simulated={r.simulated} /> : <span />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
