/// Unison Pay: a confidential credit ledger for canonical equity shares (1e18 = one share).
///
/// On chain the Pool holds only the total and a Merkle root over Seal-encrypted per-owner leaves; the leaves
/// themselves live in one Walrus manifest blob per root. Payers append encrypted instructions to the open Batch;
/// once its window closes, Seal releases them to the operator (seal_approve_batch), who applies them off chain and
/// publishes the next root. Internal payments never change total_shares, which must equal the shares custodied by
/// ShareVault on Unichain. Confidential, not anonymous: the operator reads amounts.
module unison_pay::pay;

use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};

// ---------------------------------------------------------------- errors

const ENotOperator: u64 = 0;
const EPaused: u64 = 1;
const EWrongBatch: u64 = 2;
const EWindowClosed: u64 = 3;
const EWindowOpen: u64 = 4;
const EBadSeq: u64 = 5;
const ETotalChanged: u64 = 6;
const EAlreadyApplied: u64 = 7;
const EDuplicateReceipt: u64 = 8;
const ENotIncrease: u64 = 9;
const ENotDecrease: u64 = 10;
const ENoAccess: u64 = 11;
const EEmptyCommitment: u64 = 12;

const ADDRESS_LEN: u64 = 32;

// ---------------------------------------------------------------- objects

public struct Pool has key {
    id: UID,
    /// Sum of every credit; equals canonical shares held by ShareVault.
    total_shares: u128,
    /// Merkle root over leaf hashes (see services/crank/sui/merkle.ts); empty until the first credit.
    entries_root: vector<u8>,
    /// Walrus blob id of the manifest holding every encrypted leaf for entries_root.
    manifest_blob: vector<u8>,
    /// Sequence of the last applied batch.
    batch_seq: u64,
    /// The batch currently accepting submissions (seq = batch_seq + 1).
    current_batch: ID,
    window_ms: u64,
    operator: address,
    paused: bool,
    /// EVM receipts (chain event references) already credited or debited, so none is applied twice.
    receipts: Table<vector<u8>, bool>,
}

public struct OperatorCap has key, store {
    id: UID,
    pool: ID,
}

public struct Batch has key {
    id: UID,
    pool: ID,
    seq: u64,
    /// 0 until the first submission; the window runs from the first submission.
    opens_ms: u64,
    closes_ms: u64,
    instructions: vector<Envelope>,
    applied: bool,
}

public struct Envelope has store, drop, copy {
    /// Hash over the plaintext instruction.
    commitment: vector<u8>,
    /// Walrus blob holding the Seal-encrypted instruction.
    blob_id: vector<u8>,
    /// Transaction sender; amount and payee stay encrypted.
    payer: address,
}

// ---------------------------------------------------------------- events

public struct PoolCreated has copy, drop { pool: ID, cap: ID, operator: address, window_ms: u64 }
public struct BatchOpened has copy, drop { pool: ID, batch: ID, seq: u64 }
public struct Submitted has copy, drop { pool: ID, batch: ID, seq: u64, index: u64, payer: address, commitment: vector<u8>, blob_id: vector<u8> }
public struct BatchApplied has copy, drop { pool: ID, seq: u64, instructions: u64, root: vector<u8>, manifest_blob: vector<u8>, total_shares: u128 }
public struct DepositCredited has copy, drop { pool: ID, receipt: vector<u8>, amount: u128, total_shares: u128, root: vector<u8> }
public struct WithdrawalDebited has copy, drop { pool: ID, receipt: vector<u8>, amount: u128, total_shares: u128, root: vector<u8> }
public struct PauseChanged has copy, drop { pool: ID, paused: bool }

// ---------------------------------------------------------------- setup

/// Creates the shared Pool with its first (idle) Batch and hands the OperatorCap to the caller.
public fun create_pool(window_ms: u64, ctx: &mut TxContext): OperatorCap {
    let pool_uid = object::new(ctx);
    let pool_id = pool_uid.to_inner();
    let batch = new_batch(pool_id, 1, ctx);
    let batch_id = object::id(&batch);
    let pool = Pool {
        id: pool_uid,
        total_shares: 0,
        entries_root: vector[],
        manifest_blob: vector[],
        batch_seq: 0,
        current_batch: batch_id,
        window_ms,
        operator: ctx.sender(),
        paused: false,
        receipts: table::new(ctx),
    };
    let cap = OperatorCap { id: object::new(ctx), pool: pool_id };
    event::emit(PoolCreated { pool: pool_id, cap: object::id(&cap), operator: ctx.sender(), window_ms });
    event::emit(BatchOpened { pool: pool_id, batch: batch_id, seq: 1 });
    transfer::share_object(pool);
    transfer::share_object(batch);
    cap
}

