# Unison Pay — Sui payments plan v1

Status: **proposal, not implemented**. Nothing in this document is deployed, tested or verified on chain. It does not amend `INTERFACES.md`; the shipped workstream contract remains authoritative for everything that exists today. Every contract, module and endpoint below is new work.

Target: Sui Stack **DeFi & Payments** bounty. Qualification categories are payment flows, wallets and financial interfaces, vaults and capital allocators, automation systems, and financial abstractions for real users.

## 1. Scope

Hold and send tokenized equity as money. A user receives, holds and spends Apple shares without a cash leg at any point: no USDC, no stablecoin, no fiat rail. When a recipient wants the position in their own issuer's wrapper, the exit converts share-for-share through the existing Uniswap v4 ParityHook.

Deliberately out of scope for v1: recurring mandates, the Ethereum intent bridge, any bridge for share tokens, ZK balance proofs, and Nautilus attestation. Each is named in §14 with its upgrade path.

## 2. Chain split

Uniswap v4 is EVM-only, so the hooks cannot move. The split is therefore:

| Layer | Chain | Why |
| --- | --- | --- |
| Ledger of record for canonical shares | Sui | Payments are Move state transitions: no per-payment EVM gas, Seal privacy, zkLogin onboarding, sponsored gas |
| Issuer conversion and share custody | Unichain | `CanonicalStock`, `IssuerRegistry`, `ParityHook`, v4 pools, oracle, `NyseCalendar` |
| Between them | Keeper attestation | No bridge exists for tokenized share tokens; only credits and conversions cross, never the shares themselves |

Consequence worth stating plainly in any submission: **shares never leave Unichain.** Sui holds credits against Unichain-custodied uAAPL. This is why no share bridge is required, and it is also the source of the custody assumption in §3.

## 3. Trust model and custody

1. `ShareVault` on Unichain custodies uAAPL. Sui `Pool` credits are claims against that balance.
2. A single keeper attests deposits (Unichain → Sui credit) and executes withdrawals (Sui credit → Unichain issuer token). This is the same trust model already documented for the deferred intent bridge: **optimistic, single relayer.** Nautilus is the upgrade path (§14).
3. The keeper cannot create credits from nothing without breaking the solvency invariant in §8, which is publicly checkable.
4. The keeper **can** see payment amounts in Tier B (§4). This is the central privacy limitation and must be stated in the submission, not implied away.
5. Users cannot be debited without their signature. Sui has no allowance primitive, so every outbound instruction carries the payer's signature.

## 4. Privacy: Tier B

Three tiers were considered. Tier B is the build target.

- **Tier A — rejected.** Public balances and amounts on Sui, Seal-encrypted memo only. Too weak to call private.
- **Tier B — build target.** On-chain state is a total and a commitment root. Individual balances and transfers are encrypted off chain.
- **Tier C — future.** ZK overdraft proofs remove operator visibility entirely. Out of hackathon scope.

### Tier B state model

The `Pool` shared object stores exactly two pieces of material state:

- `total_shares: u128` — the sum of all credits, which must equal Unichain vault holdings.
- `entries_root: vector<u8>` — a Merkle root over encrypted per-user leaves.

Leaves live on Walrus, each Seal-encrypted. A leaf holds `{owner, balance, nonce}`. A user audits their own balance by fetching their leaf, decrypting it via Seal, and verifying the Merkle path against `entries_root`. Nobody else can read it.

### What is and is not hidden

| | Hidden from public | Visible to keeper | Visible on chain |
| --- | --- | --- | --- |
| Individual balances | yes | yes | no, only the root |
| Payment amounts | yes | yes | no |
| Payer/payee pairing | yes | yes | no |
| That a batch was applied | no | — | yes |
| Pool total | no | — | yes, by design (§8) |
| Deposits and withdrawals | no | yes | yes, on Unichain |

**The honest claim: confidential, not anonymous.** An internal transfer leaves `total_shares` unchanged, which is how the public verifies no value was created without seeing who paid whom. Deposits and withdrawals are visible on Unichain because they are real ERC-20 movements; unlinkability at the boundary comes from batching withdrawals, and the anonymity set is the batch size.

