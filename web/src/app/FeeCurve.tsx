import { useState } from "react";
import { inventoryAtSkew, pipsToBps, tradeFee } from "./fees";

export const pct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`;
export const hours = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

/** Fee response to inventory skew and market hours, drawn with the contract's formula. */
export function FeeCurve({ liveSkew, liveOpen }: { liveSkew?: number; liveOpen?: boolean }) {
  const [skew, setSkew] = useState(() => Math.round((liveSkew ?? 0) * 100));
  const [open, setOpen] = useState(liveOpen ?? false);
  const [dir, setDir] = useState<"adds" | "rebalances">("adds");
  // A reference trade of 1% of inventory, in the chosen direction relative to the skew at each point.
  const feeAt = (s: number, mOpen: boolean) => {
    const inv = inventoryAtSkew(s);
    const sharesIn = (inv.shares0 + inv.shares1) / 100n;
    const inIsToken0 = dir === "adds" ? s >= 0 : s < 0;
    return tradeFee(inv, { sharesIn, inIsToken0 }, mOpen);
  };
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
      return `${i ? "L" : "M"}${x(s).toFixed(1)} ${y(pipsToBps(feeAt(s, mOpen).totalPips)).toFixed(1)}`;
    }).join(" ");
  const sel = feeAt(skew / 100, open);
  const live = liveSkew !== undefined && liveOpen !== undefined ? feeAt(liveSkew, liveOpen) : undefined;
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
        <div className="segmented" role="group" aria-label="Trade direction">
          <button type="button" aria-pressed={dir === "adds"} onClick={() => setDir("adds")}>
            Adds imbalance
          </button>
          <button type="button" aria-pressed={dir === "rebalances"} onClick={() => setDir("rebalances")}>
            Rebalances
          </button>
        </div>
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

