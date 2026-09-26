// Unison Pay keeper: applies closed windows, attests ShareVault deposits and settles withdrawals.
//
// Double-spend rule: instructions in a window are applied strictly in submission order against the running balance;
// an instruction that would overdraw its payer at that point is rejected and logged, even if an earlier payment in
// the same window is what drained the balance.
import { EncryptedObject } from '@mysten/seal';
import { isAddress, type Hex } from 'viem';
import { SEAL_THRESHOLD, execute, loadKeypair, sealClient, sessionKeyFor, suiClient, walrusGet, walrusPut, type Client } from './lib.js';
import { applyBatchTx, readBatch, readPool, rootWithReceiptTx, sealApproveBatchTx, type BatchState, type EnvelopeState } from './chain.js';
import { buildManifest, commitmentOf, decodeJson, encodeJson, leafIdentity, normalizeSuiAddress, type Instruction, type Leaf, type Manifest } from './protocol.js';
import { loadDeployment, type Deployment } from './config.js';
import { loadState, log, saveState, type KeeperState } from './state.js';
import { publicClient, scanDeposits, settle } from './evm.js';

const PIPS = 1_000_000n;
/** Covers the share value of one raw unit of rounding on each side of a conversion (6-decimal tokens: ~1e12). */
const ROUNDING_MARGIN = 10n ** 13n;
const MAX_FEE_BPS = 250; // ParityHook MAX_FEE_PIPS = 2500
/** Seal key servers read the Clock through their own full nodes; give the close time a moment to propagate. */
const SEAL_CLOCK_MARGIN_MS = 4_000;

/** unison_pay::pay::EDuplicateReceipt = 8 */
const isDuplicateReceipt = (e: unknown) => /abortCode\W+8\b|EDuplicateReceipt/.test(String((e as Error)?.message));

export type Receipt = { step: string; sui?: string; evm?: string; walrus?: string; detail?: Record<string, unknown> };

export class Keeper {
  readonly client: Client = suiClient();
  readonly seal = sealClient(this.client);
  readonly kp = loadKeypair();
  readonly dep: Deployment = loadDeployment();
  state: KeeperState;
  lastManifest: Manifest | null = null;

  constructor() {
    this.state = loadState(this.dep.sui.poolId);
    if (this.kp.toSuiAddress() !== this.dep.sui.operator) {
      throw new Error(`keeper key ${this.kp.toSuiAddress()} is not the pool operator ${this.dep.sui.operator}`);
    }
  }

  /** Escrow for in-flight withdrawals. Owned by the pool id, which has no key, so no wallet can ever decrypt or
   *  spend it, and the operator's own address stays free to hold a normal balance. */
  get escrow() {
    return normalizeSuiAddress(this.dep.sui.poolId);
  }

  balance(owner: string): bigint {
    return BigInt(this.state.balances[normalizeSuiAddress(owner)] ?? '0');
  }

  private add(owner: string, delta: bigint) {
    const o = normalizeSuiAddress(owner);
    const next = BigInt(this.state.balances[o] ?? '0') + delta;
    if (next < 0n) throw new Error(`negative balance for ${o}`);
    this.state.balances[o] = next.toString();
  }

  /** Sum of every leaf, including escrow; must equal the pool total at all times. */
  ledgerTotal(): bigint {
    return Object.values(this.state.balances).reduce((a, b) => a + BigInt(b), 0n);
  }

  private reload() {
    this.state = loadState(this.dep.sui.poolId);
  }

  // ---------------------------------------------------------------- roots

  /** Re-encrypts every leaf (fresh nonces, so unchanged balances are indistinguishable) and uploads the manifest. */
  async publishRoot(seq: number): Promise<{ root: Hex; manifestBlob: string; manifest: Manifest }> {
    const pkg = this.dep.sui.packageId;
    const pool = this.dep.sui.poolId;
    const cts = new Map<string, Uint8Array>();
    for (const [owner, bal] of Object.entries(this.state.balances)) {
      const leaf: Leaf = { v: 1, pool, owner, balance: bal, nonce: crypto.randomUUID(), seq };
      const { encryptedObject } = await this.seal.encrypt({
        threshold: SEAL_THRESHOLD,
        packageId: pkg,
        id: leafIdentity(owner, pool),
        data: encodeJson(leaf),
      });
      cts.set(owner, encryptedObject);
    }
    const manifest = buildManifest(pool, seq, BigInt(this.state.total), cts);
    const { blobId } = await walrusPut(encodeJson(manifest));
    this.lastManifest = manifest;
    return { root: manifest.root, manifestBlob: blobId, manifest };
  }

