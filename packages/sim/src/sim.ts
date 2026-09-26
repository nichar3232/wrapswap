// Phase 2: market simulation on the Unichain Sepolia fork. Only the outside-venue prices are modeled (a geometric
// random walk per wrapper + scheduled 40 bps gaps at t=0 and at the midpoint, seed 42); every Convert and Dark Cross
// order below is a real transaction against the deployed contracts, and every fee is the one the contracts charged.
// Usage (repo root): pnpm exec tsx packages/sim/src/sim.ts [--ticks 240] [--no-llm]
//   → sim/run-<timestamp>.json (per-tick record) + web/public/sim/run.json (replay copy)
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { keccak256, toHex, getAddress, type Address, type Hex } from "viem";
import {
  abi, agentAddress, assets, call, events, impersonateDeployer, inventoryShares, mine, mintTo, pub, pushParityMid, read, rpc, send,
  setBalance, sharesToRaw, toSharesDown, ONE, ROOT, PARITY_HOOK, PROTOCOL_FEE_RECIPIENT, DEPLOYER, type Asset, type Wrapper,
} from "./chain.js";
import { approveOnce, convert, quoteConvert } from "./trade.js";
import { claudeMcpConfig, ipProxy } from "./mcp.js";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const TICKS = Number(arg("--ticks", "240"));
const MID = Math.floor(TICKS / 2);
const MIN_TRADES = Number(arg("--min-trades", "1500"));
const SEED = 42;
const LLM = !argv.includes("--no-llm") && /READY FOR MERGE\s*$/.test(safeRead(`${process.env.HOME}/wrapswap-run/status/mcp.md`));
function safeRead(p: string) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- deterministic RNG (mulberry32 + Box–Muller)
let s = SEED >>> 0;
const rand = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const uniform = (a: number, b: number) => a + (b - a) * rand();
const int = (a: number, b: number) => Math.floor(uniform(a, b + 1));

// ---------------------------------------------------------------- external price process (the only modeled part)
const MODEL = {
  driftBpsPerTick: 0.15, // shared drift of the underlying
  commonVolBps: 6, // shared shock (the stock itself moves; both wrappers move with it)
  idioVolBps: 2.6, // wrapper-specific noise: what opens gaps between venues
  impactBpsPerShare: 0.006, // an arb's outside-venue buy+sell closes the gap by this much per share converted
  shockBps: 40,
  // Arbs see a price from `latency` ticks ago and act with this probability per tick.
  arbActivity: 0.3,
  regularActivity: 0.12,
};
type Ext = { a: number; b: number }; // outside price per canonical share of wrapper[0] / wrapper[1]
const ext: Ext[] = assets.map(() => ({ a: 100, b: 100 }));
const gapBps = (e: Ext) => ((e.b - e.a) / e.a) * 1e4; // > 0: wrapper[1] is the expensive one
const history: number[][] = assets.map(() => []);
function openGap(i: number, bps: number) {
  const m = Math.sqrt(ext[i].a * ext[i].b);
  ext[i].a = m / Math.sqrt(1 + bps / 1e4);
  ext[i].b = m * Math.sqrt(1 + bps / 1e4);
}
function step(i: number) {
  const c = MODEL.driftBpsPerTick / 1e4 + (MODEL.commonVolBps / 1e4) * normal();
  ext[i].a *= Math.exp(c + (MODEL.idioVolBps / 1e4) * normal());
  ext[i].b *= Math.exp(c + (MODEL.idioVolBps / 1e4) * normal());
}
/// Arb buys the cheap wrapper and sells the expensive one outside: both legs move toward each other.
function impact(i: number, shares: number, cheapIsA: boolean) {
  const f = (MODEL.impactBpsPerShare * shares) / 2 / 1e4;
  if (cheapIsA) (ext[i].a *= 1 + f), (ext[i].b *= 1 - f);
  else (ext[i].b *= 1 + f), (ext[i].a *= 1 - f);
}