### Why the keeper sees amounts

Someone must verify a payer is not overdrawing. Verifying that requires reading the balance and the amount. Since the chain holds only a root, the verifier is the keeper. Tier C replaces the keeper's read with a proof. Do not describe Tier B as zero-knowledge.

## 5. Sui Move package `unison_pay`

### Objects

```move
public struct Pool has key {
    id: UID,
    total_shares: u128,
    entries_root: vector<u8>,
    batch_seq: u64,
    window_ms: u64,
    operator: address,
    paused: bool,
}

public struct Batch has key {
    id: UID,
    pool: ID,
    seq: u64,
    opens_ms: u64,
    closes_ms: u64,
    instructions: vector<Envelope>,
    applied: bool,
}

public struct Envelope has store, drop {
    commitment: vector<u8>,   // keccak over the plaintext instruction
    blob_id: vector<u8>,      // Walrus blob holding the Seal-encrypted instruction
    payer: address,           // signature origin; amount and payee stay encrypted
}
```

`u128` is required, not `u64`. Shares are 1e18-scaled throughout this repo, and `u64` overflows above roughly 18 whole shares.

### Entry functions

- `submit(pool, batch, commitment, blob_id, ctx)` — payer appends an encrypted instruction to the open batch. Records `payer` as the signer.
- `apply_batch(pool, batch, new_root, new_total, auth, clock, ctx)` — operator-authorized. Asserts the window has closed, `batch.seq == pool.batch_seq + 1`, and, for a batch containing only internal transfers, `new_total == pool.total_shares`. Advances the root and sequence.
- `credit_deposit(pool, new_root, new_total, unichain_receipt, auth, ctx)` — increases `total_shares` against an attested Unichain deposit.
- `debit_withdrawal(pool, new_root, new_total, unichain_receipt, auth, ctx)` — decreases it against an attested Unichain settlement.
- `pause(pool, ctx)` / `resume(pool, ctx)` — operator only; halts new batches without freezing audit reads.

### Seal access policy

Two clauses, both non-public `entry`, side-effect free, first parameter `id: vector<u8>`:

```move
entry fun seal_approve_leaf(id: vector<u8>, pool: &Pool, ctx: &TxContext)
entry fun seal_approve_batch(id: vector<u8>, batch: &Batch, clock: &Clock)
```

- `seal_approve_leaf` grants when the identity encodes the caller's own address, so a user reads only their own balance leaf. Aborts otherwise.
- `seal_approve_batch` grants once `clock.timestamp_ms() >= batch.closes_ms`, so the operator cannot read instructions early. Aborts before close.

Constraints imposed by Seal and designed around here:

- Key servers evaluate these via `dry_run_transaction_block`, so they must not mutate state and must not assume PTB composition.
- Seal's documentation cautions against policies that depend on frequently changing on-chain state, because propagation across full nodes takes time. **Batch windows are therefore minutes, not blocks** — 10 minutes is the proposed default, unlike the Unichain-side 20-block DarkCross batch. Do not tighten this to seconds.
- Threshold is `t` of `n` key servers; start at 2 of 3 on testnet.
- `Random` must not be used in policy logic.

### Shared-object contention

Every `submit` touches the same shared `Batch`, so submissions serialize on it. Shard into several parallel `Batch` objects per window and have the client pick one at random, or throughput collapses as soon as the demo shows more than a handful of concurrent payments.

## 6. Unichain contracts

New: `contracts/src/ShareVault.sol`.

```
deposit(address issuerToken, uint256 amount, bytes32 suiRecipientTag) -> uint256 uMinted
settleWithdrawals(Withdrawal[] calldata ws, bytes calldata auth)
reserves() -> (uint256 uHeld, uint256 suiTotalMirror)
sweepFees(Currency, address)
```

`Withdrawal = (bytes32 commitment, address recipient, address targetIssuerToken, uint256 shares, uint256 maxFeeBps)`.

`deposit` pulls the issuer token, mints uAAPL through `CanonicalStock`, retains it in vault custody, and emits `Deposited(commitment, issuerToken, amount, uMinted, suiRecipientTag)` for the keeper to attest.

