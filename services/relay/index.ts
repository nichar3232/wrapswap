// Demo relay: lets a visitor without a wallet trigger real Unichain Sepolia transactions, signed by a dedicated
// demo key (never the deployer or crank key).
//   POST /demo/convert      {asset, from, to, amount}             → WrapSwapRouter.swapExactIn to the relay itself
//   POST /demo/send-unichain {asset, from, to, amount, recipient} → the same swap delivering to `recipient` (Unichain only)
//   POST /demo/send         the Sui path (ShareVault deposit → confidential pay on Sui → withdraw to the other issuer)
//   POST /demo/dark-commit  {asset, from, amount}                 → escrow + commit on the asset's DarkCrossHook;
//                                                                   the relay reveals it in the reveal phase and the
//                                                                   crank settles (crossed, or residual via ParityHook)
//   GET  /demo/status       relay address, balances, pending reveals, recent actions (tx hashes)
// `from`/`to` are wrapper symbols or platform names; `amount` is whole tokens as a decimal string. Every action is
// capped at 100 canonical shares and each client IP gets 3 actions per 10 minutes. The key is read from a file under
// ~/wrapswap-run/env/ only (RELAY_KEY_FILE), never from the environment the stack shares, and is never logged.
import "dotenv/config";
import Fastify from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createWalletClient, http, parseUnits, getAddress, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { abis, canonical, encodeParityHookData } from "@wrapswap/types";
import { loadDeployment, publicClient, rpc } from "../../api/src/chain/client.js";
import { suiSender } from "./sui-send.js";

const d = loadDeployment();
const envDir = resolve(homedir(), "wrapswap-run/env");
const keyFile = resolve(process.env.RELAY_KEY_FILE ?? `${envDir}/demo-relay.env`);
if (!keyFile.startsWith(envDir + "/")) throw Error("RELAY_KEY_FILE must be under ~/wrapswap-run/env/");
const pk = /^DEMO_RELAY_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m.exec(readFileSync(keyFile, "utf8"))?.[1] as Hex | undefined;
if (!pk) throw Error(`no DEMO_RELAY_PRIVATE_KEY in ${keyFile}`);
const account = privateKeyToAccount(pk);
const signerKeys = [process.env.CRANK_PK, process.env.CRANK_PRIVATE_KEY, process.env.DEPLOYER_PRIVATE_KEY]
  .filter(Boolean)
  .map((k) => privateKeyToAccount(k as Hex).address);
if (signerKeys.includes(account.address)) throw Error("the demo relay key must not be the deployer or crank key");
const wallet = createWalletClient({ account, transport: http(rpc) });
const client = publicClient;

const MAX_SHARES = 100n * canonical.ONE;
const WINDOW_MS = 10 * 60_000, ACTIONS = 3, MCP_ACTIONS = 20;
// The Unison MCP server (on this machine) calls the relay for all its remote users from one IP, so it gets its own
// budget: it sends `x-unison-relay-client: <MCP_RELAY_TOKEN>` from ~/wrapswap-run/env/relay-internal.env.
const tokenFile = resolve(process.env.RELAY_INTERNAL_FILE ?? `${envDir}/relay-internal.env`);
if (!tokenFile.startsWith(envDir + "/")) throw Error("RELAY_INTERNAL_FILE must be under ~/wrapswap-run/env/");
const mcpToken = existsSync(tokenFile)
  ? Buffer.from(/^MCP_RELAY_TOKEN=([0-9a-f]{64})$/m.exec(readFileSync(tokenFile, "utf8"))?.[1] ?? "", "utf8")
  : Buffer.alloc(0);
const isMcp = (req: any) => {
  const h = Buffer.from(String(req.headers["x-unison-relay-client"] ?? ""), "utf8");
  return mcpToken.length === 64 && h.length === mcpToken.length && timingSafeEqual(h, mcpToken);
};
const router = (d.router ?? d.contracts.wrapSwapRouter) as Hex;
const erc20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const oracleAbi = [{ type: "function", name: "getMid", stateMutability: "view", inputs: [{ name: "b", type: "address" }, { name: "q", type: "address" }], outputs: [{ type: "uint256" }, { type: "uint64" }] }] as const;