// ---------------------------------------------------------------- agents
type Arb = { kind: "arb"; name: string; addr: Address; asset: number; thresholdBps: number; size: number; latency: number };
type Regular = { kind: "regular"; name: string; addr: Address; maxSize: number };
type Whale = { kind: "whale"; name: string; addr: Address; asset: number; sellBase: boolean; ticks: number[]; sizes: number[] };
const arbs: Arb[] = Array.from({ length: 50 }, (_, k) => ({
  kind: "arb", name: `arb-${k}`, addr: agentAddress(`arb-${k}`), asset: k % 3, thresholdBps: Math.round(uniform(5, 25) * 10) / 10, size: int(10, 500), latency: int(0, 3),
}));
const regulars: Regular[] = Array.from({ length: 24 }, (_, k) => ({ kind: "regular", name: `user-${k}`, addr: agentAddress(`user-${k}`), maxSize: int(5, 40) }));
const whales: Whale[] = [];
for (let p = 0; p < 3; p++)
  for (const sellBase of [true, false]) {
    const ticks = [0, 1, 2].map((r) => 15 + p * 11 + r * Math.floor(TICKS / 3.2));
    whales.push({ kind: "whale", name: `whale-${assets[p].symbol}-${sellBase ? "sell" : "buy"}`, addr: agentAddress(`whale-${p}-${sellBase}`), asset: p, sellBase, ticks, sizes: ticks.map(() => int(1000, 5000)) });
  }
const PERSONAS = [
  "a cautious retail holder of Coinbase-wrapped shares who only converts when the quoted fee is under 5 bps",
  "a treasury bot rebalancing between issuers; you prefer the direction get_pool calls cheap",
  "a curious first-time user who converts a small amount to see how it works",
  "a fee-sensitive market maker that only trades the cheap direction and sizes to 100 shares",
  "a long-term xStocks holder consolidating into one issuer; you check the quote before acting",
];
const LLM_TICKS = [0.18, 0.36, 0.58, 0.76, 0.9].map((f) => Math.floor(TICKS * f));

// ---------------------------------------------------------------- record
type TradeRec = { tick: number; agent: string; kind: string; asset: string; from: string; to: string; shares: number; baseFee: number; skewFee: number; skewPips: number; rebalancing: boolean; tx: Hex };
const run: any = {
  meta: {
    label: "Simulated external prices · real deployed contracts on a Unichain Sepolia fork",
    seed: SEED, ticks: TICKS, midpointTick: MID, model: MODEL, chainId: 1301,
    fork: "anvil --fork-url https://sepolia.unichain.org --chain-id 1301 --port 8555",
    startedAt: new Date().toISOString(),
    assets: assets.map((a) => ({ symbol: a.symbol, wrappers: a.wrappers.map((w) => ({ symbol: w.symbol, platform: w.platform })), poolId: a.poolId, darkCrossHook: a.dark })),
    contracts: { parityHook: PARITY_HOOK, protocolFeeRecipient: PROTOCOL_FEE_RECIPIENT },
    agents: { arbs: arbs.length, whales: whales.length, regulars: regulars.length, llm: LLM ? PERSONAS.length : "SKIPPED (mcp not READY)" },
    arbs: arbs.map(({ name, asset, thresholdBps, size, latency }) => ({ name, asset: assets[asset].symbol, thresholdBps, size, latency })),
  },
  ticks: [] as any[],
  trades: [] as TradeRec[],
  darkBatches: [] as any[],
  llm: [] as any[],
};
const cum = { lpFeeShares: assets.map(() => 0), protocolFeeShares: assets.map(() => 0), trades: { arb: 0, regular: 0, whale: 0, llm: 0 } };
const sh = (x: bigint) => Number(x) / 1e18;

