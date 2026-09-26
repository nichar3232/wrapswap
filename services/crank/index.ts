import "dotenv/config";
import Fastify from "fastify";
import { createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { validators } from "@wrapswap/types";
import {
  loadDeployment,
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
const crank = new Crank(
  d,
  publicClient,
  createWalletClient({ account, transport: http(rpc) }),
  account,
  mode,
);
const app = Fastify();
for (const path of ["/status", "/health"])
  app.get(path, async () =>
    validators.CrankStatusResponse.assert(crank.status),
  );
await app.listen({
  port: Number(process.env.CRANK_HEALTH_PORT),
  host: process.env.CRANK_HEALTH_HOST ?? "127.0.0.1",
});
let stopped = false,
  timer: ReturnType<typeof setTimeout>;
async function loop() {
  await crank.tick();
  if (!stopped)
    timer = setTimeout(
      loop,
      crank.attempt
        ? retryDelay(crank.attempt)
        : Number(process.env.CRANK_POLL_MS ?? 1000),
    );
}
void loop();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    stopped = true;
    clearTimeout(timer);
    await app.close();
  });
