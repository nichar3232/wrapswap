// /demo/send: the Sui confidential path (Unison Pay).
//   1. deposit  — the relay's EVM key deposits the source wrapper into ShareVault on Unichain, credited to Sui identity A
//   2. pay      — once the keeper credits A, A sends a Seal-encrypted `pay` instruction to identity B on Sui
//   3. withdraw — once B holds the shares, B submits a sealed `withdraw` into the OTHER issuer's wrapper for the EVM
//                 recipient; the keeper settles it on Unichain through WrapSwapRouter + ParityHook (WithdrawalSettled)
// A and B are dedicated relay identities (keys in ~/wrapswap-run/env/demo-relay-sui.env, never the pool operator). One
// send runs at a time; the POST returns after the deposit with its real tx hash, and GET /demo/send/:id follows the
// Sui and settlement hashes. The live sui-keeper (scripts/dev/live-up) does the crediting and settlement.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeEventLog, getAddress, type Hex } from "viem";
import { loadDeployment } from "../crank/sui/config.js";
import { execute, sealClient, sessionKeyFor, suiClient, suiscan, walrusGet, walrusPut } from "../crank/sui/lib.js";
import { readPool } from "../crank/sui/chain.js";
import { prepareInstruction, readOwnBalance } from "../crank/sui/payer.js";
import { decodeJson, normalizeSuiAddress, type Instruction, type Manifest } from "../crank/sui/protocol.js";
import { shareVaultAbi } from "../crank/sui/evm.js";

type Step = { step: string; at: string; chain: "unichain" | "sui"; tx: string; url: string; detail?: Record<string, string> };
export type SuiSendJob = {
  id: string; status: "deposited" | "credited" | "paid" | "withdraw-submitted" | "settled" | "skipped" | "failed";
  asset: string; from: string; to: string; amountIn: string; shares: string; recipient: Hex; depositTx: Hex;
  steps: Step[]; error?: string; settledAmountOut?: string;
};

const envDir = resolve(homedir(), "wrapswap-run/env");
const PIPS = 1_000_000n, MARGIN = 10n ** 13n, MAX_FEE_BPS = 60n; // keeper reservation rule (services/crank/sui/keeper.ts)
const keyFile = resolve(process.env.RELAY_SUI_KEY_FILE ?? `${envDir}/demo-relay-sui.env`);
if (!keyFile.startsWith(envDir + "/")) throw Error("RELAY_SUI_KEY_FILE must be under ~/wrapswap-run/env/");