// ---------------------------------------------------------------- setup
await impersonateDeployer();
console.error(`setup: ${arbs.length} arbs, ${regulars.length} regulars, ${whales.length} whales, LLM ${LLM ? "on" : "SKIPPED"}`);
const startBlock = await pub.getBlockNumber();
for (const ag of [...arbs, ...regulars]) {
  await setBalance(ag.addr, 10n ** 20n);
  for (const a of assets)
    for (const w of a.wrappers) {
      await mintTo(ag.addr, w, sharesToRaw(w, ag.kind === "arb" ? 25_000 : 2_000));
      await approveOnce(ag.addr, w.token, getAddress((await import("./chain.js")).ROUTER));
    }
}
for (const wh of whales) await setBalance(wh.addr, 10n ** 20n);
// LP book reset (keeper = deployer): every pool starts at exactly INVENTORY shares per side, whatever the fork's
// history, so a run is reproducible from any fork state.
const INVENTORY = 10_000;
run.meta.lpReset = [];
for (const a of assets)
  for (const w of a.wrappers) {
    const target = sharesToRaw(w, INVENTORY);
    const cur = await read<bigint>(PARITY_HOOK, abi.hook, "inventory", [w.token]);
    if (cur > target) await send(DEPLOYER, PARITY_HOOK, abi.hook, "withdrawInventory", [w.token, cur - target, DEPLOYER]);
    else if (cur < target) {
      await mintTo(DEPLOYER, w, target - cur);
      await approveOnce(DEPLOYER, w.token, PARITY_HOOK);
      await send(DEPLOYER, PARITY_HOOK, abi.hook, "depositInventory", [w.token, target - cur]);
    }
    run.meta.lpReset.push({ token: w.symbol, from: String(cur), to: String(target) });
  }
const inv0 = await Promise.all(assets.map(inventoryShares));
run.meta.setupBlocks = { from: String(startBlock), to: String(await pub.getBlockNumber()) };
run.meta.initialInventory = inv0.map(([x, y]) => [sh(x), sh(y)]);

const reverts: any[] = [];
async function doConvert(tick: number, agent: string, kind: string, i: number, from: Wrapper, to: Wrapper, shares: number, addr: Address) {
  const a = assets[i];
  let r;
  try {
    r = await convert(a, addr, from, sharesToRaw(from, shares));
  } catch (e: any) {
    reverts.push({ tick, agent, asset: a.symbol, from: from.symbol, shares, error: String(e.message).slice(0, 160) });
    console.error(`revert @${tick} ${agent} ${a.symbol} ${from.symbol} ${shares}: ${String(e.message).slice(0, 160)}`);
    return null;
  }
  const rec: TradeRec = {
    tick, agent, kind, asset: a.symbol, from: from.symbol, to: to.symbol, shares,
    baseFee: sh(r.converted.baseFee), skewFee: sh(r.converted.skewFee), skewPips: r.quote.fee.skewPips, rebalancing: r.quote.fee.reducesImbalance, tx: r.txHash,
  };
  cum.lpFeeShares[i] += rec.baseFee + rec.skewFee;
  run.trades.push(rec);
  return rec;
}

