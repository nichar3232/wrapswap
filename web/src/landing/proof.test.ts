import { describe, expect, it } from "vitest";
import deployment from "../../../deployments/base-sepolia.json";
import { proofRows, short } from "./proof";

describe("proofRows", () => {
  it("reads the proof contracts from the deployment file, in order", () => {
    const rows = proofRows(deployment);
    expect(rows.map((r) => r.name)).toEqual([
      "ParityHook",
      "DarkCrossHook",
      "WrapSwapRouter",
      "IssuerRegistry",
      "PoolManager",
    ]);
    expect(rows[0].address).toBe(deployment.contracts.parityHook);
    expect(rows[3].url).toBe(
      `https://sepolia.basescan.org/address/${deployment.contracts.registry}`,
    );
  });
  it("omits contracts a deployment lacks", () => {
    expect(proofRows({ contracts: { parityHook: "0xabc" } })).toHaveLength(1);
  });
  it("shortens hex for display", () => {
    expect(short("0x708AeC5CD2C504A8fB40615aC797C52BB2EB20c8")).toBe(
      "0x708A…20c8",
    );
  });
});
