// Phase 1: scripted run on the Unichain Sepolia fork against the real deployed contracts, with assertions.
// Usage (repo root): pnpm exec tsx packages/sim/src/verify.ts   → packages/sim/out/phase1.json + markdown table on stdout
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toHex, getAddress, type Address } from "viem";
import {
  abi, agentAddress, assets, call, events, impersonateDeployer, increaseTime, inventoryShares, mine, mintTo, pub, pushParityMid,
  read, rpc, send, setBalance, sharesToRaw, toSharesDown, fmt, ONE, API, RELAY, ROOT, FAUCET, SHARE_VAULT, PARITY_HOOK,
  PROTOCOL_FEE_RECIPIENT, DEPLOYER, type Asset, type Wrapper,
} from "./chain.js";
import { convert, approveOnce, type ConvertResult } from "./trade.js";

type Row = { id: string; check: string; ok: boolean; evidence: string };
const rows: Row[] = [];
const check = (id: string, checkText: string, ok: boolean, evidence: string) => {
  rows.push({ id, check: checkText, ok, evidence });
  console.error(`${ok ? "PASS" : "FAIL"} ${id} ${checkText} — ${evidence}`);
};
const guard = async (id: string, text: string, f: () => Promise<void>) => {
  try {
    await f();
  } catch (e: any) {
    check(id, text, false, `error: ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
  }
};

const convertRecords: (ConvertResult & { asset: string; from: string; to: string })[] = [];
function feeIdentity(r: ConvertResult) {
  const { baseFee, skewFee, sharesOut } = r.converted;
  const charged = r.quote.shares - sharesOut; // input shares − output shares = everything the hook kept
  const pipsOk = r.fill.feePips === r.quote.fee.basePips + r.quote.fee.skewPips && r.fill.feePips === r.quote.fee.totalPips;
  return { ok: baseFee + skewFee === charged && pipsOk, charged };
}

await impersonateDeployer();
const [AAPL, NVDA, TSLA] = assets;
const trader = agentAddress("p1-trader");
await setBalance(trader, 10n ** 20n);
for (const a of assets) for (const w of a.wrappers) await mintTo(trader, w, sharesToRaw(w, 5_000));

// ---------------------------------------------------------------- 1. Convert both directions, all 3 assets
await guard("C1", "Convert both directions on AAPL/NVDA/TSLA", async () => {
  const done: string[] = [];
  for (const a of assets) {
    for (const [from, to] of [[a.wrappers[0], a.wrappers[1]], [a.wrappers[1], a.wrappers[0]]] as [Wrapper, Wrapper][]) {
      const before = await read<bigint>(to.token, abi.erc20, "balanceOf", [trader]);
      const r = await convert(a, trader, from, sharesToRaw(from, 25));
      const after = await read<bigint>(to.token, abi.erc20, "balanceOf", [trader]);
      if (after - before !== r.fill.amountOut) throw Error(`${a.symbol} ${from.symbol}→${to.symbol}: received ${after - before} ≠ fill ${r.fill.amountOut}`);
      convertRecords.push({ ...r, asset: a.symbol, from: from.symbol, to: to.symbol });
      done.push(`${from.symbol}→${to.symbol} ${r.txHash.slice(0, 10)}`);
    }
  }
  check("C1", "Convert both directions on AAPL/NVDA/TSLA", done.length === 6, done.join(", "));
});

// ---------------------------------------------------------------- 2. base + skew == total charged; 3. skew 0 when rebalancing
await guard("F1", "base + skew == total charged", async () => {
  // Push AAPL's inventory off balance, then trade back through it: one skew-increasing and one rebalancing trade per asset.
  for (const a of assets) {
    const [w0, w1] = a.wrappers;
    const up = await convert(a, trader, w0, sharesToRaw(w0, 400));
    const back = await convert(a, trader, w1, sharesToRaw(w1, 150));
    convertRecords.push({ ...up, asset: a.symbol, from: w0.symbol, to: w1.symbol }, { ...back, asset: a.symbol, from: w1.symbol, to: w0.symbol });
  }
  const bad = convertRecords.filter((r) => !feeIdentity(r).ok);
  check(
    "F1",
    "base + skew == total charged (Converted.baseFee+skewFee == input shares − output shares; InventoryFill.feePips == base+skew pips)",
    bad.length === 0 && convertRecords.length > 0,
    bad.length
      ? bad.map((r) => `${r.txHash}: base ${r.converted.baseFee} + skew ${r.converted.skewFee} vs charged ${feeIdentity(r).charged}, pips ${r.fill.feePips} vs ${r.quote.fee.basePips}+${r.quote.fee.skewPips}`).join("; ")
      : `${convertRecords.length}/${convertRecords.length} converts exact to the wei-share`,
  );
  const rebal = convertRecords.filter((r) => r.quote.fee.reducesImbalance);
  const incr = convertRecords.filter((r) => !r.quote.fee.reducesImbalance);
  const rebalBad = rebal.filter((r) => r.converted.skewFee !== 0n || r.quote.fee.skewPips !== 0);
  check(
    "F2",
    "skew fee is 0 on rebalancing trades",
    rebal.length > 0 && rebalBad.length === 0 && incr.some((r) => r.converted.skewFee > 0n),
    `${rebal.length} rebalancing converts all skewFee=0 (e.g. ${rebal[0]?.txHash.slice(0, 10)}); ${incr.filter((r) => r.converted.skewFee > 0n).length} skew-increasing converts paid skew > 0` +
      (rebalBad.length ? `; BAD: ${rebalBad.map((r) => r.txHash).join(",")}` : ""),
  );
});

// ---------------------------------------------------------------- 4. the fee has no clock input
await guard("H1", "fee has no clock input", async () => {
  // Same trade from the same state at (a) a Saturday and (b) a weekday 15:00 UTC: the
  // fees must be identical. Snapshot/revert keeps the state equal; the Monday leg runs last so time only moves forward.
  const a = AAPL, w = a.wrappers[0], amt = sharesToRaw(w, 80);
  // (a) the next Saturday 16:00 UTC; (b) the Monday after, 15:00 UTC.
  const now = Number((await pub.getBlock()).timestamp);
  const d = new Date((now + 86400) * 1000);
  const satMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7), 16);
  const [satTs, monTs] = [satMs / 1000, satMs / 1000 + 2 * 86400 - 3600];
  const snap = await rpc("evm_snapshot");
  await rpc("evm_setNextBlockTimestamp", [toHex(satTs)]);
  const sat = await convert(a, trader, w, amt);
  const satDay = new Date(Number((await pub.getBlock({ blockNumber: sat.block })).timestamp) * 1000).toUTCString();
  await rpc("evm_revert", [snap]);
  await rpc("evm_setNextBlockTimestamp", [toHex(monTs)]);
  const mon = await convert(a, trader, w, amt);
  const monDay = new Date(Number((await pub.getBlock({ blockNumber: mon.block })).timestamp) * 1000).toUTCString();
  const same = sat.converted.baseFee === mon.converted.baseFee && sat.converted.skewFee === mon.converted.skewFee && sat.fill.feePips === mon.fill.feePips && sat.fill.amountOut === mon.fill.amountOut;
  convertRecords.push({ ...mon, asset: a.symbol, from: w.symbol, to: a.wrappers[1].symbol });
  check(
    "H1",
    "fee has no clock input (identical fee on a Saturday and a weekday; deployment has no calendar)",
    same && (await import("./chain.js")).resolved.contracts.calendar === null,
    `${satDay}: ${sat.fill.feePips} pips, out ${sat.fill.amountOut}; ${monDay}: ${mon.fill.feePips} pips, out ${mon.fill.amountOut}; contracts.calendar=null`,
  );
});

// ---------------------------------------------------------------- 5-7. Dark Cross: crossed + residual + unfilled in one batch
await guard("D1", "Dark Cross batch", async () => {
  const a = AAPL;
  const base = a.wrappers.find((w) => w.token === a.base)!, quote = a.wrappers.find((w) => w.token === a.quote)!;
  const [seller, buyer, picky] = ["p1-dark-seller", "p1-dark-buyer", "p1-dark-picky"].map(agentAddress);
  const plan = [
    { who: seller, sellBase: true, w: base, shares: 100, limit: (m: bigint) => (m * 99n) / 100n },
    { who: buyer, sellBase: false, w: quote, shares: 60, limit: (m: bigint) => (m * 101n) / 100n },
    { who: picky, sellBase: true, w: base, shares: 30, limit: (m: bigint) => (m * 105n) / 100n }, // above mid: can't cross, residual below limit
  ];
  for (const p of plan) {
    await setBalance(p.who, 10n ** 20n);
    await mintTo(p.who, p.w, sharesToRaw(p.w, p.shares));
    await approveOnce(p.who, p.w.token, a.dark);
    await send(p.who, a.dark, abi.dark, "fund", [p.w.token, sharesToRaw(p.w, p.shares)]);
  }
  const mid = await pushParityMid(a);
  // Align to the start of a COMMIT phase.
  let [batchId, phase, ends] = await read<[bigint, number, bigint]>(a.dark, abi.dark, "currentBatch");
  const head = await pub.getBlockNumber();
  if (phase !== 0 || ends - head < 6n) {
    const [, , e] = [batchId, phase, ends];
    let n = await pub.getBlockNumber();
    // mine to the next batch's first block
    const nextStart = phase === 0 ? e + 8n : phase === 1 ? e + 2n : e;
    if (nextStart > n) await mine(Number(nextStart - n));
    [batchId, phase, ends] = await read(a.dark, abi.dark, "currentBatch");
  }
  if (phase !== 0) throw Error(`not in COMMIT (phase ${phase})`);
  const pfrBefore = await Promise.all([base, quote].map((w) => read<[bigint, bigint]>(a.dark, abi.dark, "balances", [PROTOCOL_FEE_RECIPIENT, w.token])));
  const escrowBefore = await Promise.all(plan.map((p) => read<[bigint, bigint]>(a.dark, abi.dark, "balances", [p.who, p.w.token])));
  const inv0 = await inventoryShares(a);
  const salts = plan.map((_, i) => keccak256(toHex(`sim-salt-${i}-${batchId}`)));
  for (const [i, p] of plan.entries()) {
    const amt = sharesToRaw(p.w, p.shares);
    const h = await read(a.dark, abi.dark, "commitHashOf", [batchId, p.who, p.sellBase, amt, p.limit(mid), p.who, salts[i]]);
    await call(p.who, a.dark, abi.dark, "commit", [h, p.w.token, amt, "0x" + "0".repeat(64)]);
  }
  [, phase, ends] = await read(a.dark, abi.dark, "currentBatch");
  await mine(Number(ends - (await pub.getBlockNumber())));
  for (const [i, p] of plan.entries()) await call(p.who, a.dark, abi.dark, "reveal", [p.sellBase, sharesToRaw(p.w, p.shares), p.limit(mid), p.who, salts[i]]);
  [, phase, ends] = await read(a.dark, abi.dark, "currentBatch");
  await mine(Number(ends - (await pub.getBlockNumber())));
  await pushParityMid(a);
  let settleTx: string;
  if (!(await read<boolean>(a.dark, abi.dark, "settled", [batchId]))) {
    const r = await call(DEPLOYER, a.dark, abi.dark, "settle", [batchId]);
    settleTx = r.transactionHash;
  } else settleTx = "(settled by crank)";
  const logs = await pub.getLogs({ address: a.dark, fromBlock: (await pub.getBlockNumber()) - 40n });
  const ev = events(logs, abi.dark).filter((e) => e.args.batchId === batchId);
  const crossFills = ev.filter((e) => e.eventName === "CrossFilled");
  const crossed = ev.find((e) => e.eventName === "Crossed");
  const residual = ev.find((e) => e.eventName === "ResidualFilled");
  const unfilled = ev.find((e) => e.eventName === "Unfilled" && e.args.user === picky);
  const dust = ev.filter((e) => e.eventName === "Unfilled" && e.args.user !== picky);
  const settled = ev.find((e) => e.eventName === "BatchSettled");
  const tx = settled?.txHash ?? settleTx;
  check(
    "D1",
    "Dark Cross: crossed + residual + unfilled in one batch",
    !!crossed && !!residual && !!unfilled && residual.args.user === seller && unfilled.args.user === picky,
    `AAPL batch ${batchId}, settle ${tx}: Crossed ${crossed ? fmt(crossed.args.matchedShares, 2) : "none"} sh; ResidualFilled ${residual ? fmt(residual.args.shares, 2) : "none"} sh (seller); Unfilled ${unfilled ? fmt(unfilled.args.sharesRefunded, 2) : "none"} sh (picky)` + (dust.length ? `; plus ${dust.length} rounding-dust Unfilled (${dust.map((d) => `${d.args.sharesRefunded} share-wei`).join(", ")}) refunded to escrow` : ""),
  );
  // Venue fee: every CrossFilled.fee == ceil(gross × 100 / 1e6), credited to protocolFeeRecipient's escrow.
  const crossFeePips = await read<number>(a.dark, abi.dark, "CROSS_FEE_PIPS");
  const pfrAfter = await Promise.all([base, quote].map((w) => read<[bigint, bigint]>(a.dark, abi.dark, "balances", [PROTOCOL_FEE_RECIPIENT, w.token])));
  const feeByToken = [0n, 0n];
  let feeExact = crossFills.length === 2;
  for (const f of crossFills) {
    const gross = f.args.amountOut + f.args.fee;
    const expect = (gross * BigInt(crossFeePips) + 999_999n) / 1_000_000n;
    if (f.args.fee !== expect) feeExact = false;
    feeByToken[f.args.sellBase ? 1 : 0] += f.args.fee; // sellers of base receive quote
  }
  const pfrDelta = [pfrAfter[0][0] - pfrBefore[0][0], pfrAfter[1][0] - pfrBefore[1][0]];
  check(
    "D2",
    "DarkCross venue fee == 1 bp to protocolFeeRecipient",
    crossFeePips === 100 && feeExact && pfrDelta[0] === feeByToken[0] && pfrDelta[1] === feeByToken[1] && (await read(a.dark, abi.dark, "protocolFeeRecipient")) === PROTOCOL_FEE_RECIPIENT,
    `CROSS_FEE_PIPS=${crossFeePips}; fees ${crossFills.map((f) => `${f.args.fee}/${f.args.amountOut + f.args.fee} gross`).join(", ")}; recipient ${PROTOCOL_FEE_RECIPIENT} escrow +${pfrDelta[0]} ${base.symbol} raw, +${pfrDelta[1]} ${quote.symbol} raw (== CrossFilled fees)`,
  );
  const inv1 = await inventoryShares(a);
  const lpGain = inv1[0] + inv1[1] - (inv0[0] + inv0[1]);
  const resFee = residual ? residual.args.baseFee + residual.args.skewFee : 0n;
  check(
    "D3",
    "residual fee goes to LP (ParityHook inventory)",
    !!residual && resFee > 0n && lpGain >= resFee - 2n && lpGain <= resFee + 2n,
    `ResidualFilled base ${residual?.args.baseFee} + skew ${residual?.args.skewFee} = ${resFee} share-wei; hook inventory Δ = ${lpGain} share-wei (±2 wei adapter rounding)`,
  );
  const pickyAfter = await read<[bigint, bigint]>(a.dark, abi.dark, "balances", [picky, base.token]);
  const pickyAmt = sharesToRaw(base, 30);
  check(
    "D4",
    "unfilled refunded in full",
    !!unfilled && pickyAfter[0] === escrowBefore[2][0] && pickyAfter[1] === 0n && escrowBefore[2][0] >= pickyAmt && unfilled.args.sharesRefunded === toSharesDown(pickyAmt, base.multiplier, base.decimals),
    `picky escrow before commit ${escrowBefore[2][0]}, after settle available ${pickyAfter[0]} locked ${pickyAfter[1]} (${base.symbol} raw); Unfilled.sharesRefunded ${unfilled?.args.sharesRefunded}`,
  );
});

// ---------------------------------------------------------------- 8. ShareVault deposit + cross-issuer withdraw via router with recipient
await guard("V1", "ShareVault deposit + cross-issuer withdraw", async () => {
  const a = AAPL;
  const vaultTokens = await Promise.all(a.wrappers.map((w) => read<bigint>(w.token, abi.erc20, "balanceOf", [SHARE_VAULT])));
  const depositor = agentAddress("p1-vault-depositor");
  await setBalance(depositor, 10n ** 20n);
  const lines: string[] = [];
  let solvent = true;
  const rs = async () => {
    const [held, out] = await read<[bigint, bigint]>(SHARE_VAULT, abi.vault, "reserves");
    solvent &&= held >= out;
    return `${fmt(held, 4)}/${fmt(out, 4)}`;
  };
  lines.push(`reserves held/outstanding start ${await rs()}`);
  const keeper = DEPLOYER;
  for (const [src, dst] of [[a.wrappers[1], a.wrappers[0]], [a.wrappers[0], a.wrappers[1]]] as [Wrapper, Wrapper][]) {
    const heldDst = await read<bigint>(dst.token, abi.erc20, "balanceOf", [SHARE_VAULT]);
    const dstShares = toSharesDown(heldDst, dst.multiplier, dst.decimals);
    // Source custody must cover the whole converted amount; target custody must fall short so the vault converts.
    const depositShares = Math.ceil(Number(dstShares) / 1e18) + 60;
    await mintTo(depositor, src, sharesToRaw(src, depositShares));
    await approveOnce(depositor, src.token, SHARE_VAULT);
    const dep = await call(depositor, SHARE_VAULT, abi.vault, "deposit", [src.token, sharesToRaw(src, depositShares), keccak256(toHex("sim-sui-tag"))]);
    lines.push(`deposit ${depositShares} ${src.symbol} ${dep.transactionHash.slice(0, 10)} → ${await rs()}`);
    // Withdraw more of the other issuer than custody holds, so the vault converts through the router to the recipient.
    const wShares = dstShares + 30n * ONE;
    const recipient = agentAddress(`p1-vault-recipient-${dst.symbol}`);
    const before = await read<bigint>(dst.token, abi.erc20, "balanceOf", [recipient]);
    const q = await read<[bigint, bigint, number, boolean]>(SHARE_VAULT, abi.vault, "quoteWithdrawal", [dst.token, wShares]);
    const w = { commitment: keccak256(toHex(`sim-withdrawal-${dst.symbol}-${Date.now()}`)), recipient, targetIssuerToken: dst.token, shares: wShares, maxFeeBps: 100n };
    const r = await call(keeper, SHARE_VAULT, abi.vault, "settleWithdrawals", [[w], toHex("sim-phase1")], 5_000_000n); // explicit gas: estimateGas under-provisions the inner try/catch
    const ws = events(r.logs, abi.vault, SHARE_VAULT);
    const settledEv = ws.find((e) => e.eventName === "WithdrawalSettled");
    const skipped = ws.find((e) => e.eventName === "WithdrawalSkipped");
    const conv = events(r.logs, abi.hook, PARITY_HOOK).find((e) => e.eventName === "Converted");
    const got = (await read<bigint>(dst.token, abi.erc20, "balanceOf", [recipient])) - before;
    const net = (wShares * 10n ** BigInt(dst.decimals)) / dst.multiplier;
    if (skipped || !settledEv) throw Error(`withdrawal skipped: ${skipped?.args.reason}`);
    const ok = settledEv.args.sourceIssuerToken === src.token && got >= net && conv?.args.recipient === recipient && !q[3];
    solvent &&= ok;
    lines.push(`withdraw ${fmt(wShares, 2)} sh as ${dst.symbol} (custody had ${fmt(dstShares, 2)}) → converted ${src.symbol}→${dst.symbol} via router, Converted.recipient=${recipient.slice(0, 8)}…, got ${got} ≥ net ${net}, fee ${q[2]} pips ${r.transactionHash.slice(0, 10)} → ${await rs()}`);
  }
  check("V1", "ShareVault deposit + withdraw into the other issuer via router with recipient; solvency held ≥ outstanding throughout", solvent, lines.join("; ") + `; vault tokens at start ${vaultTokens.join("/")}`);
});

// ---------------------------------------------------------------- 9. Faucet claim + cooldown
await guard("T1", "faucet claim + cooldown", async () => {
  const u = agentAddress("p1-faucet-user");
  await setBalance(u, 10n ** 18n);
  const tokens = await read<Address[]>(FAUCET, abi.faucet, "tokens");
  const before = await Promise.all(tokens.map((t) => read<bigint>(t, abi.erc20, "balanceOf", [u])));
  const r1 = await call(u, FAUCET, abi.faucet, "claim");
  const after = await Promise.all(tokens.map((t) => read<bigint>(t, abi.erc20, "balanceOf", [u])));
  const amounts = await Promise.all(tokens.map((t) => read<bigint>(FAUCET, abi.faucet, "amountOf", [t])));
  const got = tokens.every((_, i) => after[i] - before[i] === amounts[i]);
  let secondErr = "";
  try {
    await call(u, FAUCET, abi.faucet, "claim");
  } catch (e: any) {
    secondErr = e.message;
  }
  const cooldown = await read<bigint>(FAUCET, abi.faucet, "COOLDOWN");
  await increaseTime(Number(cooldown));
  await mine(1);
  const r3 = await call(u, FAUCET, abi.faucet, "claim");
  check(
    "T1",
    "faucet claim + cooldown",
    got && !!secondErr && r3.status === "success",
    `claim ${r1.transactionHash.slice(0, 10)} paid ${tokens.length} tokens exactly amountOf; immediate re-claim → ${secondErr.replace("claim reverts: ", "").slice(0, 90)}; after evm_increaseTime(${cooldown}) claim ${r3.transactionHash.slice(0, 10)} ok`,
  );
});

// ---------------------------------------------------------------- 10. Stack: API/indexer + relay against the fork
await guard("S1", "stack serves the fork", async () => {
  const h: any = await (await fetch(`${API}/health`)).json();
  const relay: any = await (await fetch(`${RELAY}/demo/status`)).json();
  const res = await fetch(`${RELAY}/demo/convert`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
    body: JSON.stringify({ asset: "NVDA", from: "Coinbase", to: "xStocks", amount: "10" }),
  });
  const rj: any = await res.json();
  await new Promise((r) => setTimeout(r, 4000));
  const h2: any = await (await fetch(`${API}/health`)).json();
  check(
    "S1",
    "full stack on the fork: API+indexer at head, crank healthy, relay converts on the fork",
    h.ok && h2.ok && h2.rpcChainId === 1301 && res.ok,
    `API ok=${h2.ok} head ${h2.headBlock} indexed ${h2.indexedBlock}; relay ${relay.address ?? "?"} POST /demo/convert → ${res.status} ${rj.txHash ?? JSON.stringify(rj).slice(0, 80)}`,
  );
});

mkdirSync(resolve(ROOT, "packages/sim/out"), { recursive: true });
const fork = { rpc: "anvil --fork-url https://sepolia.unichain.org --chain-id 1301 --port 8555", head: String(await pub.getBlockNumber()) };
writeFileSync(resolve(ROOT, "packages/sim/out/phase1.json"), JSON.stringify({ at: new Date().toISOString(), fork, rows }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log("| # | Check | Result | Evidence |\n|---|---|---|---|");
for (const r of rows) console.log(`| ${r.id} | ${r.check} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.evidence.replace(/\|/g, "/")} |`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
