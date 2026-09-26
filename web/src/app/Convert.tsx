import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import type { Deployment, Route } from "@wrapswap/types";
import { Fees, RouteBadge, Tip } from "../components";
import { config } from "../config";
import { useApi, type Feed } from "../hooks/useApi";
import { amount } from "../lib/format";
import { allowance, approve, convertExactIn, swapOutcome } from "../wallet";
import { SwapAnatomy, type SwapPath } from "./SwapAnatomy";
import { useTx } from "./tx";
import { Hex, Skeleton, Spinner, TxPanel, Val } from "./ui";
import { useWallet } from "./wallet";

const ROUTE_TIPS: Record<Route, string> = {
  PARITY: "Filled from ParityHook inventory at exact share parity.",
  "FALL-THROUGH": "Inventory short; the remainder routes through the v4 pool curve.",
  DARK: "Size is better crossed in the next Dark Cross batch.",
  "BLOCKED-PEG": "Paused: the pool is more than 50 bps from NAV parity.",
  "BLOCKED-ELIGIBILITY": "This wallet has no valid issuer eligibility attestation.",
};
const issuer = (t: { issuer: string }) => (t.issuer === "coinbase" ? "Coinbase" : "xStocks");

type Receipt = {
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
  feeBps: string;
  path?: SwapPath;
  exact: boolean;
};

