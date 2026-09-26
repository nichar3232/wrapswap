import { describe, expect, it } from "vitest";
import {
  chipWidth,
  diagramNodes,
  layout,
  suiLookup,
  type Rect,
} from "./diagramData";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const unichain = {
  contracts: {
    parityHook: addr(1),
    darkCrossHook: addr(2),
    wrapSwapRouter: addr(3),
    poolManager: addr(5),
  },
  tokens: [
    { symbol: "AAPLc", issuer: "coinbase", address: addr(7) },
    { symbol: "AAPLx", issuer: "xstocks", address: addr(8) },
  ],
};
// Explicit fixtures: the real manifests are never read by these tests.
const noUnichain = { contracts: {}, tokens: [] };
const noSui = {};
const node = (d: ReturnType<typeof diagramNodes>, id: string) =>
  d.nodes.find((n) => n.id === id)!;

describe("diagram data", () => {
  it("shows only the high-level product flow", () => {
    const d = diagramNodes(noUnichain, noSui);
    expect(d.nodes.map((n) => n.id).sort()).toEqual(
      ["dark", "issuers", "parity", "pay", "pm", "router"].sort(),
    );
    expect(d.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(
      [
        "issuers>router",
        "router>parity",
        "router>dark",
        "parity>pm",
        "dark>pm",
        "issuers>pay",
        "pay>issuers",
      ].sort(),
    );
  });
  it("every edge joins two drawn nodes and both hooks reach the PoolManager", () => {
    const d = diagramNodes(noUnichain, noSui);
    const ids = new Set(d.nodes.map((n) => n.id));
    for (const e of d.edges) {
      expect(ids.has(e.from), `${e.from} is not a node`).toBe(true);
      expect(ids.has(e.to), `${e.to} is not a node`).toBe(true);
    }
    const reach = (from: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(from)) return seen;
      seen.add(from);
      for (const e of d.edges.filter((x) => x.from === from)) reach(e.to, seen);
      return seen;
    };
    expect(reach("parity").has("pm")).toBe(true);
    expect(reach("dark").has("pm")).toBe(true);
    expect(reach("issuers").has("pm")).toBe(true);
  });
  it("boxes carry only their name (plus the PoolManager kicker), no sub-lines", () => {
    const d = diagramNodes(noUnichain, noSui);
    expect(d.nodes.every((n) => !("sub" in n))).toBe(true);
    expect(d.nodes.filter((n) => n.kick).map((n) => n.id)).toEqual(["pm"]);
  });
  it("renders every node non-clickable when no deployment files exist", () => {
    const d = diagramNodes(noUnichain, noSui);
    expect(d.nodes.every((n) => n.href === null)).toBe(true);
  });
  it("links contract nodes to Uniscan and leaves the rest unlinked", () => {
    const d = diagramNodes(unichain, noSui);
    const scan = (n: number) => `https://sepolia.uniscan.xyz/address/${addr(n)}`;
    expect(node(d, "parity").href).toBe(scan(1));
    expect(node(d, "dark").href).toBe(scan(2));
    expect(node(d, "router").href).toBe(scan(3));
    expect(node(d, "pm").href).toBe(scan(5));
    expect(node(d, "issuers").href).toBeNull(); // two tokens, no single address to link
    expect(node(d, "pay").href).toBeNull(); // no Sui manifest
  });
  it("finds Sui ids at the top level or under objects", () => {
    expect(suiLookup({ objects: { pool: "0xabc" } }, ["pool"])).toBe("0xabc");
    expect(suiLookup({ keeper: "0x12" }, ["keeper"])).toBe("0x12");
    expect(suiLookup({ pool: 3 }, ["pool"])).toBeUndefined();
    const d = diagramNodes(noUnichain, { poolId: "0xabc" });
    expect(node(d, "pay").href).toBe("https://suiscan.xyz/testnet/object/0xabc");
  });
  for (const kind of ["wide", "stacked"] as const)
    it(`${kind} layout: no overlapping nodes or chips, no chip on a node`, () => {
      const l = layout(kind, diagramNodes(noUnichain, noSui));
      const boxes = l.nodes;
      const hit = (a: Rect, b: Rect) =>
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      for (const [i, a] of boxes.entries())
        for (const b of boxes.slice(i + 1))
          expect(hit(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
      const chips = l.edges.map((e) => {
        const w = chipWidth(e.label);
        return { label: e.label, x: e.mid[0] - w / 2, y: e.mid[1] - 8, w, h: 16 };
      });
      for (const [i, c] of chips.entries()) {
        for (const b of boxes)
          expect(hit(c, b), `${c.label} chip covers ${b.id}`).toBe(false);
        for (const o of chips.slice(i + 1))
          expect(hit(c, o), `${c.label} chip overlaps ${o.label} chip`).toBe(false);
        expect(c.x >= 0 && c.x + c.w <= l.width, `${c.label} chip leaves the canvas`).toBe(true);
      }
      for (const n of l.nodes)
        expect(n.x >= 0 && n.x + n.w <= l.width && n.y + n.h <= l.height).toBe(true);
      // The one-line zone captions (baseline at zoneLabels, ~8px per character) never touch a box.
      for (const [zone, chars] of [["sui", 21], ["unichain", 10]] as const) {
        const [x, y] = l.zoneLabels[zone];
        const caption = { x, y: y - 9, w: chars * 8 + 8, h: 9 + 4 };
        for (const b of boxes)
          expect(hit(caption, b), `${zone} caption touches ${b.id}`).toBe(false);
      }
      // Tight canvas: little empty space above the first node (allowing for the accent halo) or below the last.
      const bottom = Math.max(...l.nodes.map((n) => n.y + n.h));
      expect(l.height - bottom, "empty space below the diagram").toBeLessThanOrEqual(8);
      if (kind === "wide") {
        const top = Math.min(...l.nodes.map((n) => n.y));
        expect(top, "empty space above the diagram").toBeLessThanOrEqual(10);
      }
    });
});