entry fun create_pool_entry(window_ms: u64, ctx: &mut TxContext) {
    transfer::public_transfer(create_pool(window_ms, ctx), ctx.sender());
}

fun new_batch(pool: ID, seq: u64, ctx: &mut TxContext): Batch {
    Batch { id: object::new(ctx), pool, seq, opens_ms: 0, closes_ms: 0, instructions: vector[], applied: false }
}

// ---------------------------------------------------------------- payer

/// Appends a Seal-encrypted instruction to the open batch. The sender is recorded as the payer: Sui has no
/// allowance primitive, so every debit is authorised by the payer's own transaction.
public fun submit(
    pool: &Pool,
    batch: &mut Batch,
    commitment: vector<u8>,
    blob_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(!pool.paused, EPaused);
    assert!(batch.pool == object::id(pool) && pool.current_batch == object::id(batch), EWrongBatch);
    assert!(!batch.applied, EAlreadyApplied);
    assert!(!commitment.is_empty(), EEmptyCommitment);
    let now = clock.timestamp_ms();
    if (batch.opens_ms == 0) {
        batch.opens_ms = now;
        batch.closes_ms = now + pool.window_ms;
    };
    assert!(now < batch.closes_ms, EWindowClosed);
    let index = batch.instructions.length();
    event::emit(Submitted {
        pool: batch.pool,
        batch: object::id(batch),
        seq: batch.seq,
        index,
        payer: ctx.sender(),
        commitment,
        blob_id,
    });
    batch.instructions.push_back(Envelope { commitment, blob_id, payer: ctx.sender() });
}

// ---------------------------------------------------------------- operator

/// Applies a closed batch: advances the root and sequence and opens the next batch. Every instruction is an
/// internal move (payments, and withdrawals into the escrow leaf), so the total must not change.
public fun apply_batch(
    pool: &mut Pool,
    batch: &mut Batch,
    new_root: vector<u8>,
    manifest_blob: vector<u8>,
    new_total: u128,
    cap: &OperatorCap,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_cap(pool, cap);
    assert!(!pool.paused, EPaused);
    assert!(batch.pool == object::id(pool) && pool.current_batch == object::id(batch), EWrongBatch);
    assert!(!batch.applied, EAlreadyApplied);
    assert!(batch.seq == pool.batch_seq + 1, EBadSeq);
    assert!(batch.closes_ms != 0 && clock.timestamp_ms() >= batch.closes_ms, EWindowOpen);
    assert!(new_total == pool.total_shares, ETotalChanged);

    batch.applied = true;
    pool.batch_seq = batch.seq;
    pool.entries_root = new_root;
    pool.manifest_blob = manifest_blob;
    event::emit(BatchApplied {
        pool: object::id(pool),
        seq: batch.seq,
        instructions: batch.instructions.length(),
        root: new_root,
        manifest_blob,
        total_shares: new_total,
    });

    let next = new_batch(object::id(pool), batch.seq + 1, ctx);
    pool.current_batch = object::id(&next);
    event::emit(BatchOpened { pool: object::id(pool), batch: object::id(&next), seq: next.seq });
    transfer::share_object(next);
}

/// Raises the total against an attested ShareVault.Deposited event. `receipt` identifies that event
/// (chain id, tx hash, log index) and can be used only once.
public fun credit_deposit(
    pool: &mut Pool,
    new_root: vector<u8>,
    manifest_blob: vector<u8>,
    new_total: u128,
    receipt: vector<u8>,
    cap: &OperatorCap,
) {
    assert_cap(pool, cap);
    assert!(new_total > pool.total_shares, ENotIncrease);
    use_receipt(pool, receipt);
    let amount = new_total - pool.total_shares;
    set_root(pool, new_root, manifest_blob, new_total);
    event::emit(DepositCredited { pool: object::id(pool), receipt, amount, total_shares: new_total, root: new_root });
}

