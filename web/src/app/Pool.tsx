import { useState } from "react";
import type { Deployment } from "@wrapswap/types";
import { config } from "../config";
import type { Feed } from "../hooks/useApi";
import { useApi } from "../hooks/useApi";
import { amount } from "../lib/format";
import { feeAtSkew, pipsToBps } from "./fees";
import { Empty, Hex, Val } from "./ui";

const pct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`;
const hours = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

/** Fee response to inventory skew and market hours, drawn with the contract's formula. */
function FeeCurve({ liveSkew, liveOpen }: { liveSkew?: number; liveOpen?: boolean }) {
  const [skew, setSkew] = useState(() => Math.round((liveSkew ?? 0) * 100));
  const [open, setOpen] = useState(liveOpen ?? false);
  const W = 560,
    H = 220,
    L = 44,
    B = 28,
    top = 12;
  const R = 30;
  const x = (s: number) => L + ((s + 1) / 2) * (W - L - R);
  const y = (bps: number) => top + (1 - bps / 25) * (H - top - B);
  const line = (mOpen: boolean) =>
    Array.from({ length: 201 }, (_, i) => {
      const s = -1 + i / 100;
      return `${i ? "L" : "M"}${x(s).toFixed(1)} ${y(pipsToBps(feeAtSkew(s, mOpen).totalPips)).toFixed(1)}`;
    }).join(" ");
  const sel = feeAtSkew(skew / 100, open);
  const live = liveSkew !== undefined && liveOpen !== undefined ? feeAtSkew(liveSkew, liveOpen) : undefined;
  return (
    <div className="curve">
      <div className="curve-controls">
        <label className="slider">
          <span>
            Inventory skew <strong>{pct(skew / 100)}</strong>
          </span>
          <input
            type="range"
            min={-100}
            max={100}
            step={1}
            value={skew}
            aria-label="Inventory skew (percent)"
            onChange={(e) => setSkew(Number(e.target.value))}
          />
        </label>
        <div className="segmented" role="group" aria-label="Market hours">
          <button type="button" aria-pressed={open} onClick={() => setOpen(true)}>
            Market open
          </button>
          <button type="button" aria-pressed={!open} onClick={() => setOpen(false)}>
            Off-hours
          </button>
        </div>
      </div>
      <svg
        className="curve-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Fee curve. At ${pct(skew / 100)} skew ${open ? "with the market open" : "off-hours"} the fee is ${pipsToBps(sel.totalPips).toFixed(2)} bps.`}
      >
        {[0, 5, 10, 15, 20, 25].map((b) => (
          <g key={b}>
            <line className="grid" x1={L} x2={W - R} y1={y(b)} y2={y(b)} />
            <text className="axis" x={L - 8} y={y(b) + 4} textAnchor="end">
              {b}
            </text>
          </g>
        ))}
        {[-1, -0.5, 0, 0.5, 1].map((s) => (
          <text key={s} className="axis" x={x(s)} y={H - 8} textAnchor="middle">
            {s === 0 ? "0%" : `${s > 0 ? "+" : "−"}${Math.abs(s * 100)}%`}
          </text>
        ))}
        <path className={`curve-line${open ? " dim" : ""}`} d={line(false)} />
        <path className={`curve-line open${open ? "" : " dim"}`} d={line(true)} />
        {live && (
          <g className="live-marker" transform={`translate(${x(liveSkew!)} ${y(pipsToBps(live.totalPips))})`}>
            <circle r={6} />
          </g>
        )}
        <g className="sel-marker" transform={`translate(${x(skew / 100)} ${y(pipsToBps(sel.totalPips))})`}>
          <line y1={0} y2={H - B - y(pipsToBps(sel.totalPips))} />
          <circle r={4.5} />
        </g>
      </svg>
      <p className="curve-legend" aria-hidden="true">
        <span className="lg lg-open" /> Market open <span className="lg lg-off" /> Off-hours
        {live && (
          <>
            <span className="lg lg-live" /> Live pool
          </>
        )}
        <span className="lg-unit">fee in bps · x: inventory skew</span>
      </p>
      <p className="curve-readout" aria-live="polite">
        <strong>{pipsToBps(sel.totalPips).toFixed(2)} bps</strong> = {pipsToBps(sel.basePips)} base +{" "}
        {pipsToBps(sel.skewPips).toFixed(2)} skew{sel.closedPips ? ` + ${pipsToBps(sel.closedPips)} off-hours` : ""}
        {sel.totalPips === 2500n ? " (capped at 25)" : ""}
      </p>
    </div>
  );
}

