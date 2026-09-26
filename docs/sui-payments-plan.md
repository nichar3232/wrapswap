# Unison Pay — Sui payments (Send)

Status: **shipped on testnet.** Sui testnet package + pool and a verified `ShareVault` on Unichain Sepolia (1301), driven by one keeper. Live IDs are in `deployments/sui-testnet.json` (Sui package, active `poolId`, `windowMs`, operator, Seal key servers and threshold, Walrus endpoints, `evm.shareVault`, retired pools and vaults) and `send.shareVault` in `deployments/unichain-sepolia.json`. This document describes what is deployed; §13 lists what was planned and not built. `INTERFACES.md` remains authoritative for the shared schema.

Target: Sui Stack **DeFi & Payments** bounty (payment flows, wallets and financial interfaces, vaults, automation, financial abstractions).

## 1. Scope

Hold and send tokenized equity as money, sized in shares. A user deposits an issuer wrapper on Unichain, pays another Sui address confidentially, and the recipient withdraws into either issuer's wrapper. No cash leg: no USDC, stablecoin or fiat rail. When the recipient wants the other issuer's wrapper, the vault converts share-for-share through the Uniswap v4 ParityHook pool.

## 2. Chain split

| Layer | Chain | What runs there |
| --- | --- | --- |
| Confidential credit ledger | Sui testnet | Move package `unison_pay` (`sui/unison_pay/sources/pay.move`): `Pool`, `Batch`, `OperatorCap` |
| Share custody and issuer conversion | Unichain Sepolia (1301) | `ShareVault` (`contracts/src/ShareVault.sol`) → `WrapSwapRouter` → ParityHook pool |
| Between them | Keeper attestation | `services/crank/sui/keeper.ts`; no bridge |

**Shares never leave Unichain.** The vault custodies the issuer tokens themselves (mcbAAPL and mAAPLx, the two currencies of the ParityHook pool key in the manifest) and tracks canonical shares (1e18 = one share); there is no intermediate canonical token. Sui holds credits against that custody.

## 3. Trust model and custody

1. `ShareVault` custodies issuer tokens. `sharesOutstanding` mirrors Sui `Pool.total_shares`; `sharesHeld()` values custody at live adapter ratios. Deposits credit shares rounded down, withdrawals debit rounded up.
2. One keeper attests deposits (`credit_deposit`) and settles withdrawals (`settleWithdrawals` on Unichain, then `debit_withdrawal` on Sui). Optimistic, single relayer. It holds the `OperatorCap` on Sui and is the vault's authorised keeper on Unichain (`evm.keeper` in the manifest).
3. **Solvency guard (enforced by the keeper).** Before each credit the keeper reads `ShareVault.reserves()` and refuses (logs `invariant.credit_refused`, retries next tick) any credit that would push Sui `total_shares` above vault `sharesHeld`. Each tick it also pauses the Sui pool if `total_shares > held` and resumes it once custody covers the total again.
4. EVM receipts (`evm:<chainId>:<tx>:<logIndex>`) are single-use on chain (`Pool.receipts`), so a deposit cannot be credited twice.
5. The keeper **can** see amounts (Tier B, §4).
6. Users cannot be debited without their own transaction: the Sui sender of `submit` is recorded as the payer.

## 4. Privacy: Tier B

On chain, the `Pool` exposes a total, a Merkle root and a pointer to a Walrus manifest. Balances and payment instructions are Seal-encrypted.

- **Leaves.** One Walrus manifest blob per root holds every owner's Seal-encrypted leaf `{v, pool, owner, balance, nonce, seq}`. Every root re-encrypts every leaf with a fresh nonce, so unchanged balances are indistinguishable from changed ones. Absent leaf = zero balance. A holder decrypts their own leaf via `seal_approve_leaf` and verifies the Merkle path against `entries_root`.
- **Instructions.** The payer Seal-encrypts `{kind: "pay", to, shares, memo?, nonce}` or `{kind: "withdraw", recipient, target, shares, maxFeeBps, nonce}` (`services/crank/sui/protocol.ts`) to the open batch's identity and stores it on Walrus; only the keccak commitment and blob id go on chain.

