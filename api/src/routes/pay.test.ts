import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { payRoutes, type PayReaders } from "./pay.js";
import { buildManifest } from "../../../services/crank/sui/protocol.js";
import { leafHash, verifyPath } from "../../../services/crank/sui/merkle.js";

const d = {
  sui: { packageId: "0xpkg", poolId: "0x" + "a".repeat(64), windowMs: 180000 },
  evm: { chainId: 1301, shareVault: "0x0000000000000000000000000000000000000001" as const },
  walrus: { aggregator: "http://walrus" },
};
const alice = "0x" + "1".repeat(64);
const bob = "0x" + "2".repeat(64);
const manifest = buildManifest(d.sui.poolId, 3, 5n * 10n ** 18n, new Map([
  [alice, new Uint8Array([1, 2, 3])],
  [bob, new Uint8Array([4, 5])],
]));
const pool = {
  poolId: d.sui.poolId,
  totalShares: 5n * 10n ** 18n,
  entriesRoot: manifest.root,
  manifestBlob: "blob1",
  batchSeq: 3,
  currentBatch: "0xb",
  windowMs: 180000,
  operator: "0xop",
  paused: false,
  receipts: 2,
};

async function app(over: Partial<PayReaders> = {}) {
  const a = Fastify();
  await payRoutes(a, d as any, {
    pool: async () => pool,
    batch: async () => ({ batchId: "0xb", pool: d.sui.poolId, seq: 4, opensMs: 1, closesMs: 180001, applied: false, instructions: [] }),
    manifest: async () => manifest,
    reserves: async () => ({ held: 5n * 10n ** 18n + 7n, outstanding: 5n * 10n ** 18n, block: 99n }),
    ...over,
  });
  a.setErrorHandler((e: any, _req, reply) => reply.status(e.statusCode ?? 500).send({ error: { code: e.code, message: e.message } }));
  return a;
}

describe("pay routes", () => {
  it("serves the pool with decimal-string totals", async () => {
    const r = await (await app()).inject("/pay/pool");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ totalShares: "5000000000000000000", batchSeq: 3, entriesRoot: manifest.root });
  });

  it("serves the current batch window", async () => {
    const r = (await (await app()).inject("/pay/batch/current")).json();
    expect(r).toMatchObject({ seq: 4, closesMs: 180001, submitted: 0, applied: false });
  });

  it("returns ciphertext and a verifying Merkle path, never plaintext", async () => {
    const r = (await (await app()).inject(`/pay/leaf/${bob}`)).json();
    expect(r.present).toBe(true);
    expect(r).not.toHaveProperty("balance");
    const hash = leafHash(bob as `0x${string}`, new Uint8Array([4, 5]));
    expect(r.leafHash).toBe(hash);
    expect(verifyPath(hash, r.merklePath, r.onchainRoot)).toBe(true);
  });

  it("treats an absent leaf as a zero balance", async () => {
    const r = await (await app()).inject("/pay/leaf/0x3");
    expect(r.statusCode).toBe(200);
    expect(r.json().present).toBe(false);
  });

  it("rejects a malformed address with 400", async () => {
    expect((await (await app()).inject("/pay/leaf/nope")).statusCode).toBe(400);
  });

  it("reports the cross-chain reserves invariant", async () => {
    const r = (await (await app()).inject("/pay/reserves")).json();
    expect(r).toEqual({ suiTotalShares: "5000000000000000000", vaultShares: "5000000000000000000", vaultSharesHeld: "5000000000000000007", invariant: true, checkedBlock: "99" });
    const broken = (await (await app({ reserves: async () => ({ held: 1n, outstanding: 5n * 10n ** 18n, block: 1n }) })).inject("/pay/reserves")).json();
    expect(broken.invariant).toBe(false);
  });

  it("returns 503 when a chain is unreachable", async () => {
    const r = await (await app({ pool: async () => { throw new Error("down"); } })).inject("/pay/pool");
    expect(r.statusCode).toBe(503);
  });
});