// ---------------------------------------------------------------- Dark Cross: one full batch for a whale pair
async function darkBatch(tick: number, i: number, orders: { wh: Whale; shares: number }[]) {
  const a = assets[i];
  const base = a.wrappers.find((w) => w.token === a.base)!, quote = a.wrappers.find((w) => w.token === a.quote)!;
  for (const o of orders) {
    const w = o.wh.sellBase ? base : quote;
    const amt = sharesToRaw(w, o.shares);
    await mintTo(o.wh.addr, w, amt);
    await approveOnce(o.wh.addr, w.token, a.dark);
    await send(o.wh.addr, a.dark, abi.dark, "fund", [w.token, amt]);
  }
  const mid = await pushParityMid(a);
  let [batchId, phase, ends] = await read<[bigint, number, bigint]>(a.dark, abi.dark, "currentBatch");
  if (phase !== 0 || ends - (await pub.getBlockNumber()) < 4n) {
    const next = phase === 0 ? ends + 8n : phase === 1 ? ends + 2n : ends;
    await mine(Number(next - (await pub.getBlockNumber())));
    [batchId, phase, ends] = await read(a.dark, abi.dark, "currentBatch");
  }
  const salts = orders.map((o) => keccak256(toHex(`${o.wh.name}-${batchId}`)));
  const lim = (sellBase: boolean) => (sellBase ? (mid * 995n) / 1000n : (mid * 1005n) / 1000n);
  const txs: Hex[] = [];
  for (const [k, o] of orders.entries()) {
    const w = o.wh.sellBase ? base : quote;
    const amt = sharesToRaw(w, o.shares);
    const h = await read(a.dark, abi.dark, "commitHashOf", [batchId, o.wh.addr, o.wh.sellBase, amt, lim(o.wh.sellBase), o.wh.addr, salts[k]]);
    txs.push((await call(o.wh.addr, a.dark, abi.dark, "commit", [h, w.token, amt, "0x" + "0".repeat(64)])).transactionHash);
  }
  [, , ends] = await read(a.dark, abi.dark, "currentBatch");
  await mine(Number(ends - (await pub.getBlockNumber())));
  for (const [k, o] of orders.entries()) {
    const w = o.wh.sellBase ? base : quote;
    txs.push((await call(o.wh.addr, a.dark, abi.dark, "reveal", [o.wh.sellBase, sharesToRaw(w, o.shares), lim(o.wh.sellBase), o.wh.addr, salts[k]])).transactionHash);
  }
  [, , ends] = await read(a.dark, abi.dark, "currentBatch");
  await mine(Number(ends - (await pub.getBlockNumber())));
  await pushParityMid(a);
  const from = await pub.getBlockNumber();
  if (!(await read<boolean>(a.dark, abi.dark, "settled", [batchId]))) await call(DEPLOYER, a.dark, abi.dark, "settle", [batchId]);
  const ev = events(await pub.getLogs({ address: a.dark, fromBlock: from - 30n }), abi.dark).filter((e) => e.args.batchId === batchId);
  const crossed = ev.find((e) => e.eventName === "Crossed");
  const residual = ev.filter((e) => e.eventName === "ResidualFilled");
  const unfilled = ev.filter((e) => e.eventName === "Unfilled");
  const settledEv = ev.find((e) => e.eventName === "BatchSettled");
  const protocolFee = crossed ? sh(crossed.args.protocolFee) : 0;
  const lpFee = residual.reduce((x, r) => x + sh(r.args.baseFee + r.args.skewFee), 0);
  cum.protocolFeeShares[i] += protocolFee;
  cum.lpFeeShares[i] += lpFee;
  // Withdraw proceeds + refunds so whale escrow does not accumulate across rounds.
  for (const o of orders)
    for (const w of [base, quote]) {
      const [avail] = await read<[bigint, bigint]>(a.dark, abi.dark, "balances", [o.wh.addr, w.token]);
      if (avail > 0n) await send(o.wh.addr, a.dark, abi.dark, "withdraw", [w.token, avail]);
    }
  const rec = {
    tick, asset: a.symbol, batchId: String(batchId), orders: orders.map((o) => ({ whale: o.wh.name, side: o.wh.sellBase ? `sell ${base.symbol}` : `sell ${quote.symbol}`, shares: o.shares })),
    crossedShares: crossed ? sh(crossed.args.matchedShares) : 0, residualShares: residual.reduce((x, r) => x + sh(r.args.shares), 0), unfilledShares: unfilled.reduce((x, r) => x + sh(r.args.sharesRefunded), 0),
    protocolFeeShares: protocolFee, lpFeeShares: lpFee, settleTx: settledEv?.txHash, txs,
  };
  run.darkBatches.push(rec);
  cum.trades.whale += orders.length;
  return rec;
}