| | Hidden from public | Visible to keeper | Visible on chain |
| --- | --- | --- | --- |
| Individual balances | yes | yes | no, only the root |
| Payment amounts and payee | yes | yes | no |
| Payer of a submission | no (tx sender) | yes | yes |
| Which Sui addresses hold a leaf | no (manifest lists owners) | yes | via Walrus |
| That a batch was applied; pool total | no | — | yes |
| Deposits and withdrawals | no | yes | yes, ERC-20 transfers on Unichain |

**Confidential, not anonymous.** An internal payment leaves `total_shares` unchanged (asserted in Move), so anyone can check no value was created without learning amounts. The keeper must read amounts to prevent overdrafts; this is not zero-knowledge.

## 5. Move package `unison_pay`

Objects (see `pay.move` for the definitions):

- `Pool` (shared): `total_shares: u128`, `entries_root`, `manifest_blob` (Walrus blob id), `batch_seq`, `current_batch: ID`, `window_ms`, `operator`, `paused`, `receipts: Table`. `u128` because shares are 1e18-scaled.
- `Batch` (shared): `seq`, `opens_ms`, `closes_ms`, `instructions: vector<Envelope>`, `applied`. The window starts at the first `submit` (`closes_ms = first submit + window_ms`), so an idle pool costs no gas.
- `Envelope`: `commitment`, `blob_id`, `payer`.
- `OperatorCap`: authorises root updates for one pool.

Functions:

- `create_pool(window_ms)` — shares a Pool and its first Batch, returns the `OperatorCap`. `window_ms` is immutable per pool; the active pool uses `windowMs` from the manifest.
- `submit(pool, batch, commitment, blob_id, clock, ctx)` — any sender; rejects when paused, on a superseded batch, after window close, or with an empty commitment.
- `apply_batch(pool, batch, new_root, manifest_blob, new_total, cap, clock, ctx)` — requires window closed, `seq == batch_seq + 1`, and `new_total == total_shares`; opens the next Batch.
- `credit_deposit(...)` / `debit_withdrawal(...)` — raise / lower (or keep) the total with a single-use EVM receipt.
- `pause` / `resume` — `OperatorCap` only; `submit` and `apply_batch` abort while paused.

Seal policies (non-public `entry`, side-effect free, `id` first, abort on deny):

- `seal_approve_leaf(id, &Pool, ctx)` — identity `owner(32) || pool id(32) || nonce`; only the owner decrypts.
- `seal_approve_batch(id, &Batch, &Clock)` — identity `batch id(32) || nonce`; decryptable only once `closes_ms` has passed; idle batches deny.

Seal runs with the testnet open-mode key servers and threshold listed under `seal` in the manifest. 22 Move unit tests (`sui/unison_pay/tests/pay_tests.move`). One shared Batch per window: submissions serialise on it.

## 6. ShareVault (Unichain Sepolia)

`contracts/src/ShareVault.sol`, deployed by `contracts/script/DeployShareVault.s.sol` from `deployments/unichain-sepolia.resolved.json` (registry, router, pool key). The pool key is immutable, so each redeploy of the ParityHook pool required a new vault and a fresh Sui pool; retired pairs are listed in `deployments/sui-testnet.json`.

```
deposit(address issuerToken, uint256 amount, bytes32 suiRecipientTag) -> uint256 shares
settleWithdrawals(Withdrawal[] ws, bytes auth)                      // onlyKeeper
reserves() -> (uint256 held, uint256 outstanding)
quoteWithdrawal(address target, uint256 shares) -> (amountIn, sharesDebited, feePips, direct)
Withdrawal = (bytes32 commitment, address recipient, address targetIssuerToken, uint256 shares, uint256 maxFeeBps)
```

