import { useState, type ReactNode } from "react";
import { explorerUrl } from "@wrapswap/types";
import type { FeedStatus } from "../hooks/useApi";
import { config } from "../config";
import { isDemo } from "../wallet";
import { exact, fmtShares, fmtTokens } from "../lib/format";
import type { TxState } from "./tx";

export const shortHex = (h: string, head = 6, tail = 4) =>
  h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h;

export function Skeleton({ w = "6em", h = "1em" }: { w?: string; h?: string }) {
  return <span className="skeleton" style={{ width: w, height: h }} aria-hidden="true" />;
}

/** A value from a feed: skeleton while loading, "—" + muted hint when unavailable. */
export function Val({
  status,
  children,
  w,
  h,
}: {
  status: FeedStatus;
  children: ReactNode;
  w?: string;
  h?: string;
}) {
  if (status === "loading")
    return (
      <span className="val-loading" role="status" aria-label="Loading">
        <Skeleton w={w} h={h} />
      </span>
    );
  if (status === "unavailable")
    return (
      <span className="val-na">
        — <small>unavailable</small>
      </span>
    );
  return <>{children}</>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** Clipboard API first, then the legacy execCommand path (for contexts where the API is blocked). */
async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const t = document.createElement("textarea");
    t.value = value;
    t.setAttribute("readonly", "");
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    t.remove();
    return ok;
  }
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const text = state === "done" ? "Copied" : state === "failed" ? "Copy blocked; select the text instead" : label;
  return (
    <button
      type="button"
      className={`icon-btn${state === "failed" ? " failed" : ""}`}
      aria-label={text}
      title={text}
      onClick={() => {
        void copyText(value).then((ok) => {
          setState(ok ? "done" : "failed");
          setTimeout(() => setState("idle"), 1600);
        });
      }}
    >
      {state === "done" ? (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5" y="5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )}
    </button>
  );
}

/** Address or hash: mono, shortened, copy, explorer link when the network has one and the value is real. */
export function Hex({
  value,
  kind = "address",
  simulated = false,
}: {
  value: string;
  kind?: "address" | "tx";
  simulated?: boolean;
}) {
  const url = simulated ? null : explorerUrl(config.network, kind, value);
  return (
    <span className="hex">
      <span className="mono" title={value}>
        {shortHex(value)}
      </span>
      <CopyButton value={value} label={kind === "tx" ? "Copy transaction hash" : "Copy address"} />
      {url && (
        <a className="ext" href={url} target="_blank" rel="noreferrer" aria-label="View on explorer">
          ↗
        </a>
      )}
    </span>
  );
}

/** The shared transaction-state pattern: signing, pending + explorer link, confirmed receipt, failed + retry. */
export function TxPanel<R>({
  tx,
  onRetry,
  receipt,
}: {
  tx: TxState<R>;
  onRetry: () => void;
  receipt?: (result: R) => ReactNode;
}) {
  if (tx.step === "idle") return null;
  const simulated = isDemo();
  return (
    <div className={`tx tx-${tx.step}`} role="status" aria-live="polite">
      {tx.step === "signing" && (
        <p>
          <Spinner /> Confirm “{tx.label}” in your wallet…
        </p>
      )}
      {tx.step === "pending" && (
        <p>
          <Spinner /> {tx.label} pending · <Hex value={tx.hash} kind="tx" simulated={simulated} />
        </p>
      )}
      {tx.step === "confirmed" &&
        (receipt ? (
          receipt(tx.result)
        ) : (
          <p>
            <span className="ok-dot" aria-hidden="true" /> {tx.label} confirmed
            {simulated ? " (simulated)" : ""}
            {tx.hash && (
              <>
                {" · "}
                <Hex value={tx.hash} kind="tx" simulated={simulated} />
              </>
            )}
          </p>
        ))}
      {tx.step === "failed" && (
        <div className="tx-failed">
          <p>
            <strong>{tx.label} failed.</strong> {tx.reason}
          </p>
          <button type="button" className="ghost-btn" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{children}</p>
      {action}
    </div>
  );
}

/*
 * Numbers for display. Shares: two places, tokens: four, both half-up; the raw value stays in state and in the tx data,
 * and the exact figure (every digit, plus the raw integer) is in each number's hover tooltip.
 */
export const Sh = ({ v, digits = 2 }: { v: bigint | string; digits?: number }) => (
  <span className="num" title={exact(v, 18, "shares")}>
    {fmtShares(v, digits)}
  </span>
);
export const Tok = ({ v, decimals, symbol }: { v: bigint | string; decimals: number; symbol: string }) => (
  <span className="num" title={exact(v, decimals, symbol)}>
    {fmtTokens(v, decimals)}
  </span>
);
export const Bps = ({ pips }: { pips: number | bigint }) => (
  <span className="num" title={`${pips.toString()} pips (raw; 100 pips = 1 bp)`}>
    {(Number(pips) / 100).toFixed(2)} bps
  </span>
);
/** A fee as both rate and amount: "2.00 bps · 0.02 sh". */
export const FeeBpsShares = ({ pips, shares }: { pips: number | bigint; shares: bigint | string }) => (
  <>
    <Bps pips={pips} /> · <Sh v={shares} /> sh
  </>
);
