// Unison Pay end-to-end demo (scripts/dev/sui-demo). Prints a receipt with explorer links at every step.
//   1. mcbAAPL deposit from wallet A and mAAPLx deposit from wallet B into ShareVault on Unichain Sepolia
//   2. one private payment A -> B on Sui (plus an overdraft in the same window, rejected by the double-spend rule)
//   3. B withdraws into the OTHER issuer's wrapper (mcbAAPL), converted through WrapSwapRouter + ParityHook
//   4. one deliberately failing withdrawal (maxFeeBps below the live fee) whose credit WithdrawalSkipped restores
//   Asserts the reserves invariant before and after, and total_shares unchanged across the private payment.
// DEMO_CHECK=1: finite smoke run (exit code = verdict). Otherwise the keeper keeps running afterwards.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { formatUnits, parseEther, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { Keeper } from './keeper.js';
import { STATE_DIR, loadDeployment } from './config.js';
import { acquireLock } from './state.js';
import { execute, sessionKeyFor, suiscan, walrusGet, walrusPut, walruscan } from './lib.js';
import { readBatch, readPool } from './chain.js';
import { prepareInstruction, readOwnBalance } from './payer.js';
import { decodeJson, formatShares, normalizeSuiAddress, type Instruction, type Manifest } from './protocol.js';
import { erc20Abi, keeperWallet, publicClient, shareVaultAbi, walletFor } from './evm.js';

const CHECK = process.env.DEMO_CHECK === '1';
const ONE = 10n ** 18n;
const dep = loadDeployment();
if (!dep.evm) throw new Error('deployments/sui-testnet.json has no "evm" section: deploy ShareVault first');
const evm = dep.evm;
const uniscan = (kind: 'tx' | 'address', id: string) => `${evm.explorer}/${kind}/${id}`;
const mcb = evm.tokens.find((t) => t.symbol === 'mcbAAPL')!;
const maaplx = evm.tokens.find((t) => t.symbol === 'mAAPLx')!;

let failures = 0;
let stepNo = 0;
function step(title: string) {
  console.log(`\n== ${++stepNo}. ${title}`);
}
function receipt(label: string, fields: Record<string, string | undefined>) {
  console.log(`  - ${label}`);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) console.log(`      ${k}: ${v}`);
}
function check(cond: boolean, what: string) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${what}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------- wallets

function suiWallets(): { A: Ed25519Keypair; B: Ed25519Keypair } {
  const f = join(STATE_DIR, 'demo-wallets.json');
  if (!existsSync(f)) {
    const gen = () => Ed25519Keypair.generate().getSecretKey();
    writeFileSync(f, JSON.stringify({ A: gen(), B: gen() }), { mode: 0o600 });
  }
  const w = JSON.parse(readFileSync(f, 'utf8'));
  return { A: Ed25519Keypair.fromSecretKey(w.A), B: Ed25519Keypair.fromSecretKey(w.B) };
}

const mnemonic = process.env.DEMO_MNEMONIC;
if (!mnemonic) throw new Error('DEMO_MNEMONIC missing from the env file');
const evmA = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const evmB = mnemonicToAccount(mnemonic, { addressIndex: 2 });

const release = acquireLock(dep.sui.poolId);
process.on('exit', release);
const keeper = new Keeper();
const client = keeper.client;
const pc = publicClient();
const { A, B } = suiWallets();
const addrA = normalizeSuiAddress(A.toSuiAddress());
const addrB = normalizeSuiAddress(B.toSuiAddress());

async function ensureSuiGas(kp: Ed25519Keypair, min = 30_000_000n) {
  const { balance } = await client.core.getBalance({ owner: kp.toSuiAddress() });
  if (BigInt(balance.balance) >= min) return;
  const tx = new Transaction();
  const [c] = tx.splitCoins(tx.gas, [min * 2n]);
  tx.transferObjects([c], kp.toSuiAddress());
  const t = await execute(client, keeper.kp, tx);
  receipt(`fund ${kp.toSuiAddress().slice(0, 10)}… with SUI gas`, { sui: suiscan('tx', t.digest) });
}

async function evmTx(hash: Hex) {
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`EVM tx reverted: ${hash}`);
  return r;
}

