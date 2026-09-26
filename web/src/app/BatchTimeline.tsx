import type { BatchPhase } from "@wrapswap/types";

/** Block position inside the batch, from the phase and the blocks left in it (independent of batch origin). */
export function batchPosition(
  phase: BatchPhase,
  blocksLeft: number,
  dark: { batchBlocks: number; commitBlocks: number; revealBlocks: number },
) {
  const settleBlocks = dark.batchBlocks - dark.commitBlocks - dark.revealBlocks;
  const start = phase === "COMMIT" ? 0 : phase === "REVEAL" ? dark.commitBlocks : dark.commitBlocks + dark.revealBlocks;
  const len = phase === "COMMIT" ? dark.commitBlocks : phase === "REVEAL" ? dark.revealBlocks : settleBlocks;
  return Math.min(dark.batchBlocks, Math.max(0, start + len - Math.min(len, blocksLeft)));
}

/** commit → reveal → settle at the 30-min midpoint → residual to pool, sized to the batch's blocks. */
export function BatchTimeline({
  phase,
  blocksLeft,
  dark,
}: {
  phase?: BatchPhase;
  blocksLeft?: number;
  dark: { batchBlocks: number; commitBlocks: number; revealBlocks: number };
}) {
  const W = 600,
    x0 = 16,
    per = W / dark.batchBlocks;
  const settle = dark.batchBlocks - dark.commitBlocks - dark.revealBlocks;
  const segs = [
    { key: "COMMIT", label: "Commit", sub: `${dark.commitBlocks} blocks · sealed`, from: 0, n: dark.commitBlocks },
    { key: "REVEAL", label: "Reveal", sub: `${dark.revealBlocks} blocks`, from: dark.commitBlocks, n: dark.revealBlocks },
    { key: "SETTLE", label: "Settle", sub: "at the 30-min midpoint", from: dark.commitBlocks + dark.revealBlocks, n: settle },
  ];
  const pos = phase && blocksLeft !== undefined ? batchPosition(phase, blocksLeft, dark) : undefined;
  return (
    <div className="timeline-scroll">
      <svg
        className="timeline"
        viewBox="0 0 780 92"
        role="img"
        aria-label={`Batch timeline: commit ${dark.commitBlocks} blocks, reveal ${dark.revealBlocks}, settle ${settle}, then the residual routes to the ParityHook pool.${phase ? ` Current phase: ${phase.toLowerCase()}.` : ""}`}
      >
        {segs.map((s) => {
          const on = s.key === phase;
          const x = x0 + s.from * per,
            w = s.n * per;
          return (
            <g key={s.key} className={`tl-seg${on ? " tl-on" : ""}`}>
              <rect x={x + 1} y={18} width={w - 2} height={22} rx={4} />
              <text className="tl-label" x={x + 8} y={33}>
                {s.label}
              </text>
              <text className="tl-sub" x={x + 2} y={60}>
                {s.sub}
              </text>
            </g>
          );
        })}
        {Array.from({ length: dark.batchBlocks + 1 }, (_, i) => (
          <line key={i} className="tl-tick" x1={x0 + i * per} x2={x0 + i * per} y1={42} y2={i % 5 ? 45 : 48} />
        ))}
        <g className="tl-residual">
          <path d={`M${x0 + W + 8} 29 H${x0 + W + 44}`} markerEnd="url(#tl-arrow)" />
          <text className="tl-label" x={x0 + W + 50} y={27}>
            Residual
          </text>
          <text className="tl-sub" x={x0 + W + 50} y={42}>
            to the pool
          </text>
        </g>
        <defs>
          <marker id="tl-arrow" viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
          </marker>
        </defs>
        {pos !== undefined && (
          <g className="tl-now" transform={`translate(${x0 + pos * per} 0)`}>
            <line y1={10} y2={50} />
            <circle cy={10} r={3.5} />
            <text y={82} textAnchor="middle" className="tl-sub">
              now · block {pos}/{dark.batchBlocks}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