  // ---------------------------------------------------------------- deposits

  /** Credits every ShareVault.Deposited not yet attested, one credit_deposit per EVM event. */
  async creditDeposits(): Promise<Receipt[]> {
    const evm = this.dep.evm;
    if (!evm) return [];
    const pc = publicClient();
    const head = await pc.getBlockNumber();
    const from = BigInt(this.state.evmFromBlock ?? evm.startBlock);
    if (from > head) return [];
    const events = await scanDeposits(evm.shareVault, from, head);
    const receipts: Receipt[] = [];
    for (const ev of events) {
      const key = `evm:${evm.chainId}:${ev.txHash}:${ev.logIndex}`;
      if (this.state.credited.includes(key)) continue;
      const owner = normalizeSuiAddress(ev.suiRecipientTag);
      this.add(owner, ev.shares);
      this.state.total = (BigInt(this.state.total) + ev.shares).toString();
      this.state.credited.push(key);
      const seq = (await readPool(this.client, this.dep.sui.poolId)).batchSeq;
      const { root, manifestBlob } = await this.publishRoot(seq);
      try {
        const t = await execute(
          this.client,
          this.kp,
          rootWithReceiptTx('credit_deposit', this.dep.sui.packageId, this.dep.sui.poolId, this.dep.sui.operatorCapId, { root, manifestBlob, total: BigInt(this.state.total) }, key),
        );
        log(this.state, 'deposit.credited', { owner, shares: ev.shares.toString(), evmTx: ev.txHash, sui: t.digest, manifestBlob });
        saveState(this.state);
        receipts.push({ step: 'credit_deposit', sui: t.digest, evm: ev.txHash, walrus: manifestBlob, detail: { owner, shares: ev.shares.toString() } });
      } catch (e: any) {
        if (isDuplicateReceipt(e)) {
          // Credited on Sui before a crash lost the state write: the ledger change above is the correct one.
          log(this.state, 'deposit.already_credited', { owner, evmTx: ev.txHash });
          saveState(this.state);
          continue;
        }
        this.reload();
        throw e;
      }
    }
    this.state.evmFromBlock = (head + 1n).toString();
    saveState(this.state);
    return receipts;
  }

  // ---------------------------------------------------------------- windows

  async decryptEnvelope(batch: BatchState, env: EnvelopeState, sessionKey: Awaited<ReturnType<typeof sessionKeyFor>>): Promise<Uint8Array> {
    const ct = await walrusGet(env.blobId);
    const { id } = EncryptedObject.parse(ct);
    const txBytes = await sealApproveBatchTx(this.dep.sui.packageId, batch.batchId, [id]).build({ client: this.client, onlyTransactionKind: true });
    return this.seal.decrypt({ data: ct, sessionKey, txBytes });
  }

  /** Applies the current batch once its window has closed. Returns null when there is nothing to do yet. */
  async applyWindow(): Promise<Receipt | null> {
    const pool = await readPool(this.client, this.dep.sui.poolId);
    const batch = await readBatch(this.client, pool.currentBatch);
    if (batch.applied || batch.closesMs === 0 || Date.now() < batch.closesMs + SEAL_CLOCK_MARGIN_MS) return null;
    if (pool.paused) return null;

    const sessionKey = await sessionKeyFor(this.client, this.kp, this.dep.sui.packageId);
    const results: Record<string, unknown>[] = [];
    for (const env of batch.instructions) {
      const verdict = await this.applyEnvelope(batch, env, sessionKey);
      results.push({ index: env.index, payer: env.payer, commitment: env.commitment, ...verdict });
    }
    if (this.ledgerTotal() !== BigInt(this.state.total)) throw new Error('ledger total drifted from pool total');

    const { root, manifestBlob } = await this.publishRoot(batch.seq);
    try {
      const t = await execute(
        this.client,
        this.kp,
        applyBatchTx(this.dep.sui.packageId, this.dep.sui.poolId, batch.batchId, this.dep.sui.operatorCapId, { root, manifestBlob, total: BigInt(this.state.total) }),
      );
      this.state.lastAppliedSeq = batch.seq;
      log(this.state, 'batch.applied', { seq: batch.seq, instructions: batch.instructions.length, sui: t.digest, manifestBlob, root });
      saveState(this.state);
      return { step: 'apply_batch', sui: t.digest, walrus: manifestBlob, detail: { seq: batch.seq, root, results } };
    } catch (e) {
      this.reload();
      throw e;
    }
  }