type Asset = NonNullable<typeof d.assets>[number];
const assets: Asset[] = d.assets ?? [];
const fail = (status: number, code: string, message: string) => Object.assign(Error(message), { statusCode: status, code });
const assetOf = (symbol: unknown) => {
  const a = assets.find((x) => x.symbol.toLowerCase() === String(symbol).toLowerCase());
  if (!a) throw fail(400, "BAD_REQUEST", "unknown asset");
  return a;
};
const wrapperOf = (a: Asset, name: unknown) => {
  const w = a.wrappers.find((x) => [x.symbol, x.platform].some((n) => n.toLowerCase() === String(name).toLowerCase()));
  if (!w) throw fail(400, "BAD_REQUEST", "unknown wrapper for asset");
  return w;
};
// Whole tokens as a decimal string → raw units, capped at 100 canonical shares.
const rawAmount = (w: Asset["wrappers"][number], amount: unknown) => {
  if (typeof amount !== "string" || !/^\d{1,6}(\.\d{1,18})?$/.test(amount)) throw fail(400, "BAD_REQUEST", "amount: decimal string of whole tokens");
  const raw = parseUnits(amount, w.decimals);
  const shares = canonical.toSharesDown(raw, BigInt(w.multiplier), w.decimals);
  if (raw <= 0n) throw fail(400, "BAD_REQUEST", "amount must be positive");
  if (shares > MAX_SHARES) throw fail(400, "OVER_LIMIT", "max 100 shares per action");
  return { raw, shares };
};

// Per-IP sliding window. Behind the web server / Tailscale Funnel the client IP is X-Forwarded-For (loopback peer only).
const hits = new Map<string, number[]>();
const clientIp = (req: any) => {
  const peer = req.socket.remoteAddress ?? "";
  const fwd = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(peer) && req.headers["x-forwarded-for"];
  return fwd ? String(fwd).split(",")[0].trim() : peer;
};
// Budgets: one shared "mcp" bucket (20 / 10 min) for the MCP server, else 3 / 10 min per client IP.
const takeAction = (req: any) => {
  const mcp = isMcp(req),
    key = mcp ? "mcp" : `ip:${clientIp(req)}`,
    max = mcp ? MCP_ACTIONS : ACTIONS;
  const now = Date.now(),
    recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max)
    throw Object.assign(fail(429, "RATE_LIMITED", `${max} demo actions per 10 minutes${mcp ? " (MCP budget)" : ""}`), {
      retryAfter: Math.ceil((recent[0] + WINDOW_MS - now) / 1000),
    });
  recent.push(now);
  hits.set(key, recent);
  return mcp;
};