// ---------------------------------------------------------------- LLM agent (Claude via the Unison MCP tools)
async function llmAgent(tick: number, k: number) {
  const ip = `10.77.2.${k + 1}`, port = 19330 + k;
  const proxy = await ipProxy(ip, port);
  const cfgPath = resolve(ROOT, `packages/sim/out/mcp-agent-${k}.json`);
  writeFileSync(cfgPath, JSON.stringify(claudeMcpConfig(`http://127.0.0.1:${port}/api`)));
  const a = assets[k % 3];
  const prompt =
    `You are ${PERSONAS[k]}. You trade ${a.symbol} on Unison (Unichain Sepolia) using only the unison MCP tools. ` +
    `Call get_pool for ${a.symbol}, then quote_convert, then decide whether to convert; if you do, call convert once with at most 100 shares. ` +
    `Hard cap: 100 shares. Finish with one line: DECISION: <converted|skipped> <amount> <from>-><to> <tx hash or reason>.`;
  const relayAddr = getAddress((await (await fetch("http://127.0.0.1:19210/demo/status")).json()).address);
  const fromBlock = await pub.getBlockNumber();
  const t0 = Date.now();
  // Async spawn: the per-agent proxy lives in this process and must keep serving while Claude works.
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const c = spawn(
      "claude",
      ["-p", prompt, "--mcp-config", cfgPath, "--strict-mcp-config", "--allowedTools", "mcp__unison__get_pool mcp__unison__quote_convert mcp__unison__convert mcp__unison__list_assets", "--model", "claude-sonnet-5", "--output-format", "json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    const kill = setTimeout(() => c.kill("SIGTERM"), 300_000);
    c.on("close", (status) => (clearTimeout(kill), done({ status, stdout, stderr })));
  });
  proxy.close();
  let out: any = {};
  try {
    out = JSON.parse(r.stdout);
  } catch {
    out = { result: r.stdout?.slice(0, 500), error: r.stderr?.slice(0, 300) };
  }
  const head = await pub.getBlockNumber();
  const logs = head > fromBlock ? await pub.getLogs({ address: PARITY_HOOK, fromBlock: fromBlock + 1n, toBlock: head }) : [];
  const convs = events(logs, abi.hook).filter((e) => e.eventName === "Converted" && getAddress(e.args.sender) === relayAddr);
  for (const c of convs) {
    const i = assets.findIndex((x) => x.wrappers.some((w) => w.token === getAddress(c.args.from)));
    const from = assets[i].wrappers.find((w) => w.token === getAddress(c.args.from))!, to = assets[i].wrappers.find((w) => w.token === getAddress(c.args.to))!;
    const rec: TradeRec = {
      tick, agent: `llm-${k}`, kind: "llm", asset: assets[i].symbol, from: from.symbol, to: to.symbol,
      shares: sh(toSharesDown(c.args.amountIn, from.multiplier, from.decimals)), baseFee: sh(c.args.baseFee), skewFee: sh(c.args.skewFee), skewPips: -1, rebalancing: c.args.skewFee === 0n, tx: c.txHash,
    };
    cum.lpFeeShares[i] += rec.baseFee + rec.skewFee;
    run.trades.push(rec);
    cum.trades.llm++;
  }
  const decision = String(out.result ?? "").split("\n").find((l: string) => l.includes("DECISION")) ?? String(out.result ?? "").slice(-200);
  const rec = { tick, agent: `llm-${k}`, persona: PERSONAS[k], asset: a.symbol, seconds: (Date.now() - t0) / 1000, decision: decision.trim(), txs: convs.map((c) => c.txHash), costUsd: out.total_cost_usd, exit: r.status };
  run.llm.push(rec);
  console.error(`llm-${k} @${tick}: ${rec.decision} (${rec.seconds}s)`);
  return rec;
}

