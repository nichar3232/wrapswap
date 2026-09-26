// Sui-side reads and transaction builders for unison_pay. Browser-safe (used by the API and the /pay UI too).
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import type { ClientWithCoreApi } from '@mysten/sui/client';

const Envelope = bcs.struct('Envelope', {
  commitment: bcs.vector(bcs.u8()),
  blob_id: bcs.vector(bcs.u8()),
  payer: bcs.Address,
});
const PoolBcs = bcs.struct('Pool', {
  id: bcs.Address,
  total_shares: bcs.u128(),
  entries_root: bcs.vector(bcs.u8()),
  manifest_blob: bcs.vector(bcs.u8()),
  batch_seq: bcs.u64(),
  current_batch: bcs.Address,
  window_ms: bcs.u64(),
  operator: bcs.Address,
  paused: bcs.bool(),
  receipts: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
});
const BatchBcs = bcs.struct('Batch', {
  id: bcs.Address,
  pool: bcs.Address,
  seq: bcs.u64(),
  opens_ms: bcs.u64(),
  closes_ms: bcs.u64(),
  instructions: bcs.vector(Envelope),
  applied: bcs.bool(),
});

const hex = (b: number[] | Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const utf8 = (b: number[] | Uint8Array) => new TextDecoder().decode(Uint8Array.from(b));

export type PoolState = {
  poolId: string;
  totalShares: bigint;
  entriesRoot: string;
  manifestBlob: string;
  batchSeq: number;
  currentBatch: string;
  windowMs: number;
  operator: string;
  paused: boolean;
  receipts: number;
};
export type EnvelopeState = { index: number; commitment: string; blobId: string; payer: string };
export type BatchState = {
  batchId: string;
  pool: string;
  seq: number;
  opensMs: number;
  closesMs: number;
  applied: boolean;
  instructions: EnvelopeState[];
};

async function content(client: ClientWithCoreApi, objectId: string): Promise<Uint8Array> {
  const { object } = await client.core.getObject({ objectId, include: { content: true } });
  return object.content;
}

export async function readPool(client: ClientWithCoreApi, poolId: string): Promise<PoolState> {
  const p = PoolBcs.parse(await content(client, poolId));
  return {
    poolId: p.id,
    totalShares: BigInt(p.total_shares),
    entriesRoot: p.entries_root.length ? hex(p.entries_root) : '',
    manifestBlob: utf8(p.manifest_blob),
    batchSeq: Number(p.batch_seq),
    currentBatch: p.current_batch,
    windowMs: Number(p.window_ms),
    operator: p.operator,
    paused: p.paused,
    receipts: Number(p.receipts.size),
  };
}

export async function readBatch(client: ClientWithCoreApi, batchId: string): Promise<BatchState> {
  const b = BatchBcs.parse(await content(client, batchId));
  return {
    batchId: b.id,
    pool: b.pool,
    seq: Number(b.seq),
    opensMs: Number(b.opens_ms),
    closesMs: Number(b.closes_ms),
    applied: b.applied,
    instructions: b.instructions.map((e, index) => ({
      index,
      commitment: hex(e.commitment),
      blobId: utf8(e.blob_id),
      payer: e.payer,
    })),
  };
}

const bytes = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)));
const text = (s: string) => new TextEncoder().encode(s);

export function submitTx(pkg: string, poolId: string, batchId: string, commitment: string, blobId: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::pay::submit`,
    arguments: [
      tx.object(poolId),
      tx.object(batchId),
      tx.pure.vector('u8', bytes(commitment)),
      tx.pure.vector('u8', text(blobId)),
      tx.object.clock(),
    ],
  });
  return tx;
}

type RootUpdate = { root: string; manifestBlob: string; total: bigint };

export function applyBatchTx(pkg: string, poolId: string, batchId: string, capId: string, u: RootUpdate) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::pay::apply_batch`,
    arguments: [
      tx.object(poolId),
      tx.object(batchId),
      tx.pure.vector('u8', bytes(u.root)),
      tx.pure.vector('u8', text(u.manifestBlob)),
      tx.pure.u128(u.total),
      tx.object(capId),
      tx.object.clock(),
    ],
  });
  return tx;
}

export function rootWithReceiptTx(
  fn: 'credit_deposit' | 'debit_withdrawal',
  pkg: string,
  poolId: string,
  capId: string,
  u: RootUpdate,
  receipt: string,
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::pay::${fn}`,
    arguments: [
      tx.object(poolId),
      tx.pure.vector('u8', bytes(u.root)),
      tx.pure.vector('u8', text(u.manifestBlob)),
      tx.pure.u128(u.total),
      tx.pure.vector('u8', text(receipt)),
      tx.object(capId),
    ],
  });
  return tx;
}

/** PTB (transaction kind only) that Seal key servers dry-run to authorise decrypting batch instructions. */
export function sealApproveBatchTx(pkg: string, batchId: string, ids: string[]) {
  const tx = new Transaction();
  for (const id of ids) {
    tx.moveCall({
      target: `${pkg}::pay::seal_approve_batch`,
      arguments: [tx.pure.vector('u8', bytes(id)), tx.object(batchId), tx.object.clock()],
    });
  }
  return tx;
}

/** PTB that Seal key servers dry-run to authorise an owner decrypting their own leaf. */
export function sealApproveLeafTx(pkg: string, poolId: string, id: string) {
  const tx = new Transaction();
  tx.moveCall({ target: `${pkg}::pay::seal_approve_leaf`, arguments: [tx.pure.vector('u8', bytes(id)), tx.object(poolId)] });
  return tx;
}
