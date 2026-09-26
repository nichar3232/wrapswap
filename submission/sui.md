# Unison Pay — Sui Stack "DeFi & Payments" submission

## Pitch

**Send Bob three Apple shares.**

Tokenized equity is already money-shaped. Unison Pay lets you hold Apple shares, pay someone with them and let them cash out into whichever brokerage's wrapper they use. There is no cash leg at any point: no USDC, no stablecoin, no fiat rail.

- **Confidential payments on Sui.** Balances and payment amounts are Seal-encrypted. On chain, the Pool publishes only a total and a Merkle root. An internal payment changes the root and leaves the total unchanged, so anyone can check that no value was created without learning who paid whom.
- **Cross-issuer delivery through Uniswap v4 on Unichain.** Deposits are real issuer tokens (Coinbase-style `mcbAAPL`, xStocks-style `mAAPLx`) held in a ShareVault on Unichain Sepolia. When Bob withdraws into the *other* issuer's wrapper, the vault converts share-for-share through the Unison ParityHook pool, grossed up so Bob receives face value.

The honest claim is **confidential, not anonymous**. The keeper that applies each batch can see amounts (see Disclosures).

## Architecture

```
 Unichain Sepolia (1301)                          Sui testnet
 ───────────────────────                          ───────────
 wallet A ─ mcbAAPL ─┐                             Pool (shared)
 wallet B ─ mAAPLx ──┤ deposit()                     total_shares : u128   ── must equal ──┐
                     ▼                               entries_root : Merkle root            │
               ShareVault ── Deposited ──► keeper ─► credit_deposit(root', total')         │
               sharesOutstanding ◄───────────────────────────────────────────────────────── ┘
                     ▲                               Batch (shared, 90 s window)
                     │                               submit(commitment, walrus blob id)  ◄── payer (A)
 settleWithdrawals() │                                     │ window closes
   direct transfer   │                                     ▼ seal_approve_batch (Clock)
   or WrapSwapRouter │ ◄── keeper ◄── decrypt, check balances in submission order
   → ParityHook pool │                   │ apply_batch(root', total' == total)
   WithdrawalSkipped │                   │ debit_withdrawal(root', total'' ≤ total)
                     │                   ▼
                     │            Walrus: sealed instructions + one manifest per root
                     │                   (every leaf Seal-encrypted to its owner)
                     │                   ▲
                     └──── payee's wallet: seal_approve_leaf → decrypt own leaf,
                                         verify Merkle path against entries_root
```

1. **Deposit.** A user calls `ShareVault.deposit(issuerToken, amount, suiAddress)` on Unichain. The vault pulls the issuer token into custody, values it in canonical shares (1e18 = one share) with the issuer's multiplier adapter, and emits `Deposited`. The keeper attests the event on Sui with `credit_deposit`. The receipt `evm:1301:<tx>:<logIndex>` is single-use on chain.
2. **Pay.** The payer Seal-encrypts `{payee, shares, memo}` to the open batch's identity, stores the ciphertext on Walrus and calls `submit`. The Sui transaction sender is the payer, because Sui has no allowance primitive and nothing is ever pulled from an account. Once the 90 s window closes, `seal_approve_batch` lets the keeper decrypt. The keeper applies instructions in submission order, recomputes every leaf, re-encrypts each to its owner, uploads the manifest to Walrus and calls `apply_batch`. The Move code asserts `new_total == total_shares`.
3. **Withdraw.** A withdrawal is a sealed instruction as well. At apply time the keeper moves `shares ÷ (1 − maxFee)` into an escrow leaf, so the batch total still doesn't move. It then calls `ShareVault.settleWithdrawals` on Unichain. Each withdrawal either transfers directly when custody holds the target wrapper, or swaps the other issuer's token through `WrapSwapRouter.swapExactIn` on the ParityHook pool. That swap is priced from the hook's own exact-output quote, which uses hook-output rounding. Every withdrawal runs in its own `try/catch`: a failure emits `WithdrawalSkipped(commitment, reason)` and never reverts the batch. The keeper then calls `debit_withdrawal`. The total drops by exactly the shares that left custody; unused fee reservation is refunded; a skipped withdrawal's credit returns to its owner in the same root.
4. **Audit.** `/pay` is one page with three steps, Deposit (Unichain, MetaMask) → Pay (Sui, Slush) → Withdraw (Unichain), and it reads Sui directly from a fullnode. `GET /pay/reserves` reads both chains and returns `invariant: suiTotalShares == vaultShares && vaultSharesHeld >= vaultShares`. The `/pay` UI shows it as a badge next to your Seal-decrypted balance.