export function Convert({
  d,
  pool,
  onDark,
}: {
  d: Deployment | undefined;
  pool: Feed<"pool">;
  onDark: () => void;
}) {
  const w = useWallet();
  const [reverse, setReverse] = useState(false);
  const [input, setInput] = useState("100");
  const [approvedKey, setApprovedKey] = useState("");
  const [lastPath, setLastPath] = useState<SwapPath>();
  const [anatomy, setAnatomy] = useState(false);
  const [details, setDetails] = useState(false);
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
  const q = w.address ? route.data?.quote ?? quote.data : quote.data;
  const eligibilityKnown = !!w.eligibility.data;
  const activeRoute: Route | undefined =
    w.address && eligibilityKnown && !w.eligible
      ? "BLOCKED-ELIGIBILITY"
      : route.data?.route || (q ? (q.fillable ? "PARITY" : "FALL-THROUGH") : undefined);
  const output =
    route.data?.route === "FALL-THROUGH" ? route.data.fallThrough?.amountOut : q?.amountOut;
  const minOut = output ? (BigInt(output) * 995n) / 1000n : 0n;
  const router = d?.contracts.wrapSwapRouter ?? undefined;
  const approvalKey = `${w.address}:${a?.address}:${raw}`;
  const balance = a ? w.balances.values[a.address] : undefined;
  const insufficient = w.balances.status === "ok" && balance !== undefined && raw > balance;

  // Live: skip the approval when the router already has enough allowance.
  useEffect(() => {
    if (config.useMocks || !w.ready || !a || !router || raw === 0n) return;
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
  const blockedReason =
    !params
      ? input.trim() === ""
        ? "Enter an amount to convert."
        : `Enter a positive amount, up to ${a?.decimals ?? 18} decimals.`
      : activeRoute === "BLOCKED-ELIGIBILITY"
        ? `${w.eligibility.data?.reason.replaceAll("_", " ").toLowerCase()}. A valid issuer eligibility attestation is required.`
        : activeRoute === "BLOCKED-PEG"
          ? route.data?.reason || "Peg guard: the pool is more than 50 bps from NAV parity."
          : insufficient
            ? `Insufficient ${a!.symbol} balance.`
            : !router && !config.useMocks
              ? "Conversions are unavailable on this deployment."
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
      const path: SwapPath =
        outcome?.path ?? (activeRoute === "FALL-THROUGH" ? "fall-through" : "inventory");
      const out = outcome?.amountOut ?? BigInt(output!);
      setApprovedKey("");
      setLastPath(path);
      w.adjust(a!.address, -raw);
      w.adjust(b!.address, out);
      return {
        hash: sent.hash,
        simulated: sent.simulated,
        result: {
          amountIn: raw,
          amountOut: out,
          feeAmount: BigInt(q!.feeAmount),
          feeBps: q!.fee.totalBps,
          path,
          exact: !!outcome?.amountOut,
        },
      };
    });

  const primary = (() => {
    if (!d) return { label: "Connecting…", disabled: true, onClick: () => undefined };
    if (!w.address)
      return { label: w.busy === "connect" ? "Connecting…" : "Connect to convert", disabled: !!w.busy, onClick: w.connect };
    if (w.wrongChain)
      return { label: `Switch to ${w.expected.name}`, disabled: !!w.busy, onClick: w.switchChain };
    if (activeRoute === "DARK") return { label: "Continue to Dark Cross", disabled: false, onClick: onDark };
    if (tx.state.step === "signing") return { label: "Confirm in wallet…", disabled: true, busy: true, onClick: () => undefined };
    if (tx.state.step === "pending")
      return { label: approved ? "Converting…" : "Approving…", disabled: true, busy: true, onClick: () => undefined };
    return approved
      ? { label: "Convert through ParityHook", disabled: blocked, onClick: doConvert }
      : { label: "Approve token", disabled: blocked, onClick: doApprove };
  })();

  const rate =
    a && b ? (BigInt(a.sharesPerTokenX18) * 10n ** 18n) / BigInt(b.sharesPerTokenX18) : undefined;
  const pegStatus = pool.status;
  const offHours = q ? !q.fee.marketOpen : false;

  return (
    <>
      <section className="card swap" aria-label="Convert">
        <div className="field">
          <div className="field-top">
            <span className="field-label">From{a ? ` · ${issuer(a)}` : ""}</span>
            {w.address && a && (
              <span className="balance">
                Balance{" "}
                <Val status={w.balances.status} w="4em">
                  {amount(balance ?? 0n, a.decimals, 4)}
                </Val>
                {w.balances.status === "ok" && balance !== undefined && balance > 0n && (
                  <button
                    type="button"
                    className="max"
                    onClick={() => setInput(formatUnits(balance, a.decimals))}
                  >
                    Max
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="field-row">
            <input
              className="amount"
              aria-label="Conversion amount"
              inputMode="decimal"
              placeholder="0"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (tx.state.step !== "signing" && tx.state.step !== "pending") tx.reset();
              }}
            />
            {tokens ? (
              <select
                className="token"
                aria-label="From token"
                value={a!.address}
                onChange={(e) => setReverse(e.target.value === tokens[1].address)}
              >
                {tokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            ) : (
              <Skeleton w="7em" h="2.1em" />
            )}
          </div>
          {input.trim() !== "" && !params && tokens && (
            <p role="alert" className="field-error">
              Enter a positive amount, up to {a!.decimals} decimals.
            </p>
          )}
        </div>
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
        <div className="field">
          <div className="field-top">
            <span className="field-label">To{b ? ` · ${issuer(b)}` : ""}</span>
            {w.address && b && w.balances.status === "ok" && (
              <span className="balance">Balance {amount(w.balances.values[b.address] ?? 0n, b.decimals, 4)}</span>
            )}
          </div>
          <div className="field-row">
            <output className="amount" aria-label="You receive">
              {params ? (
                <Val status={quoteStatus} w="5em" h="1.1em">
                  {output ? amount(output, b!.decimals, 6) : "0"}
                </Val>
              ) : (
                "0"
              )}
              {b && <span className="unit"> {b.symbol}</span>}
            </output>
            {tokens ? (
              <select
                className="token"
                aria-label="To token"
                value={b!.address}
                onChange={(e) => setReverse(e.target.value === tokens[0].address)}
              >
                {tokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            ) : (
              <Skeleton w="7em" h="2.1em" />
            )}
          </div>
        </div>

        <dl className="quote">
          <dt>
            Route <Tip text="How this conversion will fill." />
          </dt>
          <dd>
            {activeRoute ? (
              <span className="route">
                <RouteBadge route={activeRoute} />
                <Tip text={ROUTE_TIPS[activeRoute]} />
              </span>
            ) : params ? (
              <Val status={quoteStatus} w="4.5em">
                —
              </Val>
            ) : (
              "—"
            )}
          </dd>
          <dt>
            NAV reference <Tip text="Share-for-share: the rate is the issuers' shares-per-token ratio, not a pool price." />
          </dt>
          <dd>
            {rate !== undefined ? (
              <span>{`${amount(rate, 18, 6)} ${b!.symbol}/${a!.symbol}`}</span>
            ) : (
              <Skeleton w="8em" />
            )}
          </dd>
          <dt>
            Peg guard <Tip text="Conversions pause if the pool drifts more than 50 bps from NAV parity." />
          </dt>
          <dd>
            <Val status={pegStatus} w="5em">
              {pool.data &&
                (pool.data.pegTripped ? (
                  <span className="bad">Tripped · {pool.data.deviationBps} bps</span>
                ) : (
                  <span className="good">Clear · {pool.data.deviationBps} bps from NAV</span>
                ))}
            </Val>
          </dd>
          {output && q && (
            <>
              <dt>
                Minimum received <Tip text="0.5% slippage tolerance. The approval covers this amount only." />
              </dt>
              <dd>
                {amount(minOut, b!.decimals, 6)} {b!.symbol}
              </dd>
            </>
          )}
        </dl>
        <div className={`fee-row${offHours ? " off-hours" : ""}`}>
          {q ? (
            <Fees fee={q.fee} open={details} onToggle={() => setDetails(!details)} />
          ) : params ? (
            <Val status={quoteStatus} w="7em">
              —
            </Val>
          ) : (
            <span className="muted">Fee shown with a quote</span>
          )}
        </div>

        {w.address && (
          <p className={`eligibility ${w.eligible ? "good" : ""}`}>
            {w.eligibility.data ? (
              w.eligible ? (
                <>Eligibility verified{w.eligibility.data.demoMode ? " · demo mode" : ""}</>
              ) : null
            ) : (
              <Val status={w.eligibility.status} w="9em">
                {null}
              </Val>
            )}
          </p>
        )}
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
                {config.useMocks ? " (simulated)" : ""}. Now convert.
              </p>
            ) : (
              <div className="receipt">
                <p className="receipt-title">
                  <span className="ok-dot" aria-hidden="true" /> Conversion confirmed
                  {config.useMocks ? " (simulated)" : ""}
                </p>
                <dl>
                  <dt>In</dt>
                  <dd>
                    {amount(r.amountIn, a!.decimals, 6)} {a!.symbol}
                  </dd>
                  <dt>Out</dt>
                  <dd>
                    {amount(r.amountOut, b!.decimals, 6)} {b!.symbol}
                    {!r.exact && <span className="muted"> (quoted)</span>}
                  </dd>
                  <dt>Fee</dt>
                  <dd>
                    {r.feeBps} bps · {amount(r.feeAmount, b!.decimals, 6)} {b!.symbol}
                  </dd>
                  <dt>Path</dt>
                  <dd>{r.path === "fall-through" ? "Fell through to the AMM" : "Filled from hook inventory"}</dd>
                  {tx.state.step === "confirmed" && tx.state.hash && (
                    <>
                      <dt>Transaction</dt>
                      <dd>
                        <Hex value={tx.state.hash} kind="tx" simulated={config.useMocks} />
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
      </section>
      <section className={`anatomy-card${anatomy ? " open" : ""}`}>
        <button
          type="button"
          className="details-toggle"
          aria-expanded={anatomy}
          onClick={() => setAnatomy(!anatomy)}
        >
          Anatomy of this swap
          {lastPath && <span className="muted"> · last swap highlighted</span>}
        </button>
        {anatomy && (
          <SwapAnatomy
            path={
              lastPath ??
              (activeRoute === "BLOCKED-PEG" ? "peg" : undefined)
            }
          />
        )}
      </section>
    </>
  );
}