`settleWithdrawals` settles through the deployed Unichain Sepolia `WrapSwapRouter`: one `swapExactIn` per withdrawal (min-out from the gross-up quote, chain-time deadline) converts uAAPL to the recipient's target issuer token at parity through the ParityHook pool, with the recipient as the router's `recipient`. This is the leg that keeps Uniswap on the critical path: every exit is a v4 swap filled from hook inventory via `beforeSwapReturnDelta`, degrading to the existing `ZERO_DELTA` fall-through and 50 bps peg guard when inventory is short.

Carried over from existing decisions, both of which will silently corrupt quotes if ignored:

- **Gross-up.** ParityHook charges its fee from output. A payment must deliver face value, so the withdrawal debits `shares + fee`, quoted from `feeBpsNow(issuer)`.
- **Rounding.** This repo keeps separate fee-rounding functions for hook output and vault redemption because they differ by one raw unit on dust. The withdrawal path uses the **hook-output** function.

Per-withdrawal isolation, following the `ResidualSkipped` precedent: a single failing withdrawal emits `WithdrawalSkipped(commitment, reason)` and its credit is restored on Sui. It must never revert the batch for everyone else.

Eligibility: before delivering a gated wrapper, verify the recipient's EAS attestation against the trusted attester, exactly as `DarkCrossHook` does, with `demoMode` to disable locally. An ineligible recipient is skipped with a legible reason, not silently dropped.

Off-hours: `NyseCalendar` does not block a withdrawal. ParityHook's off-hours fee component applies instead, so payments settle on weekends at a wider fee.

## 7. Flows

**Deposit.** User approves and calls `ShareVault.deposit` with their issuer token → uAAPL is minted into vault custody → keeper observes `Deposited` → `credit_deposit` raises `total_shares` and publishes a new root with the user's leaf incremented.

**Payment (Sui only, no Unichain transaction).** Payer encrypts `{payee, shares, memo}` under Seal, uploads to Walrus, calls `submit` with the commitment and blob id → window closes → `seal_approve_batch` now permits the operator → keeper decrypts, checks each payer's leaf for sufficient balance, computes the new leaf set and root → `apply_batch` with `new_total == total_shares`. Recipient sees the credit immediately after the batch applies, and can decrypt the memo.

**Withdraw to a brokerage.** User submits a withdrawal instruction naming their target issuer token → keeper batches the window's withdrawals → `settleWithdrawals` on Unichain converts uAAPL to each target wrapper at parity and transfers out → `debit_withdrawal` lowers `total_shares` and republishes the root.

No step in any of the three flows touches USDC, a stablecoin or fiat.

## 8. Solvency and proof of reserves

The invariant: `Pool.total_shares` equals uAAPL held by `ShareVault`, which in turn is backed per the existing `CanonicalStock.backing()` check.

Publish it. Extend the API with a cross-chain reserves endpoint that reads both sides and returns a boolean, and surface a red state in the UI when it breaks. This repo already computes and exposes a backing invariant, so the incremental cost is low — and for a custodial design it is not optional.

## 9. Sui stack components and the job each does

| Component | Job | Why it is not decoration |
| --- | --- | --- |
| Seal | Encrypt balance leaves and payment instructions; two on-chain access policies | Tier B's entire privacy property is the `seal_approve` pair |
| Walrus | Store encrypted leaves, instructions and receipts | Leaves must be retrievable by their owner and durable across batches |
| zkLogin | Recipient onboarding | A payee should not need a seed phrase to be paid |
| Sponsored transactions | Gas | A payee should not need SUI to be paid; the keeper sponsors |
| Clock | Batch window gating in `seal_approve_batch` | This is what stops early decryption |
| Move object model | Pool, batches, per-payer signatures | No allowance primitive exists, so instructions are signed, never pulled |

Nautilus is the named upgrade, not part of v1: run decryption and transition computation in an attested enclave, have `ShareVault` verify the enclave key, and the keeper stops being able to read amounts.

## 10. API additions

Same conventions as the existing surface: Fastify, GET only, no request body, chain integers as decimal strings, `{error}` with 400 on invalid input and 503 when chain or database is unavailable, never a fabricated success.