## Sui components and the job each does

| Component | Job | Where |
| --- | --- | --- |
| **Move package `unison_pay`** | `Pool` (u128 total, Merkle root, Walrus manifest pointer, single-use EVM receipts), `Batch` (window, envelopes), `OperatorCap`. `submit`, `apply_batch`, `credit_deposit`, `debit_withdrawal`, `pause`, `resume`. `apply_batch` enforces window close, sequence order and an unchanged total. | `sui/unison_pay/sources/pay.move`, 22 Move unit tests |
| **Seal** | Two access policies make up the whole privacy property. `seal_approve_batch(id, &Batch, &Clock)` releases payment instructions only after the window closes, so not even the keeper can read them early. `seal_approve_leaf(id, &Pool, ctx)` releases a balance leaf only to the address it encodes. Threshold 2 of 3 open testnet key servers. | `pay.move`, `services/crank/sui/{keeper,payer}.ts`, `web/src/pay/PayApp.tsx` |
| **Walrus** | Stores every sealed payment instruction and one manifest per root holding all encrypted leaves. Holders fetch their own leaf and Merkle path from it. | `services/crank/sui/lib.ts` |
| **Clock** | Window gating inside `seal_approve_batch` and `apply_batch`. | `pay.move` |
| **Move object model** | Payer = transaction sender (no allowances), a shared Batch per window, and `OperatorCap` as the capability for root updates. | `pay.move` |
| **dapp-kit (Slush)** | Sui wallet connection, personal-message signing for the Seal `SessionKey`, and transaction signing on `/pay`. Reads and execution go through `SuiGrpcClient` (public JSON-RPC is retired on testnet). | `web/src/pay/PayApp.tsx` |

On the EVM side, `ShareVault.sol` holds custody on Unichain Sepolia and settles through the existing `WrapSwapRouter` → Uniswap v4 `PoolManager` → `ParityHook`.

## IDs and addresses

Sui testnet (package published by `0xb07be57ee7e7d5ca43f681c6938cc8698fd892b42d1b33f613909ae585c741c7`, which is also the keeper):

