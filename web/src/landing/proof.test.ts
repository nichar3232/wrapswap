import { describe, expect, it } from "vitest";
import { proofRows, short } from "./proof";

const contracts = {
  parityHook: "0x0000000000000000000000000000000000000001",
  darkCrossHook: "0x0000000000000000000000000000000000000002",
  wrapSwapRouter: "0x0000000000000000000000000000000000000003",
  registry: "0x0000000000000000000000000000000000000004",
  poolManager: "0x0000000000000000000000000000000000000005",
  oracle: "0x0000000000000000000000000000000000000006",
};

describe("proofRows", () => {
  it("lists the proof contracts in order with Uniscan links", () => {
    const rows = proofRows({ contracts });
    expect(rows.map((r) => r.name)).toEqual([
      "ParityHook",
      "DarkCrossHook",
      "WrapSwapRouter",
      "IssuerRegistry",
      "PoolManager",
    ]);
    expect(rows[3].url).toBe(
      `https://sepolia.uniscan.xyz/address/${contracts.registry}`,
    );
  });
  it("omits contracts a deployment lacks, and everything when there is none", () => {
    expect(proofRows({ contracts: { parityHook: "0xabc" } })).toHaveLength(1);
    expect(proofRows(undefined)).toEqual([]);
  });
  it("shortens hex for display", () => {
    expect(short("0x708AeC5CD2C504A8fB40615aC797C52BB2EB20c8")).toBe(
      "0x708A…20c8",
    );
  });
});