export function suiSender(opts: {
  evmClient: any;
  send: (request: any) => Promise<Hex>; // the relay's serial EVM sender (approve / deposit)
  ensureAllowance: (token: Hex, spender: Hex, amount: bigint) => Promise<Hex | null>;
  fail: (status: number, code: string, message: string) => Error;
}) {
  const dep: any = loadDeployment();
  if (!dep.evm?.shareVault) throw Error("deployments/sui-testnet.json has no evm.shareVault");
  const text = readFileSync(keyFile, "utf8");
  const kp = (name: string) => {
    const k = new RegExp(`^${name}=(suiprivkey\\w+)$`, "m").exec(text)?.[1];
    if (!k) throw Error(`no ${name} in ${keyFile}`);
    return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(k).secretKey);
  };
  const A = kp("DEMO_RELAY_SUI_A"), B = kp("DEMO_RELAY_SUI_B");
  const addrA = normalizeSuiAddress(A.toSuiAddress()), addrB = normalizeSuiAddress(B.toSuiAddress());
  const client = suiClient(), seal = sealClient(client);
  const vault = getAddress(dep.evm.shareVault) as Hex;
  const uniscan = (tx: string) => `${dep.evm.explorer}/tx/${tx}`;
  const jobs = new Map<string, SuiSendJob>();
  let running: SuiSendJob | null = null;

  const tokens: { symbol: string; address: Hex; decimals: number }[] = dep.evm.tokens;
  const tokenOf = (name: unknown) => {
    const n = String(name).toLowerCase();
    const t = tokens.find((x) => x.symbol.toLowerCase() === n || (n === "coinbase" && x.symbol.startsWith("mcb")) || (n === "xstocks" && x.symbol.endsWith("x")));
    if (!t) throw opts.fail(400, "BAD_REQUEST", `ShareVault holds ${tokens.map((x) => x.symbol).join(", ")}: unknown wrapper`);
    return t;
  };
  const balanceOf = async (who: Ed25519Keypair) => {
    const pool = await readPool(client, dep.sui.poolId);
    const manifest = decodeJson<Manifest>(await walrusGet(pool.manifestBlob));
    const sessionKey = await sessionKeyFor(client, who, dep.sui.packageId);
    const v = await readOwnBalance({ client, seal, sessionKey, packageId: dep.sui.packageId, poolId: dep.sui.poolId,
      owner: who.toSuiAddress(), manifest, onchainRoot: pool.entriesRoot });
    return v.present ? v.balance : 0n;
  };
  const submit = async (who: Ed25519Keypair, instruction: Instruction) => {
    const pool = await readPool(client, dep.sui.poolId);
    const p = await prepareInstruction({ seal, packageId: dep.sui.packageId, poolId: dep.sui.poolId, batchId: pool.currentBatch, instruction, walrusPut });
    const t = await execute(client, who, p.tx);
    return { digest: t.digest as string, commitment: p.commitment as Hex };
  };
  const waitFor = async (what: string, test: () => Promise<boolean>, timeoutMs = 8 * 60_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await test()) return;
      } catch {
        /* transient Sui / Walrus / Seal read: retry */
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw Error(`timed out waiting for ${what}`);
  };
  const nonce = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const push = (job: SuiSendJob, s: Omit<Step, "at">) => job.steps.push({ at: new Date().toISOString(), ...s });

  async function follow(job: SuiSendJob, shares: bigint, balA0: bigint, balB0: bigint, target: Hex, fromBlock: bigint) {
    try {
      await waitFor("keeper credit to A", async () => (await balanceOf(A)) >= balA0 + shares);
      job.status = "credited";
      const pay = await submit(A, { v: 1, kind: "pay", to: addrB, shares: shares.toString(), memo: `demo ${job.id}`, nonce: nonce() });
      push(job, { step: "sealed pay A → B", chain: "sui", tx: pay.digest, url: suiscan("tx", pay.digest), detail: { commitment: pay.commitment } });
      job.status = "paid";
      await waitFor("private payment to B", async () => (await balanceOf(B)) >= balB0 + shares);
      // The keeper escrows ceil(shares * 1e6 / (1e6 - maxFeeBps*100)) + 1e13 for the fee: withdraw the most B's whole
      // balance covers (this also sweeps any shares an earlier, rejected withdrawal left with B). 60 bps is above the
      // final model's worst case today (2 bps base + 50 bps skew cap), so the settlement is not skipped on fee.
      const available = await balanceOf(B);
      const withdrawShares = ((available - MARGIN - 1n) * (PIPS - MAX_FEE_BPS * 100n)) / PIPS;
      const w = await submit(B, { v: 1, kind: "withdraw", recipient: job.recipient, target, shares: withdrawShares.toString(), maxFeeBps: Number(MAX_FEE_BPS), nonce: nonce() });
      push(job, { step: `sealed withdraw into ${job.to}`, chain: "sui", tx: w.digest, url: suiscan("tx", w.digest),
        detail: { commitment: w.commitment, shares: withdrawShares.toString(), maxFeeBps: MAX_FEE_BPS.toString() } });
      job.status = "withdraw-submitted";
      // The keeper settles on Unichain: WithdrawalSettled (or WithdrawalSkipped) carries the instruction commitment.
      await waitFor("settlement on Unichain", async () => {
        const logs = await opts.evmClient.getLogs({ address: vault, fromBlock, toBlock: "latest" });
        for (const l of logs) {
          let e: any;
          try {
            e = decodeEventLog({ abi: shareVaultAbi, data: l.data, topics: l.topics });
          } catch {
            continue;
          }
          if (e.args?.commitment?.toLowerCase() !== w.commitment.toLowerCase()) continue;
          if (e.eventName === "WithdrawalSettled") {
            job.status = "settled";
            job.settledAmountOut = e.args.amountOut.toString();
            push(job, { step: `settled: ${job.to} delivered to ${job.recipient}`, chain: "unichain", tx: l.transactionHash, url: uniscan(l.transactionHash),
              detail: { amountOut: e.args.amountOut.toString(), sharesDebited: e.args.sharesDebited.toString() } });
            return true;
          }
          if (e.eventName === "WithdrawalSkipped") {
            job.status = "skipped";
            push(job, { step: "withdrawal skipped (credit restored on Sui)", chain: "unichain", tx: l.transactionHash, url: uniscan(l.transactionHash) });
            return true;
          }
        }
        return false;
      }, 10 * 60_000);
    } catch (e) {
      job.status = "failed";
      job.error = String((e as Error).message ?? e).split("\n")[0].slice(0, 200);
    } finally {
      running = null;
      console.log(JSON.stringify({ event: "relay_sui_send", id: job.id, status: job.status, steps: job.steps.map((s) => s.tx) }));
    }
  }

  return {
    busy: () => running,
    get: (id: string) => jobs.get(id),
    identities: { A: addrA, B: addrB, vault },
    /** Validate and deposit now (returns with the deposit tx); the Sui legs continue in the background. */
    async start(body: any, amountOf: (w: { decimals: number; multiplier: string }, amount: unknown) => { raw: bigint; shares: bigint }, multiplierOf: (token: Hex) => string) {
      if (String(body.asset ?? "").toUpperCase() !== "AAPL") throw opts.fail(400, "BAD_REQUEST", "Unison Pay (ShareVault) holds AAPL wrappers only");
      const from = tokenOf(body.from), to = tokenOf(body.to);
      if (from.address.toLowerCase() === to.address.toLowerCase()) throw opts.fail(400, "BAD_REQUEST", "withdraw into the other issuer: from and to must differ");
      const recipient = getAddress(String(body.recipient ?? "")) as Hex;
      const { raw } = amountOf({ decimals: from.decimals, multiplier: multiplierOf(from.address) }, body.amount);
      if (running) throw opts.fail(409, "BUSY", `a Sui send is in progress (${running.id}, ${running.status}); retry in a few minutes`);
      const id = `send-${Date.now().toString(36)}`;
      const job: SuiSendJob = { id, status: "deposited", asset: "AAPL", from: from.symbol, to: to.symbol, amountIn: raw.toString(), shares: "0",
        recipient, depositTx: "0x" as Hex, steps: [] };
      running = job;
      try {
        const [balA0, balB0] = await Promise.all([balanceOf(A), balanceOf(B)]);
        const fromBlock = await opts.evmClient.getBlockNumber();
        await opts.ensureAllowance(from.address, vault, raw);
        const tag = `0x${addrA.replace(/^0x/, "").padStart(64, "0")}` as Hex;
        const depositTx = await opts.send({ address: vault, abi: shareVaultAbi, functionName: "deposit", args: [from.address, raw, tag] });
        const receipt = await opts.evmClient.getTransactionReceipt({ hash: depositTx });
        const deposited = receipt.logs
          .map((l: any) => { try { return decodeEventLog({ abi: shareVaultAbi, data: l.data, topics: l.topics }); } catch { return null; } })
          .find((e: any) => e?.eventName === "Deposited") as any;
        const shares = BigInt(deposited.args.shares);
        Object.assign(job, { depositTx, shares: shares.toString() });
        push(job, { step: `deposit ${from.symbol} into ShareVault (credit to Sui ${addrA.slice(0, 10)}…)`, chain: "unichain", tx: depositTx, url: uniscan(depositTx) });
        jobs.set(id, job);
        void follow(job, shares, balA0, balB0, to.address, fromBlock);
        return job;
      } catch (e) {
        running = null;
        throw e;
      }
    },
  };
}
