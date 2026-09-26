import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { payRoutes, type PayReaders } from "./pay.js";

const d = {
  sui: { packageId: "0xpkg", poolId: "0x" + "a".repeat(64), windowMs: 90000 },
  evm: { chainId: 1301, shareVault: "0x0000000000000000000000000000000000000001" as const },
};
const pool = {
  poolId: d.sui.poolId,
  totalShares: 5n * 10n ** 18n,
  entriesRoot: "0x" + "b".repeat(64),
  manifestBlob: "blob1",
  batchSeq: 3,
  currentBatch: "0xb",
  windowMs: 90000,
  operator: "0xop",
  paused: false,
  receipts: 2,
};

async function app(over: Partial<PayReaders> = {}) {
  const a = Fastify();
  await payRoutes(a, d as any, {
    pool: async () => pool,
    reserves: async () => ({ held: 5n * 10n ** 18n + 7n, outstanding: 5n * 10n ** 18n, block: 99n }),
    ...over,
  });
  a.setErrorHandler((e: any, _req, reply) => reply.status(e.statusCode ?? 500).send({ error: { code: e.code, message: e.message } }));
  return a;
}

describe("pay routes", () => {
  it("reports the cross-chain reserves invariant with decimal-string integers", async () => {
    const r = (await (await app()).inject("/pay/reserves")).json();
    expect(r).toEqual({ suiTotalShares: "5000000000000000000", vaultShares: "5000000000000000000", vaultSharesHeld: "5000000000000000007", invariant: true, checkedBlock: "99" });
  });

  it("flags a broken invariant when custody is short", async () => {
    const r = (await (await app({ reserves: async () => ({ held: 1n, outstanding: 5n * 10n ** 18n, block: 1n }) })).inject("/pay/reserves")).json();
    expect(r.invariant).toBe(false);
  });

  it("flags a broken invariant when Sui credits exceed vault shares", async () => {
    const r = (await (await app({ pool: async () => ({ ...pool, totalShares: pool.totalShares + 1n }) })).inject("/pay/reserves")).json();
    expect(r.invariant).toBe(false);
  });

  it("returns 503 when a chain is unreachable", async () => {
    const r = await (await app({ pool: async () => { throw new Error("down"); } })).inject("/pay/reserves");
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("serves only the reserves route", async () => {
    expect((await (await app()).inject("/pay/pool")).statusCode).toBe(404);
  });
});