  private async applyEnvelope(batch: BatchState, env: EnvelopeState, sessionKey: Awaited<ReturnType<typeof sessionKeyFor>>): Promise<Record<string, unknown>> {
    const reject = (reason: string, extra: Record<string, unknown> = {}) => {
      log(this.state, 'instruction.rejected', { seq: batch.seq, index: env.index, payer: env.payer, reason, ...extra });
      return { status: 'rejected', reason, ...extra };
    };
    if (this.state.seenCommitments.includes(env.commitment)) return reject('replayed commitment');
    let plain: Uint8Array;
    try {
      plain = await this.decryptEnvelope(batch, env, sessionKey);
    } catch (e: any) {
      return reject(`undecryptable: ${e?.constructor?.name ?? 'Error'} ${String(e?.message).slice(0, 80)}`);
    }
    if (commitmentOf(plain).toLowerCase() !== env.commitment.toLowerCase()) return reject('commitment mismatch');
    this.state.seenCommitments.push(env.commitment);

    let ins: Instruction;
    try {
      ins = decodeJson<Instruction>(plain);
    } catch {
      return reject('malformed instruction');
    }
    const payer = normalizeSuiAddress(env.payer);
    let shares: bigint;
    try {
      shares = BigInt(ins.shares);
    } catch {
      return reject('malformed shares');
    }
    if (shares <= 0n) return reject('non-positive shares');
    const available = this.balance(payer);

    if (ins.kind === 'pay') {
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(ins.to)) return reject('bad payee');
      if (shares > available) {
        // Double-spend rule: running balance at this instruction's position in the window.
        return reject('overdraft', { shares: shares.toString(), available: available.toString() });
      }
      this.add(payer, -shares);
      this.add(ins.to, shares);
      log(this.state, 'instruction.pay', { seq: batch.seq, index: env.index, payer, to: normalizeSuiAddress(ins.to), shares: shares.toString() });
      return { status: 'applied', kind: 'pay', to: normalizeSuiAddress(ins.to), shares: shares.toString() };
    }

