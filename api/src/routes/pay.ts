import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { unichainSepolia } from "viem/chains";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { readPool } from "../../../services/crank/sui/chain.js";
import { fault } from "./index.js";

// Unison Pay reserves: the one cross-chain read the browser shouldn't have to assemble itself. GET only, reads Sui
// testnet and Unichain Sepolia directly (no Postgres), chain integers as decimal strings. Everything else on /pay
// (pool, batch window, encrypted leaves) is read by the browser straight from Sui and Walrus.

type PayDeployment = {
  sui: { packageId: string; poolId: string; windowMs: number };
  evm: null | { chainId: number; shareVault: `0x${string}` };
};

export type PayReaders = {
  pool: () => Promise<Awaited<ReturnType<typeof readPool>>>;
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
    // publicnode by default: sepolia.unichain.org backends disagree on recent state (see services/crank/sui/config.ts).
    transport: http(process.env.PAY_EVM_RPC_URL ?? "https://unichain-sepolia-rpc.publicnode.com"),
  });
  return {
    pool: () => readPool(sui, d.sui.poolId),
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
  app.get("/pay/reserves", async () => {
    const [p, r] = await Promise.all([guarded(readers.pool), guarded(readers.reserves)]);
    return {
      suiTotalShares: p.totalShares.toString(),
      vaultShares: r.outstanding.toString(),
      vaultSharesHeld: r.held.toString(),
      invariant: p.totalShares === r.outstanding && r.held >= r.outstanding,
      // The keeper's hard rule: Sui credits never exceed what ShareVault custodies.
      solvent: p.totalShares <= r.held,
      checkedBlock: r.block.toString(),
    };
  });
}