// One signer: transactions go out one at a time. Nonce = max(latest, pending, last used + 1): the public RPC's
// backends lag each other. A send is retried while the estimate hits a backend that has not seen the previous tx.
let chain = Promise.resolve();
let used = -1;
const serial = <T>(f: () => Promise<T>) => {
  const run = chain.then(f, f);
  chain = run.then(() => undefined, () => undefined);
  return run;
};
async function send(request: any): Promise<Hex> {
  for (let attempt = 0; ; attempt++) {
    const [latest, pending] = await Promise.all((["latest", "pending"] as const).map((blockTag) => client.getTransactionCount({ address: account.address, blockTag })));
    const nonce = Math.max(latest, pending, used + 1);
    try {
      const hash = await wallet.writeContract({ ...request, chain: null, nonce });
      used = nonce;
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw fail(502, "REVERTED", `transaction reverted: ${hash}`);
      return hash;
    } catch (e: any) {
      if (e.code === "REVERTED" || attempt >= 5) throw e.code ? e : fail(502, "CHAIN", String(e.shortMessage ?? e.message).split("\n")[0]);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
const ensureAllowance = async (token: Hex, spender: Hex, amount: bigint) => {
  const allowance = await client.readContract({ address: token, abi: erc20, functionName: "allowance", args: [account.address, spender] });
  return allowance >= amount ? null : send({ address: token, abi: erc20, functionName: "approve", args: [spender, 2n ** 255n] });
};

const recent: any[] = [];
const record = (entry: any) => {
  recent.unshift({ at: new Date().toISOString(), ...entry });
  recent.length = Math.min(recent.length, 20);
  console.log(JSON.stringify({ event: "relay", action: entry.action, asset: entry.asset, txHash: entry.txHash }));
};

async function convert(body: any, recipient: Hex) {
  const a = assetOf(body.asset),
    from = wrapperOf(a, body.from),
    to = wrapperOf(a, body.to);
  if (from.token === to.token) throw fail(400, "BAD_REQUEST", "from and to must differ");
  const { raw, shares } = rawAmount(from, body.amount);
  const key = a.pool.key,
    zeroForOne = from.token.toLowerCase() === key.currency0.toLowerCase();
  const q: any = await client.readContract({ address: a.parityHook as Hex, abi: abis.IParityHook, functionName: "quote", args: [key, zeroForOne, -raw] } as any);
  const block = await client.getBlock();
  const approveTx = await ensureAllowance(from.token as Hex, router, raw);
  const txHash = await send({
    address: router,
    abi: abis.IWrapSwapRouter,
    functionName: "swapExactIn",
    args: [{ key, zeroForOne, amountIn: raw, amountOutMin: (BigInt(q.amountOut) * 995n) / 1000n, recipient, deadline: block.timestamp + 600n,
      hookData: encodeParityHookData({ swapper: account.address }) }],
  });
  return { asset: a.symbol, from: from.symbol, to: to.symbol, amountIn: raw.toString(), sharesIn: shares.toString(),
    quotedOut: String(q.amountOut), feeBps: canonical.pipsToBps(q.fee.totalPips), recipient, approveTx, txHash };
}

// Dark commits waiting for their reveal phase (in memory; a restart before reveal forfeits per the hook's rules).
const pending: { asset: string; hook: Hex; batchId: bigint; sellBase: boolean; amountIn: bigint; limit: bigint; salt: Hex; revealTx?: Hex }[] = [];
async function darkCommit(body: any) {
  const a = assetOf(body.asset);
  if (!a.darkCrossHook) throw fail(400, "BAD_REQUEST", "no Dark Cross for this asset");
  const hook = a.darkCrossHook as Hex,
    from = wrapperOf(a, body.from);
  const sellBase = from.token.toLowerCase() === a.darkBaseToken!.toLowerCase();
  const { raw, shares } = rawAmount(from, body.amount);
  const [mid] = await client.readContract({ address: d.contracts.oracle as Hex, abi: oracleAbi, functionName: "getMid", args: [a.darkBaseToken as Hex, a.darkQuoteToken as Hex] });
  // Limit 0.2% through the mid: a seller of base accepts at least mid×0.998, a seller of quote pays at most mid×1.002.
  const limit = sellBase ? (mid * 998n) / 1000n : (mid * 1002n) / 1000n;
  const [available] = (await client.readContract({ address: hook, abi: abis.IDarkCrossHook, functionName: "balances", args: [account.address, from.token] } as any)) as [bigint, bigint];
  let fundTx: Hex | null = null;
  if (available < raw) {
    await ensureAllowance(from.token as Hex, hook, raw - available);
    fundTx = await send({ address: hook, abi: abis.IDarkCrossHook, functionName: "fund", args: [from.token, raw - available] });
  }
  // Commit early enough in the phase that the commit lands inside it.
  let batchId = 0n;
  for (let i = 0; i < 120; i++) {
    const [id, phase, ends] = (await client.readContract({ address: hook, abi: abis.IDarkCrossHook, functionName: "currentBatch" } as any)) as [bigint, number, bigint];
    const head = await client.getBlockNumber();
    if (phase === 0 && ends - head >= 5n) { batchId = id; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!batchId) throw fail(503, "NO_COMMIT_WINDOW", "no commit window opened");
  const salt = keccak256(toHex(`${Date.now()}:${Math.random()}`));
  const commitHash = await client.readContract({ address: hook, abi: abis.IDarkCrossHook, functionName: "commitHashOf",
    args: [batchId, account.address, sellBase, raw, limit, account.address, salt] } as any);
  const txHash = await send({ address: hook, abi: abis.IDarkCrossHook, functionName: "commit", args: [commitHash, from.token, raw, `0x${"0".repeat(64)}`] });
  pending.push({ asset: a.symbol, hook, batchId, sellBase, amountIn: raw, limit, salt });
  return { asset: a.symbol, batchId: batchId.toString(), side: sellBase ? "sellBase" : "sellQuote", amountIn: raw.toString(), sharesIn: shares.toString(),
    limitPriceX18: limit.toString(), fundTx, txHash, reveal: "automatic in the reveal phase; the crank settles the batch" };
}
// Reveal loop: each pending commit is revealed once its batch reaches REVEAL.
setInterval(() => {
  void serial(async () => {
    for (const p of pending.filter((x) => !x.revealTx)) {
      try {
        const [id, phase] = (await client.readContract({ address: p.hook, abi: abis.IDarkCrossHook, functionName: "currentBatch" } as any)) as [bigint, number, bigint];
        if (id === p.batchId && phase === 1) {
          p.revealTx = await send({ address: p.hook, abi: abis.IDarkCrossHook, functionName: "reveal", args: [p.sellBase, p.amountIn, p.limit, account.address, p.salt] });
          record({ action: "dark-reveal", asset: p.asset, batchId: p.batchId.toString(), txHash: p.revealTx });
        } else if (id > p.batchId) p.revealTx = "0x" as Hex; // missed: the hook forfeits per FORFEIT_BPS
      } catch (e) {
        console.log(JSON.stringify({ event: "relay_reveal_error", asset: p.asset, batchId: p.batchId.toString(), message: String((e as any).code ?? "error") }));
      }
    }
  });
}, 1000).unref();

const app = Fastify({ logger: false, bodyLimit: 4096 });
app.setErrorHandler((e: any, _req, reply) => {
  if (e.retryAfter) reply.header("retry-after", String(e.retryAfter));
  reply.status(e.statusCode ?? 500).send({
    error: { code: e.code ?? "INTERNAL", message: e.statusCode ? e.message : "relay error" },
    ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
  });
});
const action = (name: string, run: (body: any) => Promise<any>) =>
  app.post(`/demo/${name}`, async (req) => {
    const body = (req.body ?? {}) as any;

    // Validate before spending the IP's allowance, then queue behind the relay's other transactions.
    if (name === "send-unichain") getAddress(String(body.recipient ?? "")); // throws on a bad address
    if (name !== "dark-commit") rawAmount(wrapperOf(assetOf(body.asset), body.from), body.amount);
    const viaMcp = takeAction(req.raw);
    const result = await serial(() => run(body));
    record({ action: name, asset: result.asset, txHash: result.txHash, batchId: result.batchId, client: viaMcp ? "mcp" : "web" });
    return result;
  });
action("convert", (b) => convert(b, account.address));
action("send-unichain", (b) => convert(b, getAddress(String(b.recipient))));
// /demo/send: the Sui confidential path (ShareVault deposit → sealed pay on Sui → withdraw into the other issuer).
const sui = suiSender({ evmClient: client, send: (r) => serial(() => send(r)), ensureAllowance: (t, s, a) => serial(() => ensureAllowance(t, s, a)), fail });
const aapl = () => assetOf("AAPL");
app.post("/demo/send", async (req) => {
  const body = (req.body ?? {}) as any;
  // Validate (asset, wrappers, recipient, 100-share cap) and check the one-at-a-time queue before spending budget.
  if (String(body.asset ?? "").toUpperCase() !== "AAPL") throw fail(400, "BAD_REQUEST", "Unison Pay (ShareVault) holds AAPL wrappers only");
  getAddress(String(body.recipient ?? ""));
  rawAmount(wrapperOf(aapl(), body.from), body.amount);
  const busy = sui.busy();
  if (busy) throw fail(409, "BUSY", `a Sui send is in progress (${busy.id}, ${busy.status}); retry in a few minutes`);
  const viaMcp = takeAction(req.raw);
  const job = await sui.start(body, (w, amount) => rawAmount(w as any, amount), (token) =>
    aapl().wrappers.find((w) => w.token.toLowerCase() === token.toLowerCase())!.multiplier);
  record({ action: "send", asset: "AAPL", txHash: job.depositTx, client: viaMcp ? "mcp" : "web" });
  return { ...job, txHash: job.depositTx, path: "sui-confidential", track: `/demo/send/${job.id}` };
});
app.get("/demo/send/:id", async (req) => {
  const job = sui.get((req.params as any).id);
  if (!job) throw fail(404, "NOT_FOUND", "unknown send id");
  return { ...job, path: "sui-confidential" };
});
action("dark-commit", darkCommit);
app.get("/demo/status", async () => {
  const eth = await client.getBalance({ address: account.address });
  const tokens = await Promise.all(assets.flatMap((a) => a.wrappers.map(async (w) => ({ asset: a.symbol, symbol: w.symbol,
    balance: String(await client.readContract({ address: w.token as Hex, abi: erc20, functionName: "balanceOf", args: [account.address] })) }))));
  return { ok: eth > 0n, address: account.address, ethWei: eth.toString(), tokens, sui: { ...sui.identities, busy: sui.busy()?.id ?? null },
    limits: { actionsPer10Min: ACTIONS, mcpActionsPer10Min: MCP_ACTIONS, mcpBudgetConfigured: mcpToken.length === 64, maxShares: "100" },
    pendingReveals: pending.filter((p) => !p.revealTx).map((p) => ({ asset: p.asset, batchId: p.batchId.toString() })), recent };
});
await app.listen({ port: Number(process.env.RELAY_PORT ?? 18210), host: "127.0.0.1" });
console.log(JSON.stringify({ event: "relay_listening", address: account.address, port: Number(process.env.RELAY_PORT ?? 18210) }));
