import "dotenv/config";
import Fastify from "fastify";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  abi,
  manifest,
  publicClient,
  read,
  rpc,
} from "../../api/src/chain/client.js";
const m = manifest();
const local = /^http:\/\/(127\.0\.0\.1|localhost):/.test(rpc) && m.demoMode;
const key =
  process.env.CRANK_PK || (local ? m.burners?.[0]?.privateKey : undefined);
if (!key) throw Error("CRANK_PK is required");
const account = privateKeyToAccount(key as `0x${string}`);
const wallet = createWalletClient({ account, transport: http(rpc) });
const status = {
  ok: true,
  lastBatch: null as string | null,
  lastTx: null as string | null,
  lastError: null as string | null,
};
const app = Fastify();
app.get("/status", async () => status);
await app.listen({
  port: Number(process.env.CRANK_PORT || 4001),
  host: "127.0.0.1",
});
let busy = false,
  attempt = 0;
publicClient.watchBlockNumber({
  emitOnBegin: true,
  pollingInterval: 1000,
  onBlockNumber: async () => {
    if (busy) return;
    busy = true;
    try {
      const [current, phase] = await read("darkCrossHook", "currentBatch");
      // Revisit the previous batch after a missed settle window or transient RPC failure.
      const candidates: bigint[] = [];
      if (current > 0n) candidates.push(current - 1n);
      if (Number(phase) === 2) candidates.push(current);
      for (const id of candidates) {
        const [settled, participants] = await Promise.all([
          read("darkCrossHook", "settled", [id]),
          read("darkCrossHook", "participants", [id]),
        ]);
        if (settled || participants.length === 0) continue;
        const gasPrice = await publicClient.getGasPrice();
        const simulation = await publicClient.simulateContract({
          account,
          address: m.contracts.darkCrossHook,
          abi: abi("DarkCrossHook"),
          functionName: "settle",
          args: [id],
        });
        const hash = await wallet.writeContract({
          chain: null,
          address: m.contracts.darkCrossHook,
          abi: abi("DarkCrossHook"),
          functionName: "settle",
          args: [id],
          gasPrice: (gasPrice * BigInt(100 + Math.min(attempt, 5) * 20)) / 100n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success")
          throw Error("Settlement reverted " + hash);
        status.lastBatch = id.toString();
        status.lastTx = hash;
        status.lastError = null;
        status.ok = true;
        attempt = 0;
        console.log(
          JSON.stringify({
            event: "settled",
            batch: status.lastBatch,
            tx: hash,
          }),
        );
      }
    } catch (error) {
      attempt++;
      status.ok = false;
      status.lastError = String(error);
      console.error(status.lastError);
    } finally {
      busy = false;
    }
  },
});