```
/pay/pool            -> {poolId,totalShares,entriesRoot,batchSeq,windowMs,paused}
/pay/batch/current   -> {seq,opensMs,closesMs,submitted,applied}
/pay/leaf/:addr      -> {blobId,merklePath:[...],root}   ciphertext only, never plaintext
/pay/history/:addr   -> [{seq,kind:"in"|"out"|"deposit"|"withdrawal",commitment,appliedMs}]
/pay/reserves        -> {suiTotalShares,unichainUHeld,invariant:boolean,checkedBlock}
```

`/pay/leaf/:addr` returns ciphertext and a proof path only. The server never holds plaintext balances; decryption happens in the client through Seal.

## 11. Postgres additions

Following existing conventions: `NUMERIC(78,0)` for chain integers, `TEXT` for hashes and addresses, per-event unique keys, and reorg cleanup from the raw journal.

```
pay_batches(seq NUMERIC PRIMARY KEY, pool TEXT, opens_ms NUMERIC, closes_ms NUMERIC,
            applied BOOLEAN, root TEXT, total_shares NUMERIC, sui_digest TEXT)
pay_envelopes(seq NUMERIC, commitment TEXT, payer TEXT, blob_id TEXT,
              status TEXT CHECK(status IN ('submitted','applied','skipped')),
              PRIMARY KEY(seq,commitment))
pay_withdrawals(commitment TEXT PRIMARY KEY, recipient TEXT, target_token TEXT,
                shares NUMERIC, unichain_tx TEXT, log_index INTEGER, skipped_reason TEXT)
pay_reserves(checked_block NUMERIC PRIMARY KEY, sui_total NUMERIC, unichain_held NUMERIC,
             invariant BOOLEAN)
```

## 12. UI

Three screens, added alongside the existing tabs:

1. **Balance** — share balance decrypted client-side, reserves badge from `/pay/reserves`.
2. **Send** — payee address, amount in shares or dollars at the oracle price, optional memo, next-window countdown from `/pay/batch/current`.
3. **Withdraw to brokerage** — target issuer selected from the registry, quoted gross-up fee, eligibility state.

zkLogin sign-in sits alongside the existing wallet selector. The public burner keys stay restricted to localhost manifests, as already decided.

## 13. External API notes, verified 2026-09-26

Seal, per `docs.sui.io/sui-stack/seal/using-seal`:

- `seal_approve*` is a non-public `entry` function; first parameter is the identity `id: vector<u8>`, excluding the package-ID prefix that Seal prepends.
- It must be side-effect free, must not assume PTB composition, and must abort rather than return when access is denied.
- Key servers evaluate it through `dry_run_transaction_block`.
- Policies should not depend on rapidly changing on-chain state. This is why batch windows here are minutes.
- Client flow: `SealClient` with `serverConfigs`, `encrypt({threshold, packageId, id, data})`, `SessionKey.create({address, packageId, ttlMin})` signed as a personal message, then `decrypt({data, sessionKey, txBytes})`, with `fetchKeys` for batches.

Walrus, per `docs.wal.app`:

- `PUT /v1/blobs` on a publisher, with `epochs`, `permanent` and `deletable` query parameters.
- First upload returns `newlyCreated` with a blob ID and a Sui object ID; a repeat returns `alreadyCertified`.
- **No public mainnet publisher exists.** Testnet accepts unauthenticated uploads, so the demo is testnet-only. Say so rather than implying a mainnet path.

Re-verify both before implementation. These surfaces move quickly.

## 14. Disclosures and limits

To be reproduced in the submission, in the same register as the existing ground-truth table:

1. **Custody.** The Unichain vault holds the shares; Sui credits are claims. This is a custodial design.
2. **Operator visibility.** Tier B hides amounts from the public, not from the keeper. Nautilus removes this; v1 does not include it.
3. **Not anonymous.** Internal transfers are unlinkable to the public; deposits and withdrawals are visible on Unichain, and the anonymity set at the boundary is the withdrawal batch size.
4. **Single relayer.** Deposit and withdrawal attestation is optimistic with one keeper, as already documented for the deferred bridge.
5. **No share bridge.** Shares never cross chains. Only credits and issuer conversions do.
6. **Transfer restrictions unverified.** Native B20 behavior on a generic node returned `OpcodeNotFound`, including an attempted holder transfer, and that does not prove transfers are allowlisted. Mocks are used. Delivering a gated wrapper to an arbitrary recipient may fail in production.
7. **Testnet only.** Walrus has no public mainnet publisher. The EVM side runs on Unichain Sepolia (1301), where WrapSwap is deployed and verified; `ShareVault` itself is not yet deployed.
8. **Tax and regulation.** Paying with tokenized equity is jurisdiction-specific and is not determined by the protocol. Transferring a security as payment is not the same regulated activity as trading it.

## 15. Build order and cut lines

1. `ShareVault.sol`: deposit, batched `settleWithdrawals` through the parity pool, per-withdrawal isolation, gross-up, hook-output rounding. Testable on the local anvil stack with the existing suite, then deployed to Unichain Sepolia.
2. Move package: `Pool`, `Batch`, `submit`, `apply_batch`, both `seal_approve` clauses. Sui testnet is free.
3. Keeper: a Sui client in `services/crank` alongside the Unichain one — watch windows, decrypt, verify balances, compute the root, apply, attest deposits and withdrawals.
4. API, schema, reserves endpoint.
5. UI three screens, zkLogin, sponsored gas.
6. Cuts, in this order: Nautilus, recurring mandates, batch sharding, dollar-denominated send.

Minimum end-to-end demo: deposit an issuer wrapper on Unichain, pay a second user privately on Sui with nothing but a root change, then have that user withdraw into a **different** issuer's wrapper through the parity pool. That single path demonstrates the whole thesis, and it must exist before anything in step 6 is attempted.

## 16. Demo sequence

Extends the existing `make demo` shape rather than replacing it.

1. Existing Unichain Sepolia deployment and seed (`deployments/unichain-sepolia.json`) — unchanged, plus `ShareVault` deploy and inventory; the anvil stack remains the offline fallback.
2. Publish the Move package to Sui testnet; write the package ID and pool object ID into the deployment manifest next to the Unichain addresses.
3. Register key servers and the Walrus publisher endpoint in ignored env, never in the repository.
4. Scripted flow with printed receipts at every step: two deposits, one private payment, one cross-issuer withdrawal, one deliberately ineligible withdrawal proving `WithdrawalSkipped` restores the credit.
5. Assert the reserves invariant before and after, and assert `total_shares` is unchanged across the private payment.
6. `DEMO_CHECK=1` finite smoke path, and a clean-clone repeat, matching existing practice.

## 17. Bounty mapping

| Category | Satisfied by |
| --- | --- |
| Payment flows | Private user-to-user share payment on Sui, plus cross-issuer delivery on withdrawal. No cash leg at any point. |
| Vaults and capital allocators | `ShareVault` custody on Unichain and the Sui `Pool` as the credit ledger; ParityHook's ERC-6909 claim inventory is what makes parity exits possible. |
| Automation systems | Window-driven batch application and settlement by the permissionless crank; no user action between submission and settlement. |
| Wallets and financial interfaces | zkLogin onboarding, sponsored gas, client-side decrypted balance, Walrus receipts. |
| Financial abstractions for real users | "Send Bob three Apple shares." Wrappers, share multipliers, decimals, parity math, batching and chain boundaries are all invisible. |

The bounty asks for systems that move, manage and transform money. Move: the private payment. Manage: the credit pool and vault. Transform: share-for-share issuer conversion through Uniswap v4.

## 18. Open questions

1. Merkle leaf format and whether an absent leaf is a zero balance or an error. Affects first-deposit handling.
2. Whether `submit` should escrow the payer's credit at submission time to stop double-spending inside one window, or whether keeper-side ordering is sufficient. Escrow is safer and costs a second root update.
3. Key-server selection and what happens to liveness when the threshold cannot be met mid-window.
4. Whether withdrawals should be allowed to skip the window and settle immediately at a higher fee, trading the anonymity set for latency.
5. Leaf-set growth: rebuilding the full root each window is O(users) and will need an incremental structure before it is realistic.
