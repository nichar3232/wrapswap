#[test_only, allow(unused_variable)]
module unison_pay::pay_tests;

use sui::clock::{Self, Clock};
use sui::test_scenario::{Self as ts, Scenario};
use unison_pay::pay::{Self, Pool, Batch, OperatorCap};

const OP: address = @0xA11CE;
const PAYER: address = @0xB0B;
const WINDOW: u64 = 180_000;
const ONE: u128 = 1_000_000_000_000_000_000;

fun setup(): (Scenario, Clock) {
    let mut sc = ts::begin(OP);
    pay::create_pool_entry(WINDOW, sc.ctx());
    let mut clock = clock::create_for_testing(sc.ctx());
    clock.set_for_testing(1_000_000);
    sc.next_tx(OP);
    (sc, clock)
}

fun submit_as(sc: &mut Scenario, who: address, clock: &Clock, tag: u8) {
    sc.next_tx(who);
    let pool = sc.take_shared<Pool>();
    let mut batch = sc.take_shared_by_id<Batch>(pay::current_batch(&pool));
    pay::submit(&pool, &mut batch, vector[tag], vector[tag, tag], clock, sc.ctx());
    ts::return_shared(batch);
    ts::return_shared(pool);
}

fun credit(sc: &mut Scenario, total: u128, receipt: vector<u8>) {
    sc.next_tx(OP);
    let mut pool = sc.take_shared<Pool>();
    let cap = sc.take_from_sender<OperatorCap>();
    pay::credit_deposit(&mut pool, b"root-dep", b"manifest", total, receipt, &cap);
    sc.return_to_sender(cap);
    ts::return_shared(pool);
}

fun apply(sc: &mut Scenario, clock: &Clock, total: u128) {
    sc.next_tx(OP);
    let mut pool = sc.take_shared<Pool>();
    let mut batch = sc.take_shared_by_id<Batch>(pay::current_batch(&pool));
    let cap = sc.take_from_sender<OperatorCap>();
    pay::apply_batch(&mut pool, &mut batch, b"root-next", b"manifest-next", total, &cap, clock, sc.ctx());
    sc.return_to_sender(cap);
    ts::return_shared(batch);
    ts::return_shared(pool);
}

fun finish(sc: Scenario, clock: Clock) {
    clock.destroy_for_testing();
    sc.end();
}

#[test]
fun window_opens_on_first_submit_and_closes_after_window() {
    let (mut sc, mut clock) = setup();
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW - 1);
    submit_as(&mut sc, PAYER, &clock, 2); // still open
    sc.next_tx(OP);
    let pool = sc.take_shared<Pool>();
    let batch = sc.take_shared_by_id<Batch>(pay::current_batch(&pool));
    assert!(pay::closes_ms(&batch) == 1_000_000 + WINDOW);
    assert!(pay::instruction_count(&batch) == 2);
    ts::return_shared(batch);
    ts::return_shared(pool);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = pay::EWindowClosed)]
fun submit_after_close_aborts() {
    let (mut sc, mut clock) = setup();
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW);
    submit_as(&mut sc, PAYER, &clock, 2);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = pay::EWindowOpen)]
fun apply_before_close_aborts() {
    let (mut sc, mut clock) = setup();
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW - 1);
    apply(&mut sc, &clock, 0);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = pay::EWindowOpen)]
fun apply_idle_batch_aborts() {
    let (mut sc, clock) = setup();
    apply(&mut sc, &clock, 0);
    finish(sc, clock);
}

#[test]
fun apply_advances_seq_and_opens_next_batch() {
    let (mut sc, mut clock) = setup();
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW);
    apply(&mut sc, &clock, 0);
    sc.next_tx(OP);
    let pool = sc.take_shared<Pool>();
    assert!(pay::batch_seq(&pool) == 1);
    assert!(pay::entries_root(&pool) == b"root-next");
    let next = sc.take_shared_by_id<Batch>(pay::current_batch(&pool));
    assert!(pay::batch_seq_of(&next) == 2);
    assert!(!pay::applied(&next));
    ts::return_shared(next);
    ts::return_shared(pool);
    // the second window works the same way
    submit_as(&mut sc, PAYER, &clock, 3);
    clock.increment_for_testing(WINDOW);
    apply(&mut sc, &clock, 0);
    sc.next_tx(OP);
    let pool = sc.take_shared<Pool>();
    assert!(pay::batch_seq(&pool) == 2);
    ts::return_shared(pool);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = pay::EWrongBatch)]
