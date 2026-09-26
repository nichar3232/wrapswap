import { describe, expect, it } from "vitest";
import { contractGroups, proofRows, proofTxs, short } from "./proof";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const contracts = {
  parityHook: addr(1),
  darkCrossHook: addr(2),
  wrapSwapRouter: addr(3),
  registry: addr(4),
  poolManager: addr(5),
  oracle: addr(6),
  eligibility: addr(7),
};

describe("contract links", () => {
  it("lists the core contracts in order with Uniscan links", () => {
    const rows = proofRows({ contracts });
    expect(rows.map((r) => r.name)).toEqual(["ParityHook", "WrapSwapRouter", "PoolManager", "IssuerRegistry", "Eligibility", "Price oracle"]);
    expect(rows[3].url).toBe(`https://sepolia.uniscan.xyz/address/${contracts.registry}`);
  });
  it("groups per-asset hooks, wrappers and adapters, and the faucet", () => {
    const g = contractGroups({
      contracts,
      faucet: addr(9),
      assets: [{ symbol: "NVDA", darkCrossHook: addr(10), wrappers: [{ platform: "Coinbase", symbol: "mcbNVDA", token: addr(11), adapter: addr(12) }] }],
    });
    expect(g.map((x) => x.title)).toEqual(["Core", "NVDA", "Testnet"]);
    expect(g[1].rows.map((r) => r.name)).toEqual(["DarkCrossHook", "Coinbase wrapper · mcbNVDA", "Coinbase adapter"]);
  });
  it("omits contracts a deployment lacks, and everything when there is none", () => {
    expect(proofRows({ contracts: { parityHook: addr(1), oracle: "0xabc" } })).toHaveLength(1);
    expect(contractGroups(undefined)).toEqual([]);
  });
  it("reads proof txs in either manifest shape, valid hashes only", () => {
    const h = "0x" + "7".repeat(64);
    expect(proofTxs({ proofs: [{ label: "Convert", tx: h }, { tx: "0xnot" }] })).toEqual([{ label: "Convert", hash: h, url: `https://sepolia.uniscan.xyz/tx/${h}` }]);
    expect(proofTxs({ proofs: { swaps: [{ hash: h }] } })).toHaveLength(1);
    expect(proofTxs(undefined)).toEqual([]);
  });
  it("shortens hex for display", () => {
    expect(short("0x708AeC5CD2C504A8fB40615aC797C52BB2EB20c8")).toBe("0x708A…20c8");
  });
});
