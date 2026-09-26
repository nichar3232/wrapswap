import { useState, type CSSProperties } from "react";

/** Deterministic PRNG so the illustration (and its screenshots) never change between loads. */
function walk(seed: number, n: number, step: number, pull: number) {
  let s = seed,
    v = 0;
  const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  return Array.from({ length: n }, () => (v = v * (1 - pull) + (rand() - 0.5) * step));
}
const N = 79; // 5-minute bars, 09:30 → 16:00
const nav = walk(7, N, 0.18, 0.02).map((d, i) => 100 + d + i * 0.012);
const spreadC = walk(11, N, 0.55, 0.04);
const spreadX = walk(29, N, 0.55, 0.04);
const series = {
  nav,
  c: nav.map((p, i) => p * (1 + (0.35 + spreadC[i]) / 100)),
  x: nav.map((p, i) => p * (1 - (0.3 + spreadX[i]) / 100)),
};
const all = [...series.nav, ...series.c, ...series.x];
const lo = Math.min(...all) - 0.3,
  hi = Math.max(...all) + 0.3;
const W = 900,
  H = 300,
  L = 48,
  R = 16,
  T = 16,
  B = 32;
const px = (i: number) => L + (i / (N - 1)) * (W - L - R);
const py = (p: number) => T + (1 - (p - lo) / (hi - lo)) * (H - T - B);
const path = (ys: number[]) => ys.map((p, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(p).toFixed(1)}`).join(" ");
const maxSpread = Math.max(...series.c.map((c, i) => ((c - series.x[i]) / series.nav[i]) * 100));

/** The "one price" problem: two issuer pools and NAV drift apart over a day; under Unison they convert at NAV. */
export function OnePrice() {
  const [unison, setUnison] = useState(false);
  const c = path(unison ? series.nav : series.c),
    x = path(unison ? series.nav : series.x);
  return (
    <section className="black one-price" id="one-price" aria-labelledby="one-price-h">
      <div className="op-head">
        <div>
          <h2 id="one-price-h">One stock. Three prices.</h2>
          <p className="op-sub">
            Two issuers' AAPL tokens trade in separate pools, so their prices drift from each other and from NAV.
            Unison converts between them at NAV parity, so there is one price.
          </p>
        </div>
        <div className="op-controls">
          <div className="op-toggle" role="group" aria-label="Pricing">
            <button type="button" aria-pressed={!unison} onClick={() => setUnison(false)}>
              Separate pools
            </button>
            <button type="button" aria-pressed={unison} onClick={() => setUnison(true)}>
              With Unison
            </button>
          </div>
        </div>
      </div>
      <div className="op-chart">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={
            unison
              ? "Illustrative: under Unison both issuer tokens convert at NAV, one line."
              : `Illustrative: over a trading day the AAPLc and AAPLx pool prices drift up to ${maxSpread.toFixed(1)}% apart around NAV.`
          }
        >
          {[0, 0.5, 1].map((f) => (
            <line key={f} className="op-grid" x1={L} x2={W - R} y1={T + f * (H - T - B)} y2={T + f * (H - T - B)} />
          ))}
          {[
            [0, "09:30"],
            [30, "12:00"],
            [54, "14:00"],
            [N - 1, "16:00"],
          ].map(([i, t]) => (
            <text key={t} className="op-axis" x={px(i as number)} y={H - 10} textAnchor="middle">
              {t}
            </text>
          ))}
          <path className="op-line op-c" style={{ d: `path("${c}")` } as CSSProperties} d={c} />
          <path className="op-line op-x" style={{ d: `path("${x}")` } as CSSProperties} d={x} />
          <path className="op-line op-nav" d={path(series.nav)} />
        </svg>
      </div>
      <p className="op-legend">
        <span className="op-key op-c" /> AAPLc pool · Coinbase
        <span className="op-key op-x" /> AAPLx pool · xStocks
        <span className="op-key op-nav" /> NAV
        <span className="op-readout" aria-live="polite">
          {unison ? "Spread between issuers: 0 (conversion at NAV, fees apart)" : `Peak spread between issuers: ${maxSpread.toFixed(2)}%`}
        </span>
      </p>
    </section>
  );
}