fun superseded_batch_cannot_be_applied() {
    let (mut sc, mut clock) = setup();
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW);
    sc.next_tx(OP);
    let first = {
        let pool = sc.take_shared<Pool>();
        let id = pay::current_batch(&pool);
        ts::return_shared(pool);
        id
    };
    apply(&mut sc, &clock, 0);
    // an old batch is no longer the pool's current batch, so the seq order cannot be replayed
    sc.next_tx(OP);
    let mut pool = sc.take_shared<Pool>();
    let mut old = sc.take_shared_by_id<Batch>(first);
    let cap = sc.take_from_sender<OperatorCap>();
    pay::apply_batch(&mut pool, &mut old, b"x", b"y", 0, &cap, &clock, sc.ctx());
    abort 99
}

#[test]
fun total_unchanged_across_internal_batch() {
    let (mut sc, mut clock) = setup();
    credit(&mut sc, 5 * ONE, b"evm:1");
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW);
    apply(&mut sc, &clock, 5 * ONE);
    sc.next_tx(OP);
    let pool = sc.take_shared<Pool>();
    assert!(pay::total_shares(&pool) == 5 * ONE);
    ts::return_shared(pool);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = pay::ETotalChanged)]
fun internal_batch_that_changes_total_aborts() {
    let (mut sc, mut clock) = setup();
    credit(&mut sc, 5 * ONE, b"evm:1");
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW);
    apply(&mut sc, &clock, 5 * ONE + 1);
    finish(sc, clock);
}

#[test]
fun u128_total_holds_more_than_u64() {
    let (mut sc, clock) = setup();
    credit(&mut sc, 1_000_000 * ONE, b"evm:1"); // 1e24, far above u64::MAX
    sc.next_tx(OP);
    let pool = sc.take_shared<Pool>();
    assert!(pay::total_shares(&pool) == 1_000_000 * ONE);
    ts::return_shared(pool);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = pay::EDuplicateReceipt)]
fun deposit_receipt_is_single_use() {
    let (mut sc, clock) = setup();
    credit(&mut sc, 5 * ONE, b"evm:1");
    credit(&mut sc, 6 * ONE, b"evm:1");
    finish(sc, clock);
}

#[test]
fun withdrawal_debits_and_may_restore_everything() {
    let (mut sc, clock) = setup();
    credit(&mut sc, 5 * ONE, b"evm:1");
    sc.next_tx(OP);
    let mut pool = sc.take_shared<Pool>();
    let cap = sc.take_from_sender<OperatorCap>();
    pay::debit_withdrawal(&mut pool, b"r2", b"m2", 3 * ONE, b"evm:2", &cap);
    assert!(pay::total_shares(&pool) == 3 * ONE);
    // a settlement where every withdrawal skipped: total unchanged, credit restored in the root
    pay::debit_withdrawal(&mut pool, b"r3", b"m3", 3 * ONE, b"evm:3", &cap);
    assert!(pay::total_shares(&pool) == 3 * ONE);
    sc.return_to_sender(cap);
    ts::return_shared(pool);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = pay::ENotDecrease)]
fun withdrawal_cannot_raise_total() {
    let (mut sc, clock) = setup();
    credit(&mut sc, 5 * ONE, b"evm:1");
    sc.next_tx(OP);
    let mut pool = sc.take_shared<Pool>();
    let cap = sc.take_from_sender<OperatorCap>();
    pay::debit_withdrawal(&mut pool, b"r2", b"m2", 6 * ONE, b"evm:2", &cap);
    abort 99
}

#[test, expected_failure(abort_code = pay::ENotOperator)]
fun foreign_cap_is_rejected() {
    let (mut sc, clock) = setup();
    let first = {
        let p = sc.take_shared<Pool>();
        let id = object::id(&p);
        ts::return_shared(p);
        id
    };
    // a second pool's cap cannot drive the first pool
    sc.next_tx(PAYER);
    pay::create_pool_entry(WINDOW, sc.ctx());
    sc.next_tx(PAYER);
    let cap = sc.take_from_sender<OperatorCap>();
    let mut pool = sc.take_shared_by_id<Pool>(first);
    pay::pause(&mut pool, &cap);
    abort 99
}

