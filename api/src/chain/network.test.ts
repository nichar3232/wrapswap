import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployment } from "./client.js";
import { deployment } from "../testing/fixtures.js";
it("NETWORK selects the same schema and loader with different addresses/start blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "wrapswap-network-"));
  mkdirSync(join(root, "deployments"));
  try {
    const base = {
      ...deployment,
      network: "base-sepolia",
      chainId: 84532,
      startBlock: "123",
      contracts: { ...deployment.contracts, registry: "0x" + "1".repeat(40) },
      blocks: { registry: "123" },
    };
    for (const d of [deployment, base])
      writeFileSync(
        join(root, "deployments", d.network + ".json"),
        JSON.stringify(d),
      );
    const a = loadDeployment("anvil", root),
      b = loadDeployment("base-sepolia", root);
    expect(a.tokens).toEqual(b.tokens);
    expect(a.pool).toEqual(b.pool);
    expect(b.startBlock).toBe("123");
    expect(a.contracts.registry).not.toBe(b.contracts.registry);
    expect(() => loadDeployment("mainnet", root)).toThrow();
  } finally {
    rmSync(root, { recursive: true });
  }
});
