import { useEffect, useState } from "react";
import {
  chipWidth,
  diagramNodes,
  layout,
  suiFile,
  unichainFile,
  type Layout,
  type Node,
} from "./diagramData";

const ZONE_LABELS = {
  unichain: "UNICHAIN SEPOLIA · UNISWAP v4",
  sui: "SUI TESTNET · CONFIDENTIAL PAYMENTS",
};

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const m = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

function NodeBox({ n }: { n: Node }) {
  const cx = n.x + n.w / 2,
    cy = n.y + n.h / 2;
  // Baselines for kick / title / sub, centred as a block.
  const [ky, ty, sy] = n.kick
    ? n.sub
      ? [cy - 15, cy + 4, cy + 21]
      : [cy - 6, cy + 13, 0]
    : n.sub
      ? [0, cy - 3, cy + 14]
      : [0, cy + 5, 0];
  const body = (
    <>
      {n.accent && (
        <rect className="dg-pulse" x={n.x - 5} y={n.y - 5} width={n.w + 10} height={n.h + 10} rx={12} />
      )}
      <rect className={n.accent ? "dg-box dg-accent" : "dg-box"} x={n.x} y={n.y} width={n.w} height={n.h} rx={8} />
      {n.kick && (
        <text className="dg-kick" x={cx} y={ky} textAnchor="middle">
          {n.kick}
        </text>
      )}
      <text className="dg-title" x={cx} y={ty} textAnchor="middle">
        {n.title}
      </text>
      {n.sub && (
        <text className="dg-sub" x={cx} y={sy} textAnchor="middle">
          {n.sub}
        </text>
      )}
    </>
  );
  return n.href ? (
    <a
      className="dg-node dg-link"
      href={n.href}
      target="_blank"
      rel="noreferrer"
      aria-label={`${n.title} on the block explorer`}
      data-node={n.id}
    >
      {body}
    </a>
  ) : (
    <g className="dg-node" data-node={n.id}>
      {body}
    </g>
  );
}

function Svg({ l, kind, reduced }: { l: Layout; kind: string; reduced: boolean }) {
  const zone = (z: "unichain" | "sui") => l.nodes.filter((n) => n.zone === z && !n.group);
  const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  const edges = (z: "unichain" | "sui") => l.edges.filter((e) => byId[e.from].zone === z);
  const group = l.nodes.find((n) => n.group)!;
  const marker = `dg-arrow-${kind}`;
  const drawEdges = (z: "unichain" | "sui") =>
    edges(z).map((e, i) => {
      const w = chipWidth(e.label);
      return (
        <g key={e.from + e.to} className="dg-edge">
          <path id={`dg-${kind}-${e.from}-${e.to}`} d={e.d} markerEnd={`url(#${marker})`} />
          {!reduced && (
            // Hidden until its motion starts, so a delayed dot never flashes at the SVG origin.
            <circle className="dg-dot" r={2.5} visibility="hidden">
              <set attributeName="visibility" to="visible" begin={`${((i * 0.37) % 2).toFixed(2)}s`} />
              <animateMotion dur={`${2.6 + (i % 4) * 0.4}s`} begin={`${((i * 0.37) % 2).toFixed(2)}s`} repeatCount="indefinite" path={e.d} />
            </circle>
          )}
          <rect className="dg-chip" x={e.mid[0] - w / 2} y={e.mid[1] - 8} width={w} height={16} rx={3} />
          <text className="dg-label" x={e.mid[0]} y={e.mid[1] + 3.2} textAnchor="middle">
            {e.label}
          </text>
        </g>
      );
    });
  return (
    <svg
      className={`dg-svg dg-${kind}`}
      viewBox={`0 0 ${l.width} ${l.height}`}
      role="group"
      aria-label="Architecture: issuer tokens are normalized to shares and routed through WrapSwapRouter to the ParityHook or crossed in sealed batches by the DarkCrossHook, both settling on the Uniswap v4 PoolManager; on Sui, Unison Pay keeps encrypted balances and withdraws cross-issuer through the ShareVault on Unichain."
    >
      <defs>
        <marker id={marker} viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" className="dg-arrowhead" />
        </marker>
      </defs>
      <g className="dg-zone dg-zone-sui">
        <rect className="dg-hit" x={0} y={l.divider.y1} width={l.width} height={l.height - l.divider.y1} />
        <text className="dg-zone-label" x={l.zoneLabels.sui[0]} y={l.zoneLabels.sui[1]}>
          {ZONE_LABELS.sui}
        </text>
        {drawEdges("sui")}
        {zone("sui").map((n) => (
          <NodeBox key={n.id} n={n} />
        ))}
      </g>
      <line className="dg-divider" {...l.divider} />
      <g className="dg-zone dg-zone-unichain">
        <text className="dg-zone-label" x={l.zoneLabels.unichain[0]} y={l.zoneLabels.unichain[1]}>
          {ZONE_LABELS.unichain}
        </text>
        <rect className="dg-group" x={group.x} y={group.y} width={group.w} height={group.h} rx={10} />
        <text className="dg-group-label" x={group.x + 12} y={group.y + 16}>
          ISSUER TOKENS
        </text>
        {drawEdges("unichain")}
        {zone("unichain").map((n) => (
          <NodeBox key={n.id} n={n} />
        ))}
      </g>
    </svg>
  );
}

/** Architecture diagram: two zones (Unichain primary, Sui secondary); wide above 900px, stacked below. */
export function Diagram() {
  const reduced = useReducedMotion();
  const data = diagramNodes(unichainFile, suiFile);
  return (
    <figure className="diagram" aria-label="Architecture">
      <div className="diagram-scroll">
        <Svg l={layout(data)} kind="main" reduced={reduced} />
      </div>
    </figure>
  );
}