async function ensureEvm(acct: typeof evmA, token: typeof mcb, raw: bigint) {
  const deployer = keeperWallet();
  const eth = await pc.getBalance({ address: acct.address });
  if (eth < parseEther('0.0005')) {
    const h = await deployer.sendTransaction({ to: acct.address, value: parseEther('0.001') });
    await evmTx(h);
    receipt(`fund ${acct.address} with gas`, { unichain: uniscan('tx', h) });
  }
  const bal = await pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] });
  if (bal < raw) {
    const h = await deployer.writeContract({ address: token.address, abi: erc20Abi, functionName: 'mint', args: [acct.address, raw - bal] });
    await evmTx(h);
    receipt(`mint ${formatUnits(raw - bal, token.decimals)} ${token.symbol} to ${acct.address} (mock issuer)`, { unichain: uniscan('tx', h) });
  }
  const w = walletFor(`0x${Buffer.from(acct.getHdKey().privateKey!).toString('hex')}`);
  const allowance = await pc.readContract({ address: token.address, abi: erc20Abi, functionName: 'allowance', args: [acct.address, evm.shareVault] });
  if (allowance < raw) {
    const h = await w.writeContract({ address: token.address, abi: erc20Abi, functionName: 'approve', args: [evm.shareVault, 2n ** 255n] });
    await evmTx(h);
  }
  return w;
}

// ---------------------------------------------------------------- invariant

async function reserves(label: string) {
  const [pool, block] = await Promise.all([readPool(client, dep.sui.poolId), pc.getBlockNumber()]);
  const [held, outstanding] = await pc.readContract({ address: evm.shareVault, abi: shareVaultAbi, functionName: 'reserves', blockNumber: block });
  receipt(`reserves ${label}`, {
    suiTotalShares: formatShares(pool.totalShares, 6),
    vaultSharesOutstanding: formatShares(outstanding, 6),
    vaultSharesHeld: formatShares(held, 6),
    checkedBlock: block.toString(),
  });
  check(pool.totalShares === outstanding, `Sui total_shares == ShareVault.sharesOutstanding (${label})`);
  check(held >= outstanding, `ShareVault shares held >= outstanding (${label})`);
  return pool.totalShares;
}

async function ownBalance(kp: Ed25519Keypair) {
  const pool = await readPool(client, dep.sui.poolId);
  const manifest = decodeJson<Manifest>(await walrusGet(pool.manifestBlob));
  const sessionKey = await sessionKeyFor(client, kp, dep.sui.packageId);
  return readOwnBalance({
    client,
    seal: keeper.seal,
    sessionKey,
    packageId: dep.sui.packageId,
    poolId: dep.sui.poolId,
    owner: kp.toSuiAddress(),
    manifest,
    onchainRoot: pool.entriesRoot,
  });
}

async function submit(kp: Ed25519Keypair, ins: Instruction, label: string) {
  const pool = await readPool(client, dep.sui.poolId);
  const p = await prepareInstruction({ seal: keeper.seal, packageId: dep.sui.packageId, poolId: dep.sui.poolId, batchId: pool.currentBatch, instruction: ins, walrusPut });
  const t = await execute(client, kp, p.tx);
  receipt(label, { sui: suiscan('tx', t.digest), walrus: walruscan(p.blobId), commitment: p.commitment, batch: suiscan('object', pool.currentBatch) });
  return p.commitment;
}

// ---------------------------------------------------------------- flow

console.log(`Unison Pay demo — ${new Date().toISOString()}${CHECK ? ' (DEMO_CHECK=1)' : ''}`);
console.log(`Sui package ${suiscan('object', dep.sui.packageId)}`);
console.log(`Pool        ${suiscan('object', dep.sui.poolId)}`);
console.log(`ShareVault  ${uniscan('address', evm.shareVault)}`);
console.log(`Wallet A    sui ${addrA} / evm ${evmA.address}`);
console.log(`Wallet B    sui ${addrB} / evm ${evmB.address}`);

step('Setup and reserves before');
await ensureSuiGas(A);
await ensureSuiGas(B);
for (const r of await keeper.tick()) receipt(`keeper catch-up: ${r.step}`, { sui: r.sui && suiscan('tx', r.sui) });
await reserves('before');

step('Deposits on Unichain Sepolia (issuer tokens into ShareVault custody)');
const mcbRaw = 2n * 10n ** 6n; // 2 mcbAAPL = 2.025 canonical shares
const wA = await ensureEvm(evmA, mcb, mcbRaw);
const hA = await wA.writeContract({ address: evm.shareVault, abi: shareVaultAbi, functionName: 'deposit', args: [mcb.address, mcbRaw, addrA] });
await evmTx(hA);
receipt(`A deposits 2 mcbAAPL -> credit to Sui ${addrA.slice(0, 10)}…`, { unichain: uniscan('tx', hA) });

