import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { unichainSepolia } from "viem/chains";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { readBatch, readPool } from "../../../services/crank/sui/chain.js";
import { leafProof, type Manifest } from "../../../services/crank/sui/protocol.js";
import { fault } from "./index.js";

// Unison Pay read API. GET only, reads Sui testnet and Unichain Sepolia directly (no Postgres), chain integers as
// decimal strings. /pay/leaf returns ciphertext and a Merkle path only: the server never sees a plaintext balance.

type PayDeployment = {
  sui: { packageId: string; poolId: string; windowMs: number };
  evm: null | { chainId: number; shareVault: `0x${string}` };
  walrus: { aggregator: string };
};

export type PayReaders = {
  pool: () => Promise<Awaited<ReturnType<typeof readPool>>>;
  batch: (id: string) => Promise<Awaited<ReturnType<typeof readBatch>>>;
  manifest: (blobId: string) => Promise<Manifest>;
  reserves: () => Promise<{ held: bigint; outstanding: bigint; block: bigint }>;
};

const vaultAbi = parseAbi(["function reserves() view returns (uint256 held, uint256 outstanding)"]);

export function loadPayDeployment(): PayDeployment {
  const path = process.env.PAY_DEPLOYMENT ?? resolve(import.meta.dirname, "../../../deployments/sui-testnet.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function liveReaders(d: PayDeployment): PayReaders {
  const sui = new SuiGrpcClient({
    network: "testnet",
    baseUrl: process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443",
  });
  const evm = createPublicClient({
    chain: unichainSepolia,
    transport: http(process.env.PAY_EVM_RPC_URL ?? process.env.UNICHAIN_SEPOLIA_RPC_URL ?? "https://sepolia.unichain.org"),
  });
  const manifests = new Map<string, Manifest>(); // Walrus blobs are immutable
  return {
    pool: () => readPool(sui, d.sui.poolId),
    batch: (id) => readBatch(sui, id),
    async manifest(blobId) {
      const hit = manifests.get(blobId);
      if (hit) return hit;
      const res = await fetch(`${d.walrus.aggregator}/v1/blobs/${blobId}`);
      if (!res.ok) throw Error(`walrus ${res.status}`);
      const m = (await res.json()) as Manifest;
      if (manifests.size > 64) manifests.clear();
      manifests.set(blobId, m);
      return m;
    },
    async reserves() {
      if (!d.evm) throw Error("ShareVault not deployed");
      const block = await evm.getBlockNumber();
      const [held, outstanding] = await evm.readContract({
        address: d.evm.shareVault,
        abi: vaultAbi,
        functionName: "reserves",
        blockNumber: block,
      });
      return { held, outstanding, block };
    },
  };
}

const unavailable = (e: unknown) =>
  Object.assign(fault("CHAIN_UNAVAILABLE", String((e as Error)?.message ?? e)), { cause: e });

async function guarded<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw unavailable(e);
  }
}

export async function payRoutes(app: FastifyInstance, d = loadPayDeployment(), readers = liveReaders(d)) {
  app.get("/pay/pool", async () => {
    const p = await guarded(readers.pool);
    return {
      packageId: d.sui.packageId,
      poolId: p.poolId,
      totalShares: p.totalShares.toString(),
      entriesRoot: p.entriesRoot || null,
      manifestBlob: p.manifestBlob || null,
      batchSeq: p.batchSeq,
      currentBatch: p.currentBatch,
      windowMs: p.windowMs,
      paused: p.paused,
      operator: p.operator,
    };
  });

  app.get("/pay/batch/current", async () => {
    const p = await guarded(readers.pool);
    const b = await guarded(() => readers.batch(p.currentBatch));
    return {
      batchId: b.batchId,
      seq: b.seq,
      opensMs: b.opensMs || null,
      closesMs: b.closesMs || null,
      submitted: b.instructions.length,
      applied: b.applied,
      nowMs: Date.now(),
    };
  });

  app.get("/pay/leaf/:addr", async (req) => {
    const { addr } = req.params as { addr: string };
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(addr)) throw fault("BAD_REQUEST", "Invalid Sui address");
    const p = await guarded(readers.pool);
    const owner = `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;
    if (!p.manifestBlob) {
      return { owner, present: false, manifestBlob: null, seq: p.batchSeq, onchainRoot: p.entriesRoot || null };
    }
    const m = await guarded(() => readers.manifest(p.manifestBlob));
    const proof = leafProof(m, owner);
    const base = { owner, manifestBlob: p.manifestBlob, seq: m.seq, onchainRoot: p.entriesRoot, manifestRoot: m.root };
    // An absent leaf is a zero balance, not an error.
    if (!proof) return { ...base, present: false };
    return { ...base, present: true, ciphertext: proof.ct, leafHash: proof.hash, merklePath: proof.path };
  });

  app.get("/pay/reserves", async () => {
    const [p, r] = await Promise.all([guarded(readers.pool), guarded(readers.reserves)]);
    return {
      suiTotalShares: p.totalShares.toString(),
      vaultShares: r.outstanding.toString(),
      vaultSharesHeld: r.held.toString(),
      invariant: p.totalShares === r.outstanding && r.held >= r.outstanding,
      checkedBlock: r.block.toString(),
    };
  });
}
