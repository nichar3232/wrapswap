import { useState } from "react";
import type { Deployment } from "@wrapswap/types";
import { Tip } from "../components";
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
  const skew = inventory.data ? Number(inventory.data.skewX18) / 1e18 : undefined;
  const total = inventory.data ? BigInt(inventory.data.totalShares) : 0n;
  return (
    <div className="stack wide-stack">
      <section className="card stats" aria-label="Pool state">
        <div>
          <span className="stat-k">
            Fee now <Tip text="The hook's dynamic LP fee for the next swap." />
          </span>
          <span className="stat-v">
            <Val status={fees.status} w="4em">
              {fees.data?.fee.totalBps} <small>bps</small>
            </Val>
          </span>
        </div>
        <div>
          <span className="stat-k">Inventory skew</span>
          <span className="stat-v">
            <Val status={inventory.status} w="4em">
              {skew !== undefined && pct(skew)}
            </Val>
          </span>
        </div>
        <div>
          <span className="stat-k">Market hours</span>
          <span className="stat-v">
            <Val status={nyse.status} w="6em">
              {nyse.data && (
                <>
                  <span className={nyse.data.open ? "good" : "warn"}>{nyse.data.open ? "NYSE open" : "NYSE closed"}</span>
                  <small> · {nyse.data.nextState.toLowerCase() === "open" ? "opens" : "closes"} in {hours(nyse.data.secondsUntilTransition)}</small>
                </>
              )}
            </Val>
          </span>
        </div>
      </section>

      <section className="card" aria-label="Inventory">
        <div className="card-head">
          <span className="label">Hook inventory</span>
          <Tip text="Canonical shares account for issuer ratios; they are not a user-held security." />
        </div>
        {inventory.data && d ? (
          <>
            <p className="metric">
              <span className="unit">Total</span> {amount(inventory.data.totalShares, 18, 2)}{" "}
              <span className="unit">canonical shares</span>
            </p>
            {inventory.data.tokens.map((t) => {
              const dec = d.tokens.find((x) => x.address === t.address)?.decimals ?? 18;
              const share = total ? Number((BigInt(t.inventoryShares) * 1000n) / total) / 10 : 0;
              return (
                <div className="inv-row" key={t.address}>
                  <div className="inv-top">
                    <span className="inv-sym">{t.symbol}</span>
                    <span>
                      {amount(t.inventory, dec, 2)} tokens · {amount(t.inventoryShares, 18, 2)} shares
                    </span>
                  </div>
                  <div className="bar" aria-hidden="true">
                    <span style={{ width: `${share}%` }} />
                  </div>
                </div>
              );
            })}
            <label className="skew">
              <span>
                Skew <strong>{pct(skew!)}</strong>
              </span>
              <meter min={-1} max={1} value={skew} aria-label="Inventory skew" />
            </label>
          </>
        ) : (
          <Val status={inventory.status} w="100%" h="5em">
            {null}
          </Val>
        )}
      </section>

      <section className="card" aria-label="Fee curve">
        <div className="card-head">
          <span className="label">Fee curve</span>
          <Tip text="Drawn with the same formula ParityHook uses: min(2 + 13 × |skew| + (open ? 0 : 10), 25) bps. The live pool's position is marked." />
        </div>
        <FeeCurve
          key={inventory.data && fees.data ? "live" : "static"}
          liveSkew={skew}
          liveOpen={fees.data?.fee.marketOpen}
        />
      </section>

      <section className="card" aria-label="Recent fills">
        <div className="card-head">
          <span className="label">Recent fills</span>
        </div>
        {fills.data ? (
          fills.data.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Settlement</th>
                    <th>Token in</th>
                    <th>Token out</th>
                    <th>Hook fee</th>
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
                          {f.kind === "PARITY" ? "Inventory" : f.kind === "FALL-THROUGH" ? "Fall-through" : f.kind === "DARK-RESIDUAL" ? "Dark residual" : "Dark cross"} · ParityHook
                        </td>
                        <td>
                          {amount(f.amountIn, a?.decimals, 6)} {a?.symbol}
                        </td>
                        <td>
                          {amount(f.amountOut, b?.decimals, 6)} {b?.symbol}
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
              No fills yet. Conversions and Dark Cross residuals will appear here.
            </Empty>
          )
        ) : (
          <Val status={fills.status} w="100%" h="4em">
            {null}
          </Val>
        )}
      </section>
    </div>
  );
}