// Size B's side from live custody so the cross-issuer withdrawal has to convert through the router.
const heldMcb = await pc.readContract({ address: mcb.address, abi: erc20Abi, functionName: 'balanceOf', args: [evm.shareVault] });
const heldMcbShares = heldMcb * 10125n * 10n ** 8n; // raw * 1.0125e18 / 1e6 (mcbAAPL: 6 decimals, multiplier 1.0125)
const W_OK = ((heldMcbShares / ONE) + 1n) * ONE; // strictly more mcbAAPL than custody holds
const W_SKIP = W_OK - ONE / 2n;
const PAY = ONE;
const bDeposit = W_OK + W_SKIP + 2n * ONE;
const wB = await ensureEvm(evmB, maaplx, bDeposit);
const hB = await wB.writeContract({ address: evm.shareVault, abi: shareVaultAbi, functionName: 'deposit', args: [maaplx.address, bDeposit, addrB] });
await evmTx(hB);
receipt(`B deposits ${formatShares(bDeposit, 2)} mAAPLx -> credit to Sui ${addrB.slice(0, 10)}…`, { unichain: uniscan('tx', hB) });

const credits = await keeper.creditDeposits();
for (const r of credits) receipt(`keeper credit_deposit (${formatShares(BigInt(String(r.detail?.shares)), 4)} shares)`, { sui: suiscan('tx', r.sui!), evm: uniscan('tx', r.evm!), walrusManifest: walruscan(r.walrus!) });
check(credits.length >= 2, 'both deposits attested on Sui');
const a0 = await ownBalance(A);
const b0 = await ownBalance(B);
receipt('balances decrypted client-side via Seal (seal_approve_leaf) and Merkle-verified', {
  A: `${formatShares(a0.balance)} shares, proof ${a0.verified ? 'verified' : 'INVALID'}`,
  B: `${formatShares(b0.balance)} shares, proof ${b0.verified ? 'verified' : 'INVALID'}`,
});
check(a0.verified && b0.verified, 'leaf Merkle proofs verify against the on-chain root');
await reserves('after deposits');

step('Private payment A -> B on Sui, plus withdrawals, in one window');
const q = (await pc.readContract({ address: evm.shareVault, abi: shareVaultAbi, functionName: 'quoteWithdrawal', args: [mcb.address, W_OK] }));
receipt('withdrawal quote (hook-output gross-up)', { target: 'mcbAAPL', shares: formatShares(W_OK), direct: String(q[3]), feePips: String(q[2]), sharesDebited: formatShares(q[1], 6) });
check(!q[3], 'cross-issuer withdrawal must convert (custody lacks enough mcbAAPL)');

const nonce = () => crypto.randomUUID();
const cPay = await submit(A, { v: 1, kind: 'pay', to: addrB, shares: PAY.toString(), memo: 'three Apple shares, first instalment', nonce: nonce() }, 'A submits encrypted payment (1 share to B)');
await submit(A, { v: 1, kind: 'pay', to: addrB, shares: (a0.balance).toString(), memo: 'double spend attempt', nonce: nonce() }, 'A submits a second payment exceeding the remaining balance (must be rejected)');
const cOk = await submit(B, { v: 1, kind: 'withdraw', recipient: evmB.address, target: mcb.address, shares: W_OK.toString(), maxFeeBps: 25, nonce: nonce() }, `B submits withdrawal of ${formatShares(W_OK, 2)} shares into mcbAAPL (max fee 25 bps)`);
const cSkip = await submit(B, { v: 1, kind: 'withdraw', recipient: evmB.address, target: mcb.address, shares: W_SKIP.toString(), maxFeeBps: 1, nonce: nonce() }, `B submits withdrawal of ${formatShares(W_SKIP, 2)} shares into mcbAAPL with max fee 1 bps (below the live fee: must skip)`);

const pool1 = await readPool(client, dep.sui.poolId);
const batch1 = await readBatch(client, pool1.currentBatch);
console.log(`  window closes at ${new Date(batch1.closesMs).toISOString()} (seq ${batch1.seq}, ${batch1.instructions.length} envelopes)`);

// Seal must refuse the operator before the window closes.
try {
  const env = batch1.instructions[0];
  await keeper.decryptEnvelope(batch1, env, await sessionKeyFor(client, keeper.kp, dep.sui.packageId));
  check(false, 'Seal denies the keeper before the window closes');
} catch (e: any) {
  check(/NoAccess|access/i.test(`${e?.constructor?.name} ${e?.message}`), `Seal denies the keeper before the window closes (${e?.constructor?.name})`);
}

