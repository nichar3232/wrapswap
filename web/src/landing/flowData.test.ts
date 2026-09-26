import { describe, expect, it } from "vitest";
import { devLanes, suiLookup } from "./flowData";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
// Explicit fixtures: the real manifests are never read by these tests.
const unichain = {
  contracts: { wrapSwapRouter: addr(1), poolManager: addr(2), parityHook: addr(3), darkCrossHook: addr(4) },
};
const lane = (id: string, u = {}, s = {}) => devLanes(u, s).find((l) => l.id === id)!;

describe("developer diagram", () => {
  it("follows v4's call order: router → PoolManager.swap → ParityHook.beforeSwap → delta settled", () => {
    const main = lane("uniswap", unichain);
    expect(main.nodes.map((n) => n.contract)).toEqual([
      "your wallet",
      "WrapSwapRouter.swapExactIn",
      "PoolManager.swap",
      "ParityHook.beforeSwap",
      "PoolManager delta settled",
    ]);
    expect(main.nodes[3].sub).toContain("beforeSwapReturnDelta");
    expect(main.nodes[3].href).toBe(`https://sepolia.uniscan.xyz/address/${addr(3)}`);
  });
  it("labels nodes by what they do for the user, contract second", () => {
    for (const l of devLanes(unichain, {})) for (const n of l.nodes) expect(n.does).not.toMatch(/Hook|Manager|Router/);
  });
  it("has Dark Cross and Sui lanes; Sui is secondary and batches every 90 s", () => {
    expect(lane("dark", unichain).nodes.map((n) => n.contract)).toEqual(["DarkCrossHook.commit", "DarkCrossHook.settle", "PoolManager"]);
    const sui = lane("sui", unichain, { poolId: "0xabc", evm: { shareVault: addr(9) } });
    expect(sui.secondary).toBe(true);
    expect(sui.nodes.find((n) => n.id === "pay")?.sub).toBe("keeper batches every 90 s");
    expect(sui.nodes.find((n) => n.id === "vault")?.href).toContain(addr(9));
    expect(sui.nodes.find((n) => n.id === "pay")?.href).toBe("https://suiscan.xyz/testnet/object/0xabc");
  });
  it("leaves nodes unlinked when files or keys are missing", () => {
    expect(devLanes(undefined, undefined).flatMap((l) => l.nodes).every((n) => n.href === null)).toBe(true);
    expect(suiLookup({ pool: 3 }, ["pool"])).toBeUndefined();
  });
});