#[test, expected_failure(abort_code = pay::EPaused)]
fun pause_blocks_submit() {
    let (mut sc, clock) = setup();
    sc.next_tx(OP);
    let mut pool = sc.take_shared<Pool>();
    let cap = sc.take_from_sender<OperatorCap>();
    pay::pause(&mut pool, &cap);
    assert!(pay::paused(&pool));
    sc.return_to_sender(cap);
    ts::return_shared(pool);
    submit_as(&mut sc, PAYER, &clock, 1);
    finish(sc, clock);
}

#[test]
fun resume_reopens_submit() {
    let (mut sc, clock) = setup();
    sc.next_tx(OP);
    let mut pool = sc.take_shared<Pool>();
    let cap = sc.take_from_sender<OperatorCap>();
    pay::pause(&mut pool, &cap);
    pay::resume(&mut pool, &cap);
    sc.return_to_sender(cap);
    ts::return_shared(pool);
    submit_as(&mut sc, PAYER, &clock, 1);
    finish(sc, clock);
}

// ---------------------------------------------------------------- Seal policies

fun leaf_id(owner: address, pool: &Pool): vector<u8> {
    let mut id = owner.to_bytes();
    id.append(object::id(pool).to_bytes());
    id.append(vector[7, 7, 7]);
    id
}

#[test]
fun seal_leaf_allows_owner() {
    let (mut sc, clock) = setup();
    sc.next_tx(PAYER);
    let pool = sc.take_shared<Pool>();
    pay::seal_approve_leaf_for_testing(leaf_id(PAYER, &pool), &pool, sc.ctx());
    ts::return_shared(pool);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = pay::ENoAccess)]
fun seal_leaf_denies_other_address() {
    let (mut sc, clock) = setup();
    sc.next_tx(OP); // even the operator cannot read a user's leaf
    let pool = sc.take_shared<Pool>();
    pay::seal_approve_leaf_for_testing(leaf_id(PAYER, &pool), &pool, sc.ctx());
    abort 99
}

#[test, expected_failure(abort_code = pay::ENoAccess)]
fun seal_leaf_denies_short_id() {
    let (mut sc, clock) = setup();
    sc.next_tx(PAYER);
    let pool = sc.take_shared<Pool>();
    pay::seal_approve_leaf_for_testing(PAYER.to_bytes(), &pool, sc.ctx());
    abort 99
}

fun batch_id(batch: &Batch): vector<u8> {
    let mut id = object::id(batch).to_bytes();
    id.append(vector[1, 2, 3, 4]);
    id
}

#[test]
fun seal_batch_allows_after_close() {
    let (mut sc, mut clock) = setup();
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW);
    sc.next_tx(OP);
    let pool = sc.take_shared<Pool>();
    let batch = sc.take_shared_by_id<Batch>(pay::current_batch(&pool));
    pay::seal_approve_batch_for_testing(batch_id(&batch), &batch, &clock);
    ts::return_shared(batch);
    ts::return_shared(pool);
    finish(sc, clock);
}

#[test, expected_failure(abort_code = pay::ENoAccess)]
fun seal_batch_denies_before_close() {
    let (mut sc, mut clock) = setup();
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW - 1);
    sc.next_tx(OP);
    let pool = sc.take_shared<Pool>();
    let batch = sc.take_shared_by_id<Batch>(pay::current_batch(&pool));
    pay::seal_approve_batch_for_testing(batch_id(&batch), &batch, &clock);
    abort 99
}

#[test, expected_failure(abort_code = pay::ENoAccess)]
fun seal_batch_denies_idle_batch() {
    let (mut sc, clock) = setup();
    sc.next_tx(OP);
    let pool = sc.take_shared<Pool>();
    let batch = sc.take_shared_by_id<Batch>(pay::current_batch(&pool));
    pay::seal_approve_batch_for_testing(batch_id(&batch), &batch, &clock);
    abort 99
}

#[test, expected_failure(abort_code = pay::ENoAccess)]
fun seal_batch_denies_identity_of_other_batch() {
    let (mut sc, mut clock) = setup();
    submit_as(&mut sc, PAYER, &clock, 1);
    clock.increment_for_testing(WINDOW);
    sc.next_tx(OP);
    let pool = sc.take_shared<Pool>();
    let batch = sc.take_shared_by_id<Batch>(pay::current_batch(&pool));
    let mut wrong = object::id(&pool).to_bytes();
    wrong.append(vector[1]);
    pay::seal_approve_batch_for_testing(wrong, &batch, &clock);
    abort 99
}