export function Pool({
  d,
  fees,
  nyse,
}: {
  d: Deployment | undefined;
  fees: Feed<"fees">;
  nyse: Feed<"nyse">;
}) {
  const inventory = useApi("inventory"),
    fills = useApi("fills");
  const [curve, setCurve] = useState(false);
  const skew = inventory.data ? Number(inventory.data.skewX18) / 1e18 : undefined;
  const total = inventory.data ? BigInt(inventory.data.totalShares) : 0n;
  const split = inventory.data?.tokens.map((t) => ({
    ...t,
    dec: d?.tokens.find((x) => x.address === t.address)?.decimals ?? 18,
    pct: total ? Number((BigInt(t.inventoryShares) * 1000n) / total) / 10 : 0,
  }));
  return (
    <div className="page">
      <div className="tiles">
        <section className="card tile" aria-label="Current fee">
          <span className="tile-k">Current fee</span>
          <span className="tile-v">
            <Val status={fees.status} w="4em" h="1em">
              {fees.data?.fee.totalBps} <small>bps</small>
            </Val>
          </span>
          <span className="tile-s">
            {fees.data && !fees.data.fee.marketOpen ? `incl. +${fees.data.fee.closedPips / 100} bps while the market is closed` : "per conversion"}
          </span>
        </section>
        <section className="card tile" aria-label="Inventory balance">
          <span className="tile-k">Inventory balance</span>
          {split && split.length === 2 ? (
            <>
              <div className="split" role="img" aria-label={`${split[0].symbol} ${split[0].pct}%, ${split[1].symbol} ${split[1].pct}% of canonical shares`}>
                <span style={{ width: `${split[0].pct}%` }} />
                <span style={{ width: `${split[1].pct}%` }} />
              </div>
              <div className="split-legend">
                {split.map((t) => (
                  <span key={t.address}>
                    <strong>{t.symbol}</strong> {t.pct.toFixed(1)}% · {amount(t.inventory, t.dec, 0)}
                  </span>
                ))}
              </div>
              <span className="tile-s">
                Skew {skew !== undefined && pct(skew)} · total {amount(inventory.data!.totalShares, 18, 0)} shares
              </span>
              <meter className="sr-only" min={-1} max={1} value={skew} aria-label="Inventory skew" />
            </>
          ) : (
            <span className="tile-v">
              <Val status={inventory.status} w="100%" h="1em">
                {null}
              </Val>
            </span>
          )}
        </section>
        <section className="card tile" aria-label="Market">
          <span className="tile-k">Market</span>
          <span className="tile-v">
            <Val status={nyse.status} w="5em" h="1em">
              {nyse.data && <span className={nyse.data.open ? "good" : "warn"}>{nyse.data.open ? "Open" : "Closed"}</span>}
            </Val>
          </span>
          <span className="tile-s">
            {nyse.data ? `NYSE ${nyse.data.nextState.toLowerCase() === "open" ? "opens" : "closes"} in ${hours(nyse.data.secondsUntilTransition)}` : " "}
          </span>
        </section>
      </div>

      <section className="card" aria-label="Recent fills">
        <h2 className="card-title">Recent fills</h2>
        {fills.data ? (
          fills.data.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Fee</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.data.items.map((f) => {
                    const a = d?.tokens.find((t) => t.address === f.tokenIn),
                      b = d?.tokens.find((t) => t.address === f.tokenOut);
                    return (
                      <tr key={f.txHash + f.logIndex}>
                        <td>
                          {f.kind === "PARITY" ? "Conversion" : f.kind === "FALL-THROUGH" ? "Conversion (AMM)" : f.kind === "DARK-RESIDUAL" ? "Dark Cross residual" : "Dark Cross"}
                        </td>
                        <td>
                          {amount(f.amountIn, a?.decimals, 4)} {a?.symbol}
                        </td>
                        <td>
                          {amount(f.amountOut, b?.decimals, 4)} {b?.symbol}
                        </td>
                        <td>{f.feePips === null ? "—" : (f.feePips / 100).toFixed(2) + " bps"}</td>
                        <td>
                          <Hex value={f.txHash} kind="tx" simulated={config.useMocks} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty action={<a className="ghost-btn" href="/app?tab=convert">Make the first conversion</a>}>
              No fills yet.
            </Empty>
          )
        ) : (
          <Val status={fills.status} w="100%" h="4em">
            {null}
          </Val>
        )}
      </section>

      <section className="card quiet">
        <button type="button" className="disclosure" aria-expanded={curve} onClick={() => setCurve(!curve)}>
          How fees work
        </button>
        {curve && (
          <>
            <p className="hint">Fee = 2 bps + up to 13 bps as inventory skews + 10 bps while NYSE is closed, capped at 25 bps.</p>
            <FeeCurve key={inventory.data && fees.data ? "live" : "static"} liveSkew={skew} liveOpen={fees.data?.fee.marketOpen} />
          </>
        )}
      </section>
    </div>
  );
}
