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
  unichain: ["UNISWAP v4"],
  sui: ["CONFIDENTIAL PAYMENTS"],
};

/** Every edge dot uses this one duration and starts at 0s, so they all travel in lockstep. */
const DOT_SECONDS = 2.6;

function ZoneLabel({ lines, at }: { lines: string[]; at: [number, number] }) {
  return (
    <text className="dg-zone-label" x={at[0]} y={at[1]}>
      {lines.map((line, i) => (
        <tspan key={line} x={at[0]} dy={i === 0 ? 0 : 13}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

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
  // The name alone, or with a small kicker above it, centred as a block.
  const [ky, ty] = n.kick ? [cy - 7, cy + 15] : [0, cy + 6];
  const body = (
    <>
      <rect className={n.accent ? "dg-box dg-accent" : "dg-box"} x={n.x} y={n.y} width={n.w} height={n.h} rx={10} />
      {n.kick && (
        <text className="dg-kick" x={cx} y={ky} textAnchor="middle">
          {n.kick}
        </text>
      )}
      <text className="dg-title" x={cx} y={ty} textAnchor="middle">
        {n.title}
      </text>
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
  const zone = (z: "unichain" | "sui") => l.nodes.filter((n) => n.zone === z);
  const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  const edges = (z: "unichain" | "sui") => l.edges.filter((e) => byId[e.from].zone === z);
  const marker = `dg-arrow-${kind}`;
  const drawEdges = (z: "unichain" | "sui") =>
    edges(z).map((e) => {
      const w = chipWidth(e.label);
      return (
        <g key={e.from + e.to} className="dg-edge">
          <path id={`dg-${kind}-${e.from}-${e.to}`} d={e.d} markerEnd={`url(#${marker})`} />
          {!reduced && (
            <circle className="dg-dot" r={3}>
              <animateMotion dur={`${DOT_SECONDS}s`} begin="0s" repeatCount="indefinite" path={e.d} />
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
      aria-label="Architecture: issuer tokens go through the WrapSwapRouter and are either filled instantly at share parity by the ParityHook or crossed in sealed batches by the DarkCrossHook, both settling on the Uniswap v4 PoolManager on Unichain; on Sui, Unison Pay holds private payment balances that deposit from and withdraw to issuer tokens."
    >
      <defs>
        <marker id={marker} viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="4.5" markerHeight="4.5" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" className="dg-arrowhead" />
        </marker>
      </defs>
      <g className="dg-zone dg-zone-sui">
        <rect className="dg-hit" x={0} y={0} width={l.suiZone.w} height={l.suiZone.h} />
        <ZoneLabel lines={ZONE_LABELS.sui} at={l.zoneLabels.sui} />
        {drawEdges("sui")}
        {zone("sui").map((n) => (
          <NodeBox key={n.id} n={n} />
        ))}
      </g>
      <g className="dg-zone dg-zone-unichain">
        <ZoneLabel lines={ZONE_LABELS.unichain} at={l.zoneLabels.unichain} />
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
        <Svg l={layout("wide", data)} kind="wide" reduced={reduced} />
        <Svg l={layout("stacked", data)} kind="stacked" reduced={reduced} />
      </div>
    </figure>
  );
}
