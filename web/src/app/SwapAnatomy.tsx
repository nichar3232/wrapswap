/** Sequence diagram of one Convert: user → WrapSwapRouter → PoolManager → ParityHook.beforeSwap → oracle NAV → fill. */
export type SwapPath = "inventory" | "fall-through" | "peg";

const LANES = ["You", "WrapSwapRouter", "PoolManager", "ParityHook", "Oracle"];
const X = [70, 230, 390, 550, 690];
type Msg = { from: number; to: number; label: string; sub?: string; on: SwapPath[] };
const MSGS: Msg[] = [
  { from: 0, to: 1, label: "swapExactIn", sub: "amountIn, minOut", on: ["inventory", "fall-through", "peg"] },
  { from: 1, to: 2, label: "unlock · swap()", on: ["inventory", "fall-through", "peg"] },
  { from: 2, to: 3, label: "beforeSwap", on: ["inventory", "fall-through", "peg"] },
  { from: 3, to: 4, label: "read NAV", sub: "shares per token · mid", on: ["inventory", "fall-through", "peg"] },
  { from: 3, to: 2, label: "beforeSwapReturnDelta", sub: "fill from hook inventory · ERC-6909 claims", on: ["inventory"] },
  { from: 2, to: 1, label: "settle deltas", on: ["inventory", "fall-through"] },
  { from: 1, to: 0, label: "tokenOut ≥ minOut", on: ["inventory", "fall-through"] },
];
const TOP = 64,
  STEP = 44;

export function SwapAnatomy({ path }: { path?: SwapPath }) {
  const h = TOP + MSGS.length * STEP + 96;
  const lit = (m: Msg) => !path || m.on.includes(path);
  return (
    <div className="anatomy-scroll">
      <svg
        className="anatomy"
        viewBox={`0 0 760 ${h}`}
        role="img"
        aria-label={`Sequence of a Convert through ParityHook${path ? `; your last swap took the ${path} path` : ""}.`}
      >
        <defs>
          <marker id="an-arrow" viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
          </marker>
        </defs>
        {LANES.map((l, i) => (
          <g key={l}>
            <rect className={`an-lane${i === 3 ? " an-hook" : ""}`} x={X[i] - 62} y={12} width={124} height={30} rx={6} />
            <text className="an-lane-t" x={X[i]} y={32} textAnchor="middle">
              {l}
            </text>
            <line className="an-life" x1={X[i]} y1={42} x2={X[i]} y2={h - 90} />
          </g>
        ))}
        {MSGS.map((m, i) => {
          const y = TOP + i * STEP + 12;
          const on = lit(m) && !!path;
          const dir = m.to > m.from ? 1 : -1;
          return (
            <g key={i} className={`an-msg${on ? " an-on" : ""}${path && !lit(m) ? " an-off" : ""}`}>
              <line x1={X[m.from] + 4 * dir} y1={y} x2={X[m.to] - 6 * dir} y2={y} markerEnd="url(#an-arrow)" />
              <text x={(X[m.from] + X[m.to]) / 2} y={y - 7} textAnchor="middle" className="an-label">
                <tspan className="an-n">{i + 1} </tspan>
                {m.label}
              </text>
              {m.sub && (
                <text x={(X[m.from] + X[m.to]) / 2} y={y + 14} textAnchor="middle" className="an-sub">
                  {m.sub}
                </text>
              )}
            </g>
          );
        })}
        <g className={`an-note${path === "fall-through" ? " an-on" : ""}`}>
          <rect x={300} y={h - 80} width={210} height={46} rx={6} />
          <text x={312} y={h - 60} className="an-note-t">Inventory short?</text>
          <text x={312} y={h - 43} className="an-sub">falls through to the AMM curve</text>
        </g>
        <g className={`an-note an-warn${path === "peg" ? " an-on" : ""}`}>
          <rect x={530} y={h - 80} width={210} height={46} rx={6} />
          <text x={542} y={h - 60} className="an-note-t">Beyond 50 bps from NAV?</text>
          <text x={542} y={h - 43} className="an-sub">peg guard blocks the swap</text>
        </g>
        {path && (
          <text x={20} y={h - 52} className="an-sub an-legend">
            highlighted: your last swap
          </text>
        )}
      </svg>
    </div>
  );
}