let applied = null;
while (!applied) {
  await new Promise((r) => setTimeout(r, 10_000));
  applied = await keeper.applyWindow();
  if (!applied) process.stdout.write(`  waiting for window close… ${Math.max(0, Math.ceil((batch1.closesMs - Date.now()) / 1000))}s\r`);
}
console.log('');
const results = (applied.detail?.results ?? []) as Record<string, unknown>[];
receipt(`keeper apply_batch seq ${batch1.seq}`, { sui: suiscan('tx', applied.sui!), walrusManifest: walruscan(applied.walrus!), root: String(applied.detail?.root) });
for (const r of results) console.log(`      #${r.index} ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.kind ? ` ${r.kind}` : ''}`);
const totalAfterApply = (await readPool(client, dep.sui.poolId)).totalShares;
check(totalAfterApply === pool1.totalShares, `total_shares unchanged across the private payment (${formatShares(totalAfterApply, 6)})`);
check(results[0]?.status === 'applied' && results[1]?.status === 'rejected' && results[1]?.reason === 'overdraft', 'double-spend rule: in-window overdraft rejected, first payment applied');
check(results[2]?.status === 'escrowed' && results[3]?.status === 'escrowed', 'both withdrawals escrowed');

step('Withdrawal settlement on Unichain (WrapSwapRouter -> ParityHook) and debit on Sui');
const mcbBefore = await pc.readContract({ address: mcb.address, abi: erc20Abi, functionName: 'balanceOf', args: [evmB.address] });
const settled = await keeper.settlePending();
if (!settled) throw new Error('nothing settled');
receipt('keeper settleWithdrawals + debit_withdrawal', { unichain: uniscan('tx', settled.evm!), sui: suiscan('tx', settled.sui!), walrusManifest: walruscan(settled.walrus!) });
const outcomes = (settled.detail?.outcomes ?? []) as Record<string, string>[];
const ok = outcomes.find((o) => o.commitment === cOk);
const skip = outcomes.find((o) => o.commitment === cSkip);
for (const o of outcomes) console.log(`      ${o.commitment.slice(0, 10)}… ${o.status}${o.sharesDebited ? ` debited ${formatShares(BigInt(o.sharesDebited), 6)}` : ''}${o.restored ? ` restored ${formatShares(BigInt(o.restored), 6)}` : ''}`);
const mcbAfter = await pc.readContract({ address: mcb.address, abi: erc20Abi, functionName: 'balanceOf', args: [evmB.address] });
const netMcb = (W_OK * 10n ** 6n) / (10125n * 10n ** 14n);
receipt('B received mcbAAPL (the other issuer\'s wrapper)', { amount: `${formatUnits(mcbAfter - mcbBefore, 6)} mcbAAPL`, faceValue: `${formatUnits(netMcb, 6)} mcbAAPL` });
check(ok?.status === 'settled' && mcbAfter - mcbBefore >= netMcb, 'cross-issuer withdrawal delivered at least face value');
check(skip?.status === 'skipped', 'fee-capped withdrawal emitted WithdrawalSkipped');

const a1 = await ownBalance(A);
const b1 = await ownBalance(B);
const expectedB = b0.balance + PAY - BigInt(ok?.sharesDebited ?? '0');
receipt('balances after, decrypted via Seal', {
  A: `${formatShares(a1.balance)} (expected ${formatShares(a0.balance - PAY)})`,
  B: `${formatShares(b1.balance)} (expected ${formatShares(expectedB)}: skipped credit restored, unused fee reservation refunded)`,
});
check(a1.balance === a0.balance - PAY, 'A debited exactly the payment');
check(b1.balance === expectedB, 'B = before + payment - settled debit; WithdrawalSkipped restored its credit');
check(a1.verified && b1.verified, 'leaf Merkle proofs verify after settlement');

step('Reserves after');
await reserves('after');

console.log(`\n${failures === 0 ? 'DEMO PASS' : `DEMO FAIL (${failures} checks failed)`}`);
if (CHECK || failures) {
  process.exit(failures ? 1 : 0);
}
console.log('keeper running (Ctrl-C to stop)…');
for (;;) {
  try {
    for (const r of await keeper.tick()) console.log(`[sui-keeper] ${JSON.stringify(r)}`);
  } catch (e) {
    console.error('[sui-keeper] tick failed:', (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
