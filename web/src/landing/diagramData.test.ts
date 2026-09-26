import { describe, expect, it } from "vitest";
import {
  chipWidth,
  diagramNodes,
  hasCanonicalVault,
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
    registry: addr(4),
    poolManager: addr(5),
    oracle: addr(6),
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
  it("renders every node non-clickable when no deployment files exist", () => {
    const d = diagramNodes(noUnichain, noSui);
    expect(d.nodes.every((n) => n.href === null)).toBe(true);
    expect(d.vault).toBe(false);
    expect(node(d, "center").title).toBe("Multiplier adapters");
    expect(d.edges.filter((e) => e.label === "NORMALIZE")).toHaveLength(2);
  });
  it("links Unichain nodes to Uniscan and leaves missing addresses unlinked", () => {
    const d = diagramNodes(unichain, noSui);
    expect(node(d, "parity").href).toBe(
      `https://sepolia.uniscan.xyz/address/${addr(1)}`,
    );
    expect(node(d, "aaplx").href).toContain(addr(8));
    expect(node(d, "shareVault").href).toBeNull(); // not in the Unichain manifest
    expect(node(d, "pool").href).toBeNull();
  });
  it("switches the centre node to the canonical vault when uAAPL exists", () => {
    const withVault = {
      ...unichain,
      contracts: { ...unichain.contracts, canonicalStock: addr(9) },
    };
    expect(hasCanonicalVault(withVault)).toBe(true);
    const d = diagramNodes(withVault, noSui);
    expect(node(d, "center").title).toBe("uAAPL");
    expect(node(d, "center").href).toContain(addr(9));
    expect(d.edges.filter((e) => e.label === "WRAP 1:1")).toHaveLength(2);
  });
  it("finds Sui ids at the top level or under objects", () => {
    expect(suiLookup({ objects: { pool: "0xabc" } }, ["pool"])).toBe("0xabc");
    expect(suiLookup({ keeper: "0x12" }, ["keeper"])).toBe("0x12");
    expect(suiLookup({ pool: 3 }, ["pool"])).toBeUndefined();
    const d = diagramNodes(noUnichain, { poolId: "0xabc", keeper: "0x12" });
    expect(node(d, "pool").href).toBe("https://suiscan.xyz/testnet/object/0xabc");
    expect(node(d, "keeper").href).toBe("https://suiscan.xyz/testnet/account/0x12");
    expect(node(d, "seal").href).toBeNull();
  });
  it("links ShareVault from sui-testnet.json evm.shareVault, unlinked without it", () => {
    const withVault = diagramNodes(noUnichain, { evm: { shareVault: addr(10) } });
    expect(node(withVault, "shareVault").href).toBe(
      `https://sepolia.uniscan.xyz/address/${addr(10)}`,
    );
    expect(node(diagramNodes(noUnichain, { evm: {} }), "shareVault").href).toBeNull();
    expect(node(diagramNodes(noUnichain, noSui), "shareVault").href).toBeNull();
  });
  for (const kind of ["wide", "stacked"] as const)
    it(`${kind} layout: no overlapping nodes, no chip on a node`, () => {
      const l = layout(kind, diagramNodes(noUnichain, noSui));
      const boxes = l.nodes.filter((n) => !n.group);
      const hit = (a: Rect, b: Rect) =>
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      for (const [i, a] of boxes.entries())
        for (const b of boxes.slice(i + 1))
          expect(hit(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
      for (const e of l.edges) {
        const w = chipWidth(e.label);
        const chip = { x: e.mid[0] - w / 2, y: e.mid[1] - 8, w, h: 16 };
        for (const b of boxes)
          expect(hit(chip, b), `${e.label} chip covers ${b.id}`).toBe(false);
        expect(chip.x >= 0 && chip.x + w <= l.width).toBe(true);
      }
      for (const n of l.nodes)
        expect(n.x >= 0 && n.x + n.w <= l.width && n.y + n.h <= l.height).toBe(true);
    });
});