    if (ins.kind === 'withdraw') {
      const evm = this.dep.evm;
      if (!evm) return reject('no EVM vault configured');
      if (!isAddress(ins.recipient) || !isAddress(ins.target)) return reject('bad EVM address');
      if (!evm.tokens.some((t) => t.address.toLowerCase() === ins.target.toLowerCase())) return reject('unsupported target issuer');
      const maxFeeBps = Number(ins.maxFeeBps);
      if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > MAX_FEE_BPS) return reject('bad maxFeeBps');
      // Gross-up reservation at the payer's fee ceiling; the unused part returns after settlement.
      const pips = BigInt(maxFeeBps) * 100n;
      const reserved = (shares * PIPS + (PIPS - pips) - 1n) / (PIPS - pips) + ROUNDING_MARGIN;
      if (reserved > available) return reject('overdraft', { shares: shares.toString(), reserved: reserved.toString(), available: available.toString() });
      this.add(payer, -reserved);
      this.add(this.escrow, reserved);
      this.state.pending.push({
        commitment: env.commitment as Hex,
        owner: payer,
        recipient: ins.recipient,
        target: ins.target,
        shares: shares.toString(),
        maxFeeBps,
        reserved: reserved.toString(),
        seq: batch.seq,
      });
      log(this.state, 'instruction.withdraw', { seq: batch.seq, index: env.index, payer, target: ins.target, shares: shares.toString(), reserved: reserved.toString() });
      return { status: 'escrowed', kind: 'withdraw', target: ins.target, shares: shares.toString(), reserved: reserved.toString() };
    }
    return reject('unknown kind');
  }

  // ---------------------------------------------------------------- withdrawals

  /** Settles every escrowed withdrawal on Unichain in one call, then debits (and restores skipped credit) on Sui. */
  async settlePending(): Promise<Receipt | null> {
    const evm = this.dep.evm;
    if (!evm || this.state.pending.length === 0) return null;
    const pending = [...this.state.pending];
    const seqs = [...new Set(pending.map((p) => p.seq))].join(',');
    const res = await settle(
      evm.shareVault,
      pending.map((p) => ({ commitment: p.commitment, recipient: p.recipient, targetIssuerToken: p.target, shares: BigInt(p.shares), maxFeeBps: BigInt(p.maxFeeBps) })),
      `unison-pay:${this.dep.sui.poolId}:batches:${seqs}`,
    );
    // From here the EVM side is final; record it before touching Sui so a crash cannot settle twice.
    const outcomes: Record<string, unknown>[] = [];
    let debited = 0n;
    for (const p of pending) {
      const reserved = BigInt(p.reserved);
      const s = res.settled.get(p.commitment.toLowerCase());
      this.add(this.escrow, -reserved);
      if (s) {
        let refund = reserved - s.sharesDebited;
        if (refund < 0n) {
          // Conversion cost more than the reservation (should not happen within the margin): take it from the owner.
          const extra = -refund;
          const take = extra > this.balance(p.owner) ? this.balance(p.owner) : extra;
          this.add(p.owner, -take);
          log(this.state, 'withdrawal.reservation_short', { commitment: p.commitment, extra: extra.toString(), taken: take.toString() });
          refund = 0n;
        }
        this.add(p.owner, refund);
        debited += s.sharesDebited;
        outcomes.push({ commitment: p.commitment, status: 'settled', sharesDebited: s.sharesDebited.toString(), amountOut: s.amountOut.toString(), refund: refund.toString() });
        log(this.state, 'withdrawal.settled', { commitment: p.commitment, owner: p.owner, sharesDebited: s.sharesDebited.toString(), refund: refund.toString(), evmTx: res.txHash });
      } else {
        this.add(p.owner, reserved);
        const reason = res.skipped.get(p.commitment.toLowerCase()) ?? '0x';
        outcomes.push({ commitment: p.commitment, status: 'skipped', reason, restored: reserved.toString() });
        log(this.state, 'withdrawal.skipped_restored', { commitment: p.commitment, owner: p.owner, restored: reserved.toString(), reason, evmTx: res.txHash });
      }
    }
    this.state.total = (BigInt(this.state.total) - debited).toString();
    this.state.pending = [];
    if (this.ledgerTotal() !== BigInt(this.state.total)) throw new Error('ledger total drifted after settlement');
    saveState(this.state);

    const seq = (await readPool(this.client, this.dep.sui.poolId)).batchSeq;
    const { root, manifestBlob } = await this.publishRoot(seq);
    const t = await execute(
      this.client,
      this.kp,
      rootWithReceiptTx('debit_withdrawal', this.dep.sui.packageId, this.dep.sui.poolId, this.dep.sui.operatorCapId, { root, manifestBlob, total: BigInt(this.state.total) }, `evm:${evm.chainId}:${res.txHash}`),
    );
    log(this.state, 'withdrawal.debited', { sui: t.digest, evmTx: res.txHash, debited: debited.toString(), manifestBlob });
    saveState(this.state);
    return { step: 'settle+debit_withdrawal', sui: t.digest, evm: res.txHash, walrus: manifestBlob, detail: { debited: debited.toString(), outcomes } };
  }

  /** One pass: attest deposits, apply a closed window, settle its withdrawals. */
  async tick(): Promise<Receipt[]> {
    const out: Receipt[] = [];
    out.push(...(await this.creditDeposits()));
    const applied = await this.applyWindow();
    if (applied) out.push(applied);
    const settled = await this.settlePending();
    if (settled) out.push(settled);
    return out;
  }
}