- `deposit` accepts only the two pool currencies and only while active in `IssuerRegistry`; pulls the token, adds its canonical-share value to `sharesOutstanding`, emits `Deposited(commitment, issuerToken, amount, shares, suiRecipientTag)`.
- `settleOne` (per withdrawal): if custody already holds enough of the target wrapper it transfers directly, **no conversion and no fee**. Otherwise it swaps the other issuer's token through `WrapSwapRouter.swapExactIn` on the ParityHook pool with the recipient as `recipient`, so the recipient receives face value and the swap pays the normal Convert fee (2 bps base + skew fee, to the LP). Gross-up starts from the hook's exact-output quote (hook-output rounding), then re-quotes the exact-input trade and tops up the input (up to 4 tries). It skips if the fee exceeds `maxFeeBps`, the quote is not fillable, or custody is short.
- Isolation: each withdrawal runs in `try this.settleOne(w)`; a failure emits `WithdrawalSkipped(commitment, reason)` and never reverts the batch. `WithdrawalSettled` reports `sharesDebited` (face shares for direct, `toSharesUp(amountIn)` for conversions).
- The vault does not check recipient eligibility (no EAS check); a gated wrapper that refuses delivery would surface as a skip.

## 7. Flows (as run by the keeper each tick)

**Deposit.** User calls `ShareVault.deposit` → keeper scans `Deposited` (re-reading a 300-block trailing window, since public RPC backends can lag) → solvency guard → re-encrypts all leaves, uploads the manifest to Walrus → `credit_deposit`.

**Payment (Sui only).** Payer encrypts a `pay` instruction, uploads to Walrus, calls `submit` → window closes → keeper waits a short Seal clock margin, decrypts via `seal_approve_batch`, checks commitments, and applies instructions strictly in submission order against the running balance (an overdraft at that point, or a replayed commitment, is rejected and logged) → publishes the new manifest → `apply_batch` with the total unchanged. Sending itself carries no protocol fee; only Sui gas.

**Withdraw.** The holder submits a sealed `withdraw` instruction in a window → at apply time the keeper moves `ceil(shares / (1 − maxFee)) + rounding margin` from the holder's leaf into an escrow leaf owned by the pool-id address (no key), so the total still does not change → `settleWithdrawals` on Unichain with an explicit gas limit (300k + 600k per withdrawal) → `debit_withdrawal` lowers the total by exactly the shares that left custody, refunds unused reservation, and restores any skipped withdrawal's credit in the same root. The keeper accepts `maxFeeBps` up to 100.

## 8. Solvency and proof of reserves

`GET /pay/reserves` (`api/src/routes/pay.ts`, no Postgres; reads Sui and Unichain directly) returns `{suiTotalShares, vaultShares, vaultSharesHeld, invariant, solvent, checkedBlock}` with `invariant = suiTotalShares == vaultShares && vaultSharesHeld >= vaultShares` and `solvent = suiTotalShares <= vaultSharesHeld`. Between `settleWithdrawals` and `debit_withdrawal` (seconds) `invariant` is briefly false; the Send panel shows "settling" rather than "1:1".

Everything else the UI needs (pool, current batch, manifest, own leaf) is read by the browser directly from a Sui fullnode (`SuiGrpcClient`; public testnet JSON-RPC is retired) and the Walrus aggregator.

## 9. Sui stack components

| Component | Job |
| --- | --- |
| Seal | `seal_approve_batch` (instructions readable only after window close, including by the keeper) and `seal_approve_leaf` (each balance readable only by its owner) |
| Walrus | Sealed instructions and one manifest per root (testnet publisher/aggregator in the manifest) |
| Clock | Window gating in `seal_approve_batch` and `apply_batch` |
| Move object model | Payer = tx sender; shared Batch per window; `OperatorCap` for root updates; single-use receipts table |
| dapp-kit (Slush) | Sui wallet connection, `SessionKey` personal-message signing, transaction signing in the Send panel |

## 10. User surfaces