// ---------------------------------------------------------------- main loop
const quoteRef = async (i: number) => {
  const a = assets[i];
  const out: number[] = [];
  for (const w of a.wrappers) {
    const q = await quoteConvert(a, w, sharesToRaw(w, 100));
    out.push(q.fee.skewPips / 100); // bps
  }
  return out; // [w0→w1, w1→w0] skew fee in bps for a 100-share convert
};
const outDir = resolve(ROOT, "sim");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outPath = resolve(outDir, `run-${stamp}.json`);
const flush = () => writeFileSync(outPath, JSON.stringify(run, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

let tick = 0;
const t0 = Date.now();
for (; tick < TICKS || run.trades.length + cum.trades.whale < MIN_TRADES; tick++) {
  const tickTrades: string[] = [];
  const counts = { arb: 0, regular: 0, whale: 0, llm: 0, arbSkipped: 0 };
  const dark: any[] = [];
  for (let i = 0; i < assets.length; i++) {
    // t=0: 40 bps gap (NVDA the other way round); midpoint: 40 bps the opposite way to each asset's first shock.
    const first = i === 1 ? -MODEL.shockBps : MODEL.shockBps;
    if (tick === 0) openGap(i, first);
    else if (tick === MID) openGap(i, -first);
    else step(i);
  }
  const gapStart = ext.map(gapBps);
  // Agents act in a seeded random order; each arb watches its home asset through a `latency`-tick-stale price feed.
  const order = [...arbs, ...regulars].map((ag) => ({ ag, r: rand() })).sort((x, y) => x.r - y.r).map((x) => x.ag);
  for (const ag of order) {
    if (ag.kind === "arb") {
      if (rand() > MODEL.arbActivity) continue;
      const i = ag.asset;
      // latency 0 sees the live gap (including earlier arbs' impact this tick); latency L sees the close of tick − L.
      const g = ag.latency === 0 ? gapBps(ext[i]) : tick - ag.latency >= 0 ? history[i][tick - ag.latency] : gapStart[i];
      const a = assets[i];
      const [cheap, exp] = g > 0 ? [a.wrappers[0], a.wrappers[1]] : [a.wrappers[1], a.wrappers[0]];
      const q = await quoteConvert(a, cheap, sharesToRaw(cheap, ag.size));
      const net = Math.abs(g) - q.fee.basePips / 100 - q.fee.skewPips / 100;
      if (!q.fillable || net <= ag.thresholdBps) {
        counts.arbSkipped++;
        continue;
      }
      const rec = await doConvert(tick, ag.name, "arb", i, cheap, exp, ag.size, ag.addr);
      if (!rec) continue;
      impact(i, ag.size, g > 0);
      counts.arb++;
      cum.trades.arb++;
      tickTrades.push(rec.tx);
    } else {
      if (rand() > MODEL.regularActivity) continue;
      const i = int(0, 2);
      const a = assets[i];
      const dir = rand() < 0.5;
      const [from, to] = dir ? [a.wrappers[0], a.wrappers[1]] : [a.wrappers[1], a.wrappers[0]];
      const size = Math.max(1, Math.round(uniform(1, ag.maxSize)));
      const rec = await doConvert(tick, ag.name, "regular", i, from, to, size, ag.addr);
      if (!rec) continue;
      counts.regular++;
      cum.trades.regular++;
      tickTrades.push(rec.tx);
    }
  }
  // Whale pairs: both sides of one asset commit into the same batch, staggered by asset and round.
  for (let p = 0; p < 3; p++) {
    const pair = whales.filter((w) => w.asset === p);
    const round = pair[0].ticks.indexOf(tick);
    if (round < 0) continue;
    const rec = await darkBatch(tick, p, pair.map((wh) => ({ wh, shares: wh.sizes[round] })));
    dark.push(rec);
    counts.whale += 2;
    console.error(`dark ${rec.asset} batch ${rec.batchId}: crossed ${rec.crossedShares.toFixed(0)} residual ${rec.residualShares.toFixed(0)} fee→protocol ${rec.protocolFeeShares.toFixed(4)} fee→LP ${rec.lpFeeShares.toFixed(4)}`);
  }
  if (LLM && LLM_TICKS.includes(tick)) {
    const k = LLM_TICKS.indexOf(tick);
    const before = cum.trades.llm;
    try {
      const rec = await llmAgent(tick, k);
      counts.llm += cum.trades.llm - before;
      tickTrades.push(...rec.txs);
    } catch (e: any) {
      run.llm.push({ tick, agent: `llm-${k}`, persona: PERSONAS[k], decision: `harness error: ${String(e.message).slice(0, 160)}`, txs: [] });
    }
  }
  // Snapshot after the tick's trades.
  const inv = await Promise.all(assets.map(inventoryShares));
  const q = await Promise.all(assets.map((_, i) => quoteRef(i)));
  const perAsset = assets.map((a, i) => {
    const [x, y] = inv[i];
    const skew = (sh(x) - sh(y)) / (sh(x) + sh(y));
    history[i][tick] = gapBps(ext[i]);
    return {
      asset: a.symbol,
      ext: [ext[i].a, ext[i].b],
      gapBps: gapBps(ext[i]),
      gapBeforeTradesBps: gapStart[i],
      inventory: [sh(x), sh(y)],
      skew,
      skewFeeBps: q[i], // quoted skew fee for a 100-share convert, [w0→w1, w1→w0]
      lpFeesCum: cum.lpFeeShares[i],
      protocolFeesCum: cum.protocolFeeShares[i],
    };
  });
  run.ticks.push({ tick, block: String(await pub.getBlockNumber()), assets: perAsset, dark: dark.map((d) => ({ asset: d.asset, batchId: d.batchId, crossed: d.crossedShares, residual: d.residualShares })), counts, cumTrades: { ...cum.trades }, txs: tickTrades });
  if (tick % 10 === 0) {
    flush();
    const total = run.trades.length + cum.trades.whale;
    console.error(`tick ${tick} trades ${total} gaps ${perAsset.map((p) => p.gapBps.toFixed(1)).join("/")} skew ${perAsset.map((p) => p.skew.toFixed(3)).join("/")} LP ${cum.lpFeeShares.map((x) => x.toFixed(3)).join("/")} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}

// ---------------------------------------------------------------- summary
const stats = (xs: number[]) => {
  const a = xs.map(Math.abs).sort((x, y) => x - y);
  const q = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { mean: a.reduce((x, y) => x + y, 0) / a.length, p50: q(0.5), p95: q(0.95), max: a[a.length - 1] };
};
const settleWindow = (from: number, to: number, i: number) => run.ticks.slice(from, to).map((t: any) => t.assets[i].gapBps);
const firstBelow = (from: number, i: number, bps: number) => run.ticks.slice(from).findIndex((t: any) => Math.abs(t.assets[i].gapBps) < bps);
run.summary = {
  trades: run.trades.length + cum.trades.whale,
  byKind: { ...cum.trades },
  ticks: run.ticks.length,
  blocks: { from: run.meta.setupBlocks.to, to: String(await pub.getBlockNumber()) },
  perAsset: assets.map((a, i) => {
    const all = run.ticks.map((t: any) => t.assets[i]);
    return {
      asset: a.symbol,
      gapStartBps: all[0].gapBeforeTradesBps,
      gapAfterTick0Bps: all[0].gapBps,
      gapEndBps: all[all.length - 1].gapBps,
      gapMidShockBps: all[MID]?.gapBeforeTradesBps,
      ticksToUnder15BpsAfterStart: firstBelow(0, i, 15),
      ticksToUnder15BpsAfterMid: firstBelow(MID, i, 15),
      maxAbsSkew: Math.max(...all.map((x: any) => Math.abs(x.skew))),
      maxSkewFeeBps: Math.max(...all.map((x: any) => Math.max(...x.skewFeeBps))),
      lpFeesShares: cum.lpFeeShares[i],
      protocolFeesShares: cum.protocolFeeShares[i],
      pegDeviationBps: {
        all: stats(all.map((x: any) => x.gapBps)),
        steadyState: stats([...settleWindow(20, MID, i), ...settleWindow(MID + 20, run.ticks.length, i)]),
      },
    };
  }),
  rebalancingTrades: run.trades.filter((t: TradeRec) => t.rebalancing).length,
  rebalancingWithSkewFee: run.trades.filter((t: TradeRec) => t.rebalancing && t.skewFee > 0).length,
  darkBatches: run.darkBatches.length,
  reverts: reverts.length,
  llm: LLM ? run.llm.map((l: any) => ({ agent: l.agent, decision: l.decision, txs: l.txs.length })) : "SKIPPED",
  wallSeconds: (Date.now() - t0) / 1000,
};
run.meta.finishedAt = new Date().toISOString();
run.reverts = reverts;
run.meta.label = `Simulated external prices · real deployed contracts on a Unichain Sepolia fork · ${run.summary.trades} trades`;
flush();
mkdirSync(resolve(ROOT, "web/public/sim"), { recursive: true });
copyFileSync(outPath, resolve(ROOT, "web/public/sim/run.json"));
console.log(JSON.stringify({ out: outPath, summary: run.summary }, null, 2));
