import type { BatchPhase } from "@wrapswap/types";

type Dark = { batchBlocks: number; commitBlocks: number; revealBlocks: number };

/** Block position inside the batch, from the phase and the blocks left in it (independent of batch origin). */
export function batchPosition(phase: BatchPhase, blocksLeft: number, dark: Dark) {
  const settleBlocks = dark.batchBlocks - dark.commitBlocks - dark.revealBlocks;
  const start = phase === "COMMIT" ? 0 : phase === "REVEAL" ? dark.commitBlocks : dark.commitBlocks + dark.revealBlocks;
  const len = phase === "COMMIT" ? dark.commitBlocks : phase === "REVEAL" ? dark.revealBlocks : settleBlocks;
  return Math.min(dark.batchBlocks, Math.max(0, start + len - Math.min(len, blocksLeft)));
}

/** Blocks until the batch crosses (the start of the settle window). */
export function blocksToCross(phase: BatchPhase, blocksLeft: number, dark: Dark) {
  return phase === "COMMIT" ? blocksLeft + dark.revealBlocks : phase === "REVEAL" ? blocksLeft : 0;
}

/** Compact strip: commit → reveal → cross (widths in blocks), then the residual to the pool. */
export function BatchTimeline({ phase, blocksLeft, dark }: { phase?: BatchPhase; blocksLeft?: number; dark: Dark }) {
  const settle = dark.batchBlocks - dark.commitBlocks - dark.revealBlocks;
  const segs = [
    { key: "COMMIT", label: "Commit", n: dark.commitBlocks },
    { key: "REVEAL", label: "Reveal", n: dark.revealBlocks },
    { key: "SETTLE", label: "Cross", n: settle },
  ];
  const pos = phase && blocksLeft !== undefined ? batchPosition(phase, blocksLeft, dark) : undefined;
  return (
    <div
      className="timeline"
      role="img"
      aria-label={`Batch of ${dark.batchBlocks} blocks: commit ${dark.commitBlocks}, reveal ${dark.revealBlocks}, cross ${settle}, then the residual goes to the pool.${phase ? ` Current phase: ${phase.toLowerCase()}.` : ""}`}
    >
      <div className="tl-strip">
        {segs.map((s) => (
          <span key={s.key} className={`tl-seg${s.key === phase ? " tl-on" : ""}`} style={{ flexGrow: s.n }}>
            {s.label} <small>{s.n}</small>
          </span>
        ))}
        {pos !== undefined && <span className="tl-now" style={{ left: `${(pos / dark.batchBlocks) * 100}%` }} />}
      </div>
      <span className="tl-residual">→ Residual to pool</span>
    </div>
  );
}
