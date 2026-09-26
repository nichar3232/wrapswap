import "dotenv/config";
import Fastify from "fastify";
import { createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { validators } from "@wrapswap/types";
import {
  loadDeployment,
  assetViews,
  publicClient,
  rpc,
} from "../../api/src/chain/client.js";
import { Crank, retryDelay } from "./worker.js";
for (const key of ["RPC_URL", "CRANK_HEALTH_PORT"])
  if (!process.env[key]) throw Error(`${key} is required`);
const d = loadDeployment();
const mnemonic =
  process.env.DEMO_MNEMONIC ??
  (d.network === "anvil"
    ? "test test test test test test test test test test test junk"
    : undefined);
const account = process.env.CRANK_PK
  ? privateKeyToAccount(process.env.CRANK_PK as `0x${string}`)
  : mnemonic
    ? mnemonicToAccount(mnemonic, { addressIndex: 4 })
    : null;
if (!account) throw Error("CRANK_PK or DEMO_MNEMONIC is required");
const mode = process.env.ORACLE_MODE ?? (d.mockOracle ? "mock" : "external");
if (!["mock", "external"].includes(mode))
  throw Error("ORACLE_MODE must be mock or external");
// One worker per asset's DarkCrossHook (oracle push, settle, peg check), ticked in turn: they share one signer.
const wallet = createWalletClient({ account, transport: http(rpc) });
const cranks = assetViews(d).map((view) => new Crank(view, publicClient, wallet, account, mode));
const latest = <T>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null).at(-1) ?? null;
const status = () => {
  const all = cranks.map((c) => c.status);
  const blocks = all.map((s) => s.lastBlock).filter((b): b is string => b !== null);
  return {
    ...all[0],
    ok: all.every((s) => s.ok),
    lastBlock: blocks.length ? blocks.reduce((m, b) => (BigInt(b) > BigInt(m) ? b : m)) : null,
    lastSettle: latest(all.map((s) => s.lastSettle)),
    lastOraclePush: latest(all.map((s) => s.lastOraclePush)),
    lastPegCheck: latest(all.map((s) => s.lastPegCheck)),
    lastError: all.map((s, i) => (s.lastError ? `${cranks[i].d.tokens[0].underlying}: ${s.lastError}` : null)).find(Boolean) ?? null,
  };
};
const app = Fastify();
for (const path of ["/status", "/health"])
  app.get(path, async () => validators.CrankStatusResponse.assert(status()));
await app.listen({
  port: Number(process.env.CRANK_HEALTH_PORT),
  host: process.env.CRANK_HEALTH_HOST ?? "127.0.0.1",
});
let stopped = false,
  timer: ReturnType<typeof setTimeout>;
async function loop() {
  for (const crank of cranks) await crank.tick();
  const attempt = Math.max(...cranks.map((c) => c.attempt));
  if (!stopped)
    timer = setTimeout(loop, attempt ? retryDelay(attempt) : Number(process.env.CRANK_POLL_MS ?? 1000));
}
void loop();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    stopped = true;
    clearTimeout(timer);
    await app.close();
  });