- **Web Send panel** (`web/src/app/Send.tsx`, `SendOverview.tsx`): steps Deposit (Unichain) → Send (Sui, "sealed for {window} s · batching for privacy") → recipient Withdraw to either platform's wrapper, one primary action per step, a tracker with explorer links for every leg, Seal-decrypted balance, reserves chip. Amounts are entered in shares. Withdraw shows the vault quote (fee included) and is blocked above 100 bps. Demo mode (no injected wallet) simulates the legs while taking multipliers, fees and the window from live data. The UI does not collect a memo.
- **Relay** `POST /api/demo/send` (`services/relay/sui-send.ts`, see `DEMO.md`): runs deposit → sealed pay between two relay-owned Sui identities → sealed withdraw into the other issuer's wrapper; `GET /api/demo/send/<id>` follows the hashes. One send at a time.
- **MCP**: `send_confidential` is drafted (`packages/mcp/src/send.ts`) but **not exposed** (`packages/mcp/README.md`).

## 11. Verified live

From `~/wrapswap-run/status/sui.md` and `submission/sui-details.md`, on the active vault/pool pair: scripted `DEMO_CHECK=1` sui-demo 18/18, and a browser click-through of the Send panel: deposit → `credit_deposit` → sealed send → batch applied → payee decrypts own leaf → sealed withdraw → batch → cross-issuer delivery via WrapSwapRouter/ParityHook → `debit_withdrawal`, ending with reserves 1:1 and solvent. Transaction hashes are in `submission/sui-details.md`. The click-through harness injects stand-in wallets signing with the demo keys (headless Chromium cannot drive Slush/MetaMask); chains, Seal, Walrus and keeper are real. Also: ShareVault forge tests including a Unichain fork test against the live hook.

## 12. Disclosures and limits

1. **Custodial.** ShareVault holds the issuer tokens; Sui credits are claims.
2. **Operator visibility.** The keeper reads amounts and keeps a plaintext ledger off-repo. Not zero-knowledge.
3. **Not anonymous.** Payer is the visible tx sender; the manifest lists leaf owners; deposits/withdrawals are public ERC-20 movements; the boundary anonymity set is the withdrawal batch.
4. **Single keeper.** Enforces the solvency guard (§3) but can censor or delay.
5. **No share bridge.** Only credits (Sui) and issuer conversions (Unichain) move.
6. **Transfer restrictions unverified.** Native issuer behaviour could not be exercised on a generic node (`OpcodeNotFound`); mock tokens are used. A refused delivery skips and restores the credit.
7. **Relayer gas.** Because each withdrawal is inside `try/catch`, an `eth_estimateGas` limit can starve a conversion into a skip (observed once on 1301); the keeper sets explicit gas. No on-chain `gasleft()` floor.
8. **Testnet only.** Walrus has no public mainnet publisher; Seal servers are testnet open mode; tokens are mocks.
9. **Tax and regulation.** Paying with tokenized equity is jurisdiction-specific and not determined by the protocol.

## 13. Roadmap (not shipped)

Planned in earlier drafts of this document and not built:

- Nautilus: decrypt and apply inside an attested enclave so the keeper cannot read amounts ("operator-blind"); Tier C ZK overdraft proofs.
- zkLogin onboarding and sponsored gas for payees.
- Batch sharding (several parallel `Batch` objects per window).
- EAS eligibility check in `ShareVault` before delivering a gated wrapper.
- Postgres indexing (`pay_*` tables) and API routes `/pay/pool`, `/pay/batch/current`, `/pay/leaf/:addr`, `/pay/history/:addr` (removed; the browser reads Sui and Walrus directly).
- On-chain per-withdrawal `gasleft()` floor in a future vault revision.
- Recurring mandates, a cross-chain intent bridge, immediate (unbatched) withdrawals.
- Exposing `send_confidential` over MCP.
- Open design items: incremental Merkle structure (the root is rebuilt over all leaves each update), Seal liveness when the key-server threshold cannot be met mid-window.