/// Lowers the total against an attested ShareVault settlement. The same root update returns the credit of any
/// WithdrawalSkipped entry from escrow to its owner, so `new_total` may equal the old total when everything skipped.
public fun debit_withdrawal(
    pool: &mut Pool,
    new_root: vector<u8>,
    manifest_blob: vector<u8>,
    new_total: u128,
    receipt: vector<u8>,
    cap: &OperatorCap,
) {
    assert_cap(pool, cap);
    assert!(new_total <= pool.total_shares, ENotDecrease);
    use_receipt(pool, receipt);
    let amount = pool.total_shares - new_total;
    set_root(pool, new_root, manifest_blob, new_total);
    event::emit(WithdrawalDebited { pool: object::id(pool), receipt, amount, total_shares: new_total, root: new_root });
}

public fun pause(pool: &mut Pool, cap: &OperatorCap) {
    assert_cap(pool, cap);
    pool.paused = true;
    event::emit(PauseChanged { pool: object::id(pool), paused: true });
}

public fun resume(pool: &mut Pool, cap: &OperatorCap) {
    assert_cap(pool, cap);
    pool.paused = false;
    event::emit(PauseChanged { pool: object::id(pool), paused: false });
}

fun assert_cap(pool: &Pool, cap: &OperatorCap) {
    assert!(cap.pool == object::id(pool), ENotOperator);
}

fun use_receipt(pool: &mut Pool, receipt: vector<u8>) {
    assert!(!pool.receipts.contains(receipt), EDuplicateReceipt);
    pool.receipts.add(receipt, true);
}

fun set_root(pool: &mut Pool, new_root: vector<u8>, manifest_blob: vector<u8>, new_total: u128) {
    pool.entries_root = new_root;
    pool.manifest_blob = manifest_blob;
    pool.total_shares = new_total;
}

// ---------------------------------------------------------------- Seal policies
// Evaluated by key servers through a dry run: non-public entry, side-effect free, `id` first, abort on deny.

/// Leaf identity = owner address (32 bytes) || pool id (32 bytes) || nonce. Only the owner may decrypt.
entry fun seal_approve_leaf(id: vector<u8>, pool: &Pool, ctx: &TxContext) {
    assert!(leaf_access(&id, pool, ctx.sender()), ENoAccess);
}

/// Instruction identity = batch id (32 bytes) || nonce. Anyone (in practice the operator) may decrypt once the
/// batch window has closed; nobody may before.
entry fun seal_approve_batch(id: vector<u8>, batch: &Batch, clock: &Clock) {
    assert!(batch_access(&id, batch, clock.timestamp_ms()), ENoAccess);
}

fun leaf_access(id: &vector<u8>, pool: &Pool, caller: address): bool {
    has_prefix(id, &caller.to_bytes(), 0) && has_prefix(id, &object::id(pool).to_bytes(), ADDRESS_LEN)
}

fun batch_access(id: &vector<u8>, batch: &Batch, now_ms: u64): bool {
    has_prefix(id, &object::id(batch).to_bytes(), 0) && batch.closes_ms != 0 && now_ms >= batch.closes_ms
}

fun has_prefix(id: &vector<u8>, want: &vector<u8>, offset: u64): bool {
    let n = want.length();
    if (id.length() < offset + n) return false;
    let mut i = 0;
    while (i < n) {
        if (id[offset + i] != want[i]) return false;
        i = i + 1;
    };
    true
}

// ---------------------------------------------------------------- views

public fun total_shares(pool: &Pool): u128 { pool.total_shares }
public fun entries_root(pool: &Pool): vector<u8> { pool.entries_root }
public fun batch_seq(pool: &Pool): u64 { pool.batch_seq }
public fun current_batch(pool: &Pool): ID { pool.current_batch }
public fun paused(pool: &Pool): bool { pool.paused }
public fun window_ms(pool: &Pool): u64 { pool.window_ms }
public fun batch_seq_of(batch: &Batch): u64 { batch.seq }
public fun closes_ms(batch: &Batch): u64 { batch.closes_ms }
public fun instruction_count(batch: &Batch): u64 { batch.instructions.length() }
public fun applied(batch: &Batch): bool { batch.applied }

#[test_only]
public fun seal_approve_leaf_for_testing(id: vector<u8>, pool: &Pool, ctx: &TxContext) { seal_approve_leaf(id, pool, ctx) }

#[test_only]
public fun seal_approve_batch_for_testing(id: vector<u8>, batch: &Batch, clock: &Clock) { seal_approve_batch(id, batch, clock) }