| Object | ID |
| --- | --- |
| Package `unison_pay` | [`0x2f18fa6d27e46235a4dcb9c0de62adbf612e3f60700ffeeac4e13d50ea4f452c`](https://suiscan.xyz/testnet/object/0x2f18fa6d27e46235a4dcb9c0de62adbf612e3f60700ffeeac4e13d50ea4f452c) (publish tx [`CNfNqe3P…`](https://suiscan.xyz/testnet/tx/CNfNqe3P3ni7NkpknM3p1KMhqhV2hBeS2WcoLKo4Ugdt)) |
| Pool (demo, 90 s window) | [`0xd04f7ee675e0c7c239532a2f59ec070ab3d26bbf8bc987067d4d45c9b049482c`](https://suiscan.xyz/testnet/object/0xd04f7ee675e0c7c239532a2f59ec070ab3d26bbf8bc987067d4d45c9b049482c) |
| OperatorCap | [`0xe76b61a7344b47dbed90aa617799f2c49b269aa08b94f42ed9a40a00c87d7e78`](https://suiscan.xyz/testnet/object/0xe76b61a7344b47dbed90aa617799f2c49b269aa08b94f42ed9a40a00c87d7e78) |
| Retired pool (180 s, never credited) | [`0xa1e1a8262c772c99fab34f0a389cfec6ed6f966889d4c9b3674313ccc16007e7`](https://suiscan.xyz/testnet/object/0xa1e1a8262c772c99fab34f0a389cfec6ed6f966889d4c9b3674313ccc16007e7) |
| Seal probe package | [`0xebb8a7e3ae227d2b3bc9f52934a2b0003ad93da11cc66e018888412aef654d32`](https://suiscan.xyz/testnet/object/0xebb8a7e3ae227d2b3bc9f52934a2b0003ad93da11cc66e018888412aef654d32) |

Seal key servers (testnet, open mode, threshold 2): mysten-testnet-1 `0x73d05d62…6db75`, mysten-testnet-2 `0xf5d14a81…623c8`, Ruby Nodes `0x6068c0ac…41da2` ([docs.sui.io/sui-stack/seal/pricing](https://docs.sui.io/sui-stack/seal/pricing)).
Walrus testnet: publisher `https://publisher.walrus-testnet.walrus.space`, aggregator `https://aggregator.walrus-testnet.walrus.space`.

Unichain Sepolia (1301):

| Contract | Address |
| --- | --- |
| ShareVault | [`0x275C82B932D4703F0e8A104524bC24813a5c3187`](https://sepolia.uniscan.xyz/address/0x275C82B932D4703F0e8A104524bC24813a5c3187#code) (verified) |
| WrapSwapRouter | [`0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3`](https://sepolia.uniscan.xyz/address/0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3#code) |
| ParityHook | [`0x1D2C9335813B8d3fFDCCC9d43aAf73d7871b20c8`](https://sepolia.uniscan.xyz/address/0x1D2C9335813B8d3fFDCCC9d43aAf73d7871b20c8#code) |
| mcbAAPL (mock, 6 dec, 1.0125 shares/token) | [`0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c`](https://sepolia.uniscan.xyz/address/0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c) |
| mAAPLx (mock, 18 dec, 1.0 share/token) | [`0x433DAfF77AD96b9319957D83d9d422E70c996C45`](https://sepolia.uniscan.xyz/address/0x433DAfF77AD96b9319957D83d9d422E70c996C45) |

All IDs are also in [`deployments/sui-testnet.json`](../deployments/sui-testnet.json).

### Demo accounts

| Role | Chain | Address | Key |
| --- | --- | --- | --- |
| Payer (also pool operator / keeper) | Sui testnet | [`0xb07be57ee7e7d5ca43f681c6938cc8698fd892b42d1b33f613909ae585c741c7`](https://suiscan.xyz/testnet/account/0xb07be57ee7e7d5ca43f681c6938cc8698fd892b42d1b33f613909ae585c741c7) | Sui CLI keystore on the demo machine |
| Payee | Sui testnet | [`0x490aca12124d8cc2bdf1eb007a9cca8fa0dfe60ffed4908c3cbf8a990fdfc4c9`](https://suiscan.xyz/testnet/account/0x490aca12124d8cc2bdf1eb007a9cca8fa0dfe60ffed4908c3cbf8a990fdfc4c9) | Sui CLI keystore, alias `unison-payee` (`sui keytool export --key-identity unison-payee` → import into Slush) |
| Depositor (MetaMask) | Unichain Sepolia | [`0x90d2d9C4966e81D1D8c50f3aaD51b3F9299f7612`](https://sepolia.uniscan.xyz/address/0x90d2d9C4966e81D1D8c50f3aaD51b3F9299f7612) | `DEMO_MNEMONIC` index 1 |
| Withdrawal recipient (script) | Unichain Sepolia | [`0x588e53E014c69df42a0adbc5d65009e5CBff0f1A`](https://sepolia.uniscan.xyz/address/0x588e53E014c69df42a0adbc5d65009e5CBff0f1A) | `DEMO_MNEMONIC` index 2 |

No key is in the repository. The payee was funded with 0.1 SUI from the payer ([tx](https://suiscan.xyz/testnet/tx/BhEHYEDKswpSkXPZKezHFTqYhWKMFmb5XnAY9t7ncHco)) because the testnet faucet API rate-limited every request from the demo machine.

## Running it

```sh
pnpm dev:sui-keeper                       # long-lived keeper: credits deposits, applies windows, settles withdrawals
pnpm dev:pay-api                          # GET /pay/reserves on :5403 (the full API registers the same route)
API_PORT=5403 WEB_PORT=5402 pnpm dev:web  # then open http://127.0.0.1:5402/pay
DEMO_CHECK=1 scripts/dev/sui-demo         # scripted end-to-end check (stop the keeper first: one process per pool)
```

Secrets come from `~/wrapswap-run/env/onchain.env` (`DEPLOYER_PRIVATE_KEY` is the ShareVault keeper, `DEMO_MNEMONIC`); the keeper's plaintext ledger lives in `~/wrapswap-run/sui-state/`.

## Demo receipts

### Scripted end-to-end run

Run: `DEMO_CHECK=1 scripts/dev/sui-demo`, 2026-09-26T13:05:52.515Z (DEMO_CHECK=1), Sui testnet + Unichain Sepolia. Full log: `~/wrapswap-run/logs/sui-demo-pass.log`.

- Sui package: [`0x2f18fa6d27…`](https://suiscan.xyz/testnet/object/0x2f18fa6d27e46235a4dcb9c0de62adbf612e3f60700ffeeac4e13d50ea4f452c)
- Pool: [`0xd04f7ee675…`](https://suiscan.xyz/testnet/object/0xd04f7ee675e0c7c239532a2f59ec070ab3d26bbf8bc987067d4d45c9b049482c)
- ShareVault: [`0x275C82B932…`](https://sepolia.uniscan.xyz/address/0x275C82B932D4703F0e8A104524bC24813a5c3187)
- Wallet A: sui 0xb07be57ee7e7d5ca43f681c6938cc8698fd892b42d1b33f613909ae585c741c7 / evm 0x90d2d9C4966e81D1D8c50f3aaD51b3F9299f7612
- Wallet B: sui 0x490aca12124d8cc2bdf1eb007a9cca8fa0dfe60ffed4908c3cbf8a990fdfc4c9 / evm 0x588e53E014c69df42a0adbc5d65009e5CBff0f1A

**1. Setup and reserves before**

- reserves before
  - suiTotalShares: 13.050000
  - vaultSharesOutstanding: 13.050000
  - vaultSharesHeld: 13.050000
  - checkedBlock: 63575525
- **PASS** Sui total_shares == ShareVault.sharesOutstanding (before)
- **PASS** ShareVault shares held >= outstanding (before)

**2. Deposits on Unichain Sepolia (issuer tokens into ShareVault custody)**

- A deposits 2 mcbAAPL -> credit to Sui 0xb07be57e…
  - unichain: [`0xa7e497ce07…`](https://sepolia.uniscan.xyz/tx/0xa7e497ce071f23a04435ab159cb3e9328e55497daa49738df2b5ed0c3d52759a)
- mint 10 mAAPLx to 0x588e53E014c69df42a0adbc5d65009e5CBff0f1A (mock issuer)
  - unichain: [`0x4a15d50fa4…`](https://sepolia.uniscan.xyz/tx/0x4a15d50fa4c4163e18f09173d7cd10286032cabb5c7e79e99950808b0bb08964)
- B deposits 10.00 mAAPLx -> credit to Sui 0x490aca12…
  - unichain: [`0x5ff60da687…`](https://sepolia.uniscan.xyz/tx/0x5ff60da68772402e96fb1d787c783a6918d1a3bbf29ceaf29ba7409e374027b3)
- keeper credit_deposit (2.0250 shares)
  - sui: [`5wouUCpiG6GQ…`](https://suiscan.xyz/testnet/tx/5wouUCpiG6GQzkYEurRWGUF4DQMrZHoVWtY9RX6jdRzs)
  - evm: [`0xa7e497ce07…`](https://sepolia.uniscan.xyz/tx/0xa7e497ce071f23a04435ab159cb3e9328e55497daa49738df2b5ed0c3d52759a)
  - walrusManifest: [`2BH-RNx9--Vy…`](https://walruscan.com/testnet/blob/2BH-RNx9--VywoLCnE1XR1CEnS-n-2HLWUrkWmqhEqE)
- keeper credit_deposit (10.0000 shares)
  - sui: [`4rpqfv89JMsk…`](https://suiscan.xyz/testnet/tx/4rpqfv89JMsk4oHCpW7TG9wp3FATQzLXM352TVtLDAq7)
  - evm: [`0x5ff60da687…`](https://sepolia.uniscan.xyz/tx/0x5ff60da68772402e96fb1d787c783a6918d1a3bbf29ceaf29ba7409e374027b3)
  - walrusManifest: [`MIhyAk-87nB4…`](https://walruscan.com/testnet/blob/MIhyAk-87nB4MzTDuhw8ol0brav4eAiAUhv00Pzvr0Q)
- **PASS** both deposits attested on Sui
- balances decrypted client-side via Seal (seal_approve_leaf) and Merkle-verified
  - A: 4.0750 shares, proof verified
  - B: 21.0000 shares, proof verified
- **PASS** leaf Merkle proofs verify against the on-chain root
- reserves after deposits
  - suiTotalShares: 25.075000
  - vaultSharesOutstanding: 25.075000
  - vaultSharesHeld: 25.075000
  - checkedBlock: 63575563
- **PASS** Sui total_shares == ShareVault.sharesOutstanding (after deposits)
- **PASS** ShareVault shares held >= outstanding (after deposits)

**3. Private payment A -> B on Sui, plus withdrawals, in one window**

- withdrawal quote (hook-output gross-up)
  - target: mcbAAPL
  - shares: 4.0000
  - direct: false
  - feePips: 1433
  - sharesDebited: 4.005740
- **PASS** cross-issuer withdrawal must convert (custody lacks enough mcbAAPL)
- A submits encrypted payment (1 share to B)
  - sui: [`4XtJWvrWa9hc…`](https://suiscan.xyz/testnet/tx/4XtJWvrWa9hcSgK8kifafHXorzw6RSw7CAWeNQueevyg)
  - walrus: [`YorCcZOpYyYT…`](https://walruscan.com/testnet/blob/YorCcZOpYyYTtoBLzK06734jsoXQjA3OGB_CXcq41TA)
  - commitment: 0xa1a19c1e8dcf1bb2db8106cfae801a220db6c29b5ef0bb0f70ab6ef82790a946
  - batch: [`0x48f7a49a79…`](https://suiscan.xyz/testnet/object/0x48f7a49a798fcbd7d97a6bc52860b872b35927e5f6450245aa0830bce909330b)
- A submits a second payment exceeding the remaining balance (must be rejected)
  - sui: [`4HKCgbMrLvJv…`](https://suiscan.xyz/testnet/tx/4HKCgbMrLvJvBhYAuV1JNjhxNnzAZMrScLbTy3N4BUEw)
  - walrus: [`Gv7y_sFUmbu2…`](https://walruscan.com/testnet/blob/Gv7y_sFUmbu2oeRerM_2K8h0DcwybPeLWXP1eKkNjC8)
  - commitment: 0x2459f178bae39f157813b36a639a39ca00756ad14e7f7983ed4013ac2e5dc5a4
  - batch: [`0x48f7a49a79…`](https://suiscan.xyz/testnet/object/0x48f7a49a798fcbd7d97a6bc52860b872b35927e5f6450245aa0830bce909330b)
- B submits withdrawal of 4.00 shares into mcbAAPL (max fee 25 bps)
  - sui: [`EeR4gWdnNPfr…`](https://suiscan.xyz/testnet/tx/EeR4gWdnNPfrGwRwc5Be3sx9FraMfVz6x9NQ5JitYoE8)
  - walrus: [`EREUt8Hzz2fM…`](https://walruscan.com/testnet/blob/EREUt8Hzz2fM9p_3yv_FlvRK1B42aC41i05-tkl50KM)
  - commitment: 0x43c71b08e3a17ccddbbac8aa69dcecaef44c593bd130bdbad6efd53743aba211
  - batch: [`0x48f7a49a79…`](https://suiscan.xyz/testnet/object/0x48f7a49a798fcbd7d97a6bc52860b872b35927e5f6450245aa0830bce909330b)
- B submits withdrawal of 4.00 shares into mcbAAPL with max fee 1 bps (below the live fee: must skip)
  - sui: [`EqmpfnHGJ17P…`](https://suiscan.xyz/testnet/tx/EqmpfnHGJ17PMwAJMKhprENZoA59NdXcQAvLR7jEV7v5)
  - walrus: [`874akw466MGC…`](https://walruscan.com/testnet/blob/874akw466MGCOiTTnllLH6ExCtx-nKMEDvSfANjFrzA)
  - commitment: 0x46e4dd93b16155f1f98f724f50d05c69842f5268f06976237050eef05bf85afb
  - batch: [`0x48f7a49a79…`](https://suiscan.xyz/testnet/object/0x48f7a49a798fcbd7d97a6bc52860b872b35927e5f6450245aa0830bce909330b)
- window closes at 2026-09-26T13:08:10.627Z (seq 3, 4 envelopes)
- **PASS** Seal denies the keeper before the window closes (NoAccessError)
- keeper apply_batch seq 3
  - sui: [`3xWd7z1dnzbk…`](https://suiscan.xyz/testnet/tx/3xWd7z1dnzbkvbem6Un81zVZnyCc7zdayaXuUp9WdHaJ)
  - walrusManifest: [`uiphHkE8uA19…`](https://walruscan.com/testnet/blob/uiphHkE8uA19Uy-ywSZE6vuC3n7VxM8RKEd7xLNWHxM)
  - root: 0xf581aa5d4ae0f5ba0e99d17d71656660e572b30948d5a78d51f554e6c7cdee7c
  - #0 applied pay
  - #1 rejected (overdraft)
  - #2 escrowed withdraw
  - #3 escrowed withdraw
- **PASS** total_shares unchanged across the private payment (25.075000)
- **PASS** double-spend rule: in-window overdraft rejected, first payment applied
- **PASS** both withdrawals escrowed

**4. Withdrawal settlement on Unichain (WrapSwapRouter -> ParityHook) and debit on Sui**

- keeper settleWithdrawals + debit_withdrawal
  - unichain: [`0x9fda60b5fe…`](https://sepolia.uniscan.xyz/tx/0x9fda60b5fe9d000f01f0b127369ea1daba290a51d0275b84ed7865a7348804fe)
  - sui: [`6jZXnAby55av…`](https://suiscan.xyz/testnet/tx/6jZXnAby55avyXH3RLSoLWqVNX2eyKe9uFcLgiY23eX8)
  - walrusManifest: [`T0v-yPAEi0MW…`](https://walruscan.com/testnet/blob/T0v-yPAEi0MWH0OSOSMcxTvImngjFNZVVLXb3ezsvtY)
  - 0x43c71b08… settled debited 4.005740
  - 0x46e4dd93… skipped restored 4.000410
- B received mcbAAPL (the other issuer's wrapper)
  - amount: 3.950617 mcbAAPL
  - faceValue: 3.950617 mcbAAPL
- **PASS** cross-issuer withdrawal delivered at least face value
- **PASS** fee-capped withdrawal emitted WithdrawalSkipped
- balances after, decrypted via Seal
  - A: 3.0750 (expected 3.0750)
  - B: 17.9942 (expected 17.9942: skipped credit restored, unused fee reservation refunded)
- **PASS** A debited exactly the payment
- **PASS** B = before + payment - settled debit; WithdrawalSkipped restored its credit
- **PASS** leaf Merkle proofs verify after settlement

**5. Reserves after**

- reserves after
  - suiTotalShares: 21.069259
  - vaultSharesOutstanding: 21.069259
  - vaultSharesHeld: 21.069260
  - checkedBlock: 63575700
- **PASS** Sui total_shares == ShareVault.sharesOutstanding (after)
- **PASS** ShareVault shares held >= outstanding (after)

**DEMO PASS**

### Browser click-through

Run on 2026-09-26 against live Sui testnet and Unichain Sepolia, with the keeper running as `pnpm dev:sui-keeper` and the page served from a production build. Eleven screenshots are in `~/wrapswap-run/status/sui-shots/`; harness: `services/crank/sui/clickthrough.ts`.

How it was driven: headless Chromium can't operate the Slush or MetaMask extensions, so the harness injects stand-ins that sign with the same demo keys. One is an EIP-1193 provider in the MetaMask path; the other is a wallet-standard Sui wallet that dapp-kit lists as "Demo Wallet (test harness)". Everything else is real: the `/pay` page, both chains, the Seal key servers, Walrus and the keeper. To do the same by hand, import the two Sui keys into Slush and `DEMO_MNEMONIC` index 1 into MetaMask.

| # | Step | Evidence |
| --- | --- | --- |
| 1 | Payer connects MetaMask (Unichain Sepolia) and a Sui wallet | `01-connected.png` |
| 2 | **Deposit (Unichain):** 5 mAAPLx into ShareVault | [`0xd1233137…`](https://sepolia.uniscan.xyz/tx/0xd12331373eda55ea0d5051faf5d990467484a95c476df21276ec9a8ed6d1c478), `02-deposit-sent.png` |
| 3 | Keeper credits 5 shares on Sui | `credit_deposit` [`E5fRnCYrxY…`](https://suiscan.xyz/testnet/tx/E5fRnCYrxYdZH71ffhNtPbBPsjRGNBHj8ZvT2MVrNR92), manifest [`S2v48k13Tf…`](https://walruscan.com/testnet/blob/S2v48k13TfQ_bJE_2QUlan4npJMkzwMVKHYzK0dckHY), `03-deposit-credited.png` |
| 4 | Payer decrypts their balance in the browser (Seal `seal_approve_leaf`, Merkle proof checked against the Sui root) | `04-payer-balance.png` |
| 5 | **Pay (Sui):** 3 shares to the payee, sealed to batch 9; countdown "batching for privacy" | `05-pay-batching.png` |
| 6 | Window closes, keeper applies batch 9, total unchanged | `apply_batch` [`Hx1x3k2vVo…`](https://suiscan.xyz/testnet/tx/Hx1x3k2vVo75XnwfAsbfmxeHw5wFwgWgA1rY9XhWSNgN), manifest [`JW5hPuu5iA…`](https://walruscan.com/testnet/blob/JW5hPuu5iAXZIR3UECCMM48L49X8tQl_gCrzrIeQfSE), `06-pay-applied.png` |
| 7 | Payee connects and decrypts their balance, which now includes the 3 shares | `07-payee-balance.png` |
| 8 | **Withdraw (Unichain):** payee asks for 5 shares as mcbAAPL, the other issuer; live quote 14.34 bps, grossed up | `08-withdraw-quote.png` |
| 9 | Sealed withdrawal applied into escrow (batch 10) | `apply_batch` [`DASnveERtY…`](https://suiscan.xyz/testnet/tx/DASnveERtYhVtqEqJpHBF5ojZtBJq6K2wPWznLrx6RLp), `09-withdraw-sealed.png` |
| 10 | ShareVault converts mAAPLx → mcbAAPL through WrapSwapRouter → ParityHook and delivers **4.938271 mcbAAPL** (= 5 shares ÷ 1.0125) | `settleWithdrawals` [`0xb888dea9…`](https://sepolia.uniscan.xyz/tx/0xb888dea982444f740ebee34489101ebbc3534d8103157d6415901b0f3b10b974), `10-withdraw-delivered.png` |
| 11 | Keeper debits 5.00718 shares on Sui (the unused fee reservation is refunded); reserves back to 1:1 | `debit_withdrawal` [`9rncFYg7wF…`](https://suiscan.xyz/testnet/tx/9rncFYg7wFKKUL5P3iRnPcxJauHgHe3dXxr6bJNoKtB2), manifest [`ZHsXOhGhwM…`](https://walruscan.com/testnet/blob/ZHsXOhGhwMCXo3igBjZhxT727w-6UYNC4qpm07GpAxk), `11-payee-after.png` |

After the run, `GET /pay/reserves` returned `suiTotalShares == vaultShares == 31.0548993375` with `invariant: true`.

## Tests

- Move: `cd sui/unison_pay && sui move test`, 22/22. Covers window gating, sequence ordering, total unchanged on internal batches, u128 above u64, single-use receipts, pause/resume, foreign cap, and allow/deny for both Seal policies.
- Solidity: `forge test --match-path contracts/test/ShareVault.t.sol`. That's 14 tests × both currency orderings, including a 1000-run solvency fuzz and the forced `WithdrawalSkipped` (`maxFeeBps` below the live fee), plus a fork test against the live Unichain deployment, run when `UNICHAIN_SEPOLIA_RPC_URL` is set.
- API: `vitest run api/src/routes/pay.test.ts`, 7/7.
- End to end: `DEMO_CHECK=1 scripts/dev/sui-demo`. Output above; the log is written to `~/wrapswap-run/logs/sui-demo.log`.

## Disclosures and limits

1. **Custody.** ShareVault on Unichain Sepolia holds the issuer tokens; Sui credits are claims against it. This is a custodial design.
2. **Operator visibility.** Tier B hides amounts from the public, not from the keeper, which must read amounts to stop overdrafts. The keeper's plaintext ledger lives off-repo. Nautilus (decrypt and apply inside an attested enclave) would remove this; this version does not include it. This is not zero-knowledge.
3. **Confidential, not anonymous.** Payments are unlinkable to the public, but deposits and withdrawals are ordinary ERC-20 movements on Unichain, and the anonymity set at the boundary is the withdrawal batch. The Walrus manifest lists which Sui addresses hold a leaf, though not their balances; every leaf is re-encrypted with a fresh nonce each root, so unchanged balances can't be told from changed ones.
4. **Single relayer.** One keeper attests deposits and settles withdrawals, optimistically. It can't mint credit without breaking the public reserves invariant (`/pay/reserves`), but it can censor or delay.
5. **No share bridge.** Shares never cross chains. Only credits (Sui) and issuer conversions (Unichain) move.
6. **Transfer restrictions unverified.** Native issuer behaviour on a generic node returned `OpcodeNotFound`, including an attempted holder transfer; that doesn't prove transfers are allowlisted. Mocks are used. Delivering a gated wrapper to an arbitrary recipient may fail in production, and in that case the withdrawal skips and the credit is restored.
7. **Testnet only.** Walrus has no public mainnet publisher, the Seal servers used are testnet open-mode servers, and the issuer tokens are mocks.
8. **Tax and regulation.** Paying with tokenized equity is jurisdiction-specific and is not determined by the protocol. Transferring a security as payment is not the same regulated activity as trading it.
9. **Relayer gas.** Each withdrawal settles inside `try/catch`, so a caller that trusts `eth_estimateGas` can hand the vault too little gas; the conversion then runs out of gas and is *skipped* (credit restored). This happened once on 1301 (`WithdrawalSkipped`, `FailedInnerCall`). The keeper sets an explicit limit of 300k gas plus 600k per withdrawal. A future vault revision should enforce a `gasleft()` floor per withdrawal on chain.
10. **Settlement gap.** Between `settleWithdrawals` on Unichain and `debit_withdrawal` on Sui (seconds), the vault is below the Sui total. `/pay/reserves` reports `invariant: false` for that interval; the UI shows it as "settling" for up to 60 s before calling it a mismatch.
11. **Cut from the plan for time.** zkLogin, sponsored gas, batch sharding (a single Batch per window serialises submits), dollar-denominated send, Postgres indexing and `/pay/history`.

READY FOR MERGE
