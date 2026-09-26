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
3. **Withdraw.** A withdrawal is a sealed instruction as well. Sending costs nothing on top of Sui gas; only a cross-issuer withdrawal pays, and it pays the normal Convert (ParityHook) fee. At apply time the keeper moves `shares ÷ (1 − maxFee)` into an escrow leaf, so the batch total still doesn't move. It then calls `ShareVault.settleWithdrawals` on Unichain. Each withdrawal either transfers directly when custody holds the target wrapper, or swaps the other issuer's token through `WrapSwapRouter.swapExactIn` on the ParityHook pool. That swap is priced from the hook's own exact-output quote, which uses hook-output rounding. Every withdrawal runs in its own `try/catch`: a failure emits `WithdrawalSkipped(commitment, reason)` and never reverts the batch. The keeper then calls `debit_withdrawal`. The total drops by exactly the shares that left custody; unused fee reservation is refunded; a skipped withdrawal's credit returns to its owner in the same root.
4. **Audit.** The app's **Send** panel ("Send shares to someone", `/app?tab=send`) walks the three steps: Deposit (Unichain) → Send (Sui, sealed for the 90 s window) → the recipient withdraws to any platform's wrapper through the router. It reads Sui directly from a fullnode, takes assets and platforms from `/assets`, and records every leg in a tracker receipt. Demo mode (no injected wallet) runs the whole flow with simulated states; its numbers still come from live data (multipliers, the fee feed with the hook's rounding, the reserves). `GET /pay/reserves` reads both chains and returns `invariant: suiTotalShares == vaultShares && vaultSharesHeld >= vaultShares`. The Send panel shows it next to your Seal-decrypted balance.

## Sui components and the job each does

| Component | Job | Where |
| --- | --- | --- |
| **Move package `unison_pay`** | `Pool` (u128 total, Merkle root, Walrus manifest pointer, single-use EVM receipts), `Batch` (window, envelopes), `OperatorCap`. `submit`, `apply_batch`, `credit_deposit`, `debit_withdrawal`, `pause`, `resume`. `apply_batch` enforces window close, sequence order and an unchanged total. | `sui/unison_pay/sources/pay.move`, 22 Move unit tests |
| **Seal** | Two access policies make up the whole privacy property. `seal_approve_batch(id, &Batch, &Clock)` releases payment instructions only after the window closes, so not even the keeper can read them early. `seal_approve_leaf(id, &Pool, ctx)` releases a balance leaf only to the address it encodes. Threshold 2 of 3 open testnet key servers. | `pay.move`, `services/crank/sui/{keeper,payer}.ts`, `web/src/app/Send.tsx` |
| **Walrus** | Stores every sealed payment instruction and one manifest per root holding all encrypted leaves. Holders fetch their own leaf and Merkle path from it. | `services/crank/sui/lib.ts` |
| **Clock** | Window gating inside `seal_approve_batch` and `apply_batch`. | `pay.move` |
| **Move object model** | Payer = transaction sender (no allowances), a shared Batch per window, and `OperatorCap` as the capability for root updates. | `pay.move` |
| **dapp-kit (Slush)** | Sui wallet connection, personal-message signing for the Seal `SessionKey`, and transaction signing in the Send panel. Reads and execution go through `SuiGrpcClient` (public JSON-RPC is retired on testnet). | `web/src/app/Send.tsx` |

On the EVM side, `ShareVault.sol` holds custody on Unichain Sepolia and settles through the existing `WrapSwapRouter` → Uniswap v4 `PoolManager` → `ParityHook`.

## IDs and addresses

Sui testnet (package published by `0xb07be57ee7e7d5ca43f681c6938cc8698fd892b42d1b33f613909ae585c741c7`, which is also the keeper):

| Object | ID |
| --- | --- |
| Package `unison_pay` | [`0x2f18fa6d27e46235a4dcb9c0de62adbf612e3f60700ffeeac4e13d50ea4f452c`](https://suiscan.xyz/testnet/object/0x2f18fa6d27e46235a4dcb9c0de62adbf612e3f60700ffeeac4e13d50ea4f452c) (publish tx [`CNfNqe3P…`](https://suiscan.xyz/testnet/tx/CNfNqe3P3ni7NkpknM3p1KMhqhV2hBeS2WcoLKo4Ugdt)) |
| Pool (90 s window) | [`0xcb16556e5c2b4f509aaff5a9a86a99308bbea2fa14447a57a52f9753d53ead53`](https://suiscan.xyz/testnet/object/0xcb16556e5c2b4f509aaff5a9a86a99308bbea2fa14447a57a52f9753d53ead53) |
| OperatorCap | [`0xfe4dc7c97f6702742b69864b2e4f431b157f58aa57b13677cc0b4731b1717fa0`](https://suiscan.xyz/testnet/object/0xfe4dc7c97f6702742b69864b2e4f431b157f58aa57b13677cc0b4731b1717fa0) |
| Retired pool (paired with the retired vault; 1:1 at 31.0407853 shares) | [`0xd04f7ee675e0c7c239532a2f59ec070ab3d26bbf8bc987067d4d45c9b049482c`](https://suiscan.xyz/testnet/object/0xd04f7ee675e0c7c239532a2f59ec070ab3d26bbf8bc987067d4d45c9b049482c) |
| Retired pool (180 s, never credited) | [`0xa1e1a8262c772c99fab34f0a389cfec6ed6f966889d4c9b3674313ccc16007e7`](https://suiscan.xyz/testnet/object/0xa1e1a8262c772c99fab34f0a389cfec6ed6f966889d4c9b3674313ccc16007e7) |
| Seal probe package | [`0xebb8a7e3ae227d2b3bc9f52934a2b0003ad93da11cc66e018888412aef654d32`](https://suiscan.xyz/testnet/object/0xebb8a7e3ae227d2b3bc9f52934a2b0003ad93da11cc66e018888412aef654d32) |

Seal key servers (testnet, open mode, threshold 2): mysten-testnet-1 `0x73d05d62…6db75`, mysten-testnet-2 `0xf5d14a81…623c8`, Ruby Nodes `0x6068c0ac…41da2` ([docs.sui.io/sui-stack/seal/pricing](https://docs.sui.io/sui-stack/seal/pricing)).
Walrus testnet: publisher `https://publisher.walrus-testnet.walrus.space`, aggregator `https://aggregator.walrus-testnet.walrus.space`.

Unichain Sepolia (1301):

| Contract | Address |
| --- | --- |
| ShareVault | [`0xd5010c7feC51c8765FE46c940A585C0Edd2Df3bC`](https://sepolia.uniscan.xyz/address/0xd5010c7feC51c8765FE46c940A585C0Edd2Df3bC#code) (verified; deploy [`0xcbcc826e…`](https://sepolia.uniscan.xyz/tx/0xcbcc826e2dcf5a6dc900daa315db089e4ba08dde693b14eb4a4475d5b52f9476), also `send.shareVault` in `deployments/unichain-sepolia.json`) |
| Retired ShareVault (pre fee-model AAPL pool) | [`0x275C82B932D4703F0e8A104524bC24813a5c3187`](https://sepolia.uniscan.xyz/address/0x275C82B932D4703F0e8A104524bC24813a5c3187#code) |
| WrapSwapRouter | [`0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3`](https://sepolia.uniscan.xyz/address/0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3#code) |
| ParityHook (fee model) | [`0x4142CA2E270A3f94cB8B56b1F6e1C74465a8a0c8`](https://sepolia.uniscan.xyz/address/0x4142CA2E270A3f94cB8B56b1F6e1C74465a8a0c8#code) |
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
API_PORT=5403 WEB_PORT=5402 pnpm dev:web  # then open http://127.0.0.1:5402/app?tab=send
# or one process: built web + /api/pay/reserves, everything else proxied to the live stack
PAY_WEB_DIST=dist/web PAY_UPSTREAM=http://127.0.0.1:13010 PAY_API_PORT=5402 pnpm dev:pay-api
DEMO_CHECK=1 scripts/dev/sui-demo         # scripted end-to-end check (stop the keeper first: one process per pool)
```

Secrets come from `~/wrapswap-run/env/onchain.env` (`DEPLOYER_PRIVATE_KEY` is the ShareVault keeper, `DEMO_MNEMONIC`); the keeper's plaintext ledger lives in `~/wrapswap-run/sui-state/`.

## Demo receipts

### Scripted end-to-end run

Run: `DEMO_CHECK=1 scripts/dev/sui-demo`, 2026-09-26T15:53:23.616Z (DEMO_CHECK=1), Sui testnet + Unichain Sepolia, ShareVault `0xd501…f3bC`. Full log: `~/wrapswap-run/logs/sui-demo-pass-v2.log`.

- Sui package: [`0x2f18fa6d27…`](https://suiscan.xyz/testnet/object/0x2f18fa6d27e46235a4dcb9c0de62adbf612e3f60700ffeeac4e13d50ea4f452c)
- Pool: [`0xcb16556e5c…`](https://suiscan.xyz/testnet/object/0xcb16556e5c2b4f509aaff5a9a86a99308bbea2fa14447a57a52f9753d53ead53)
- ShareVault: [`0xd5010c7feC…`](https://sepolia.uniscan.xyz/address/0xd5010c7feC51c8765FE46c940A585C0Edd2Df3bC)
- Wallet A: sui 0xb07be57ee7e7d5ca43f681c6938cc8698fd892b42d1b33f613909ae585c741c7 / evm 0x90d2d9C4966e81D1D8c50f3aaD51b3F9299f7612
- Wallet B: sui 0x490aca12124d8cc2bdf1eb007a9cca8fa0dfe60ffed4908c3cbf8a990fdfc4c9 / evm 0x588e53E014c69df42a0adbc5d65009e5CBff0f1A

**1. Setup and reserves before**

- reserves before
  - suiTotalShares: 0.000000
  - vaultSharesOutstanding: 0.000000
  - vaultSharesHeld: 0.000000
  - checkedBlock: 63585576
- **PASS** Sui total_shares == ShareVault.sharesOutstanding (before)
- **PASS** ShareVault shares held >= outstanding (before)

**2. Deposits on Unichain Sepolia (issuer tokens into ShareVault custody)**

- A deposits 2 mcbAAPL -> credit to Sui 0xb07be57e…
  - unichain: [`0x3e0446bd96…`](https://sepolia.uniscan.xyz/tx/0x3e0446bd96c832b7d0677bb24274bc71eb2f793defb2a48ab515352b35faf6f4)
- mint 8 mAAPLx to 0x588e53E014c69df42a0adbc5d65009e5CBff0f1A (mock issuer)
  - unichain: [`0xdcea75b339…`](https://sepolia.uniscan.xyz/tx/0xdcea75b3393e06fa400caf677262dd9679cca7c6dd812b6d90019d4b90d9de51)
- B deposits 8.00 mAAPLx -> credit to Sui 0x490aca12…
  - unichain: [`0x1911ccea74…`](https://sepolia.uniscan.xyz/tx/0x1911ccea74450b8314b7c838c55bdbad6e17bc37a169def079702c9602bdedcd)
- keeper credit_deposit (2.0250 shares)
  - sui: [`6yx1soQnk1o3…`](https://suiscan.xyz/testnet/tx/6yx1soQnk1o3hnqSURFrT1aKrGWjW1pkeo2BQBd6HiFN)
  - evm: [`0x3e0446bd96…`](https://sepolia.uniscan.xyz/tx/0x3e0446bd96c832b7d0677bb24274bc71eb2f793defb2a48ab515352b35faf6f4)
  - walrusManifest: [`pOYY4wOSUJ15…`](https://walruscan.com/testnet/blob/pOYY4wOSUJ15GNW6X_alUb2lssiwcDVzp_sSJ2S3S0U)
- keeper credit_deposit (8.0000 shares)
  - sui: [`RCWRx7nRvPN1…`](https://suiscan.xyz/testnet/tx/RCWRx7nRvPN1c2ZLEKtuK4NESpcPHiRMSSDRrCwvPB4)
  - evm: [`0x1911ccea74…`](https://sepolia.uniscan.xyz/tx/0x1911ccea74450b8314b7c838c55bdbad6e17bc37a169def079702c9602bdedcd)
  - walrusManifest: [`6Py_AVj0ycTx…`](https://walruscan.com/testnet/blob/6Py_AVj0ycTxQHDrCAnS40KpfvL9tUtu7USD3mVzdJA)
- **PASS** both deposits attested on Sui
- balances decrypted client-side via Seal (seal_approve_leaf) and Merkle-verified
  - A: 2.0250 shares, proof verified
  - B: 8.0000 shares, proof verified
- **PASS** leaf Merkle proofs verify against the on-chain root
- reserves after deposits
  - suiTotalShares: 10.025000
  - vaultSharesOutstanding: 10.025000
  - vaultSharesHeld: 10.025000
  - checkedBlock: 63585617
- **PASS** Sui total_shares == ShareVault.sharesOutstanding (after deposits)
- **PASS** ShareVault shares held >= outstanding (after deposits)

**3. Private payment A -> B on Sui, plus withdrawals, in one window**

- withdrawal quote (hook-output gross-up)
  - target: mcbAAPL
  - shares: 3.0000
  - direct: false
  - feePips: 450
  - sharesDebited: 3.001349
- **PASS** cross-issuer withdrawal must convert (custody lacks enough mcbAAPL)
- A submits encrypted payment (1 share to B)
  - sui: [`B7bQPcJ1mpvk…`](https://suiscan.xyz/testnet/tx/B7bQPcJ1mpvkKaVfNW5rS36TCu1xECCEErjXKscimoqg)
  - walrus: [`N_jW1JSkmnA_…`](https://walruscan.com/testnet/blob/N_jW1JSkmnA_jf3SwQ5iEY79hn5B_RuUMKuZLbhkZ1Q)
  - commitment: 0x99b0265a88a854f3bbe4e38d297b7a8bb7aa7e371ad9e06c155762f012135519
  - batch: [`0x33f15f13d6…`](https://suiscan.xyz/testnet/object/0x33f15f13d61ac6c55b3daf6a3dd1572f22bacb492b8141a6fb197e33d8b473fc)
- A submits a second payment exceeding the remaining balance (must be rejected)
  - sui: [`2ivuJtYndDaJ…`](https://suiscan.xyz/testnet/tx/2ivuJtYndDaJwpcjZin9Fh1RPHrysRGRztsLp175xDzj)
  - walrus: [`qVI-fvoiA_pD…`](https://walruscan.com/testnet/blob/qVI-fvoiA_pDXQkTUEmkGx57XK8dakGnWB2_Lz-oTM4)
  - commitment: 0xb524072d089a60f1ff5284863e553cc52ec8e17c999dc7cf4ec662be4a61aa74
  - batch: [`0x33f15f13d6…`](https://suiscan.xyz/testnet/object/0x33f15f13d61ac6c55b3daf6a3dd1572f22bacb492b8141a6fb197e33d8b473fc)
- B submits withdrawal of 3.00 shares into mcbAAPL (max fee 25 bps)
  - sui: [`6c5LHWhT3MxM…`](https://suiscan.xyz/testnet/tx/6c5LHWhT3MxMDZg3bf61oaN7tMsWQjtFFajfkZd9MmQt)
  - walrus: [`ZZAz84dQUQYh…`](https://walruscan.com/testnet/blob/ZZAz84dQUQYhHe-i385pDXAQs50a4Zy6eS_iYcm4CqI)
  - commitment: 0x9927214d7e3747f62d0cfa9fdc59b389f96fd78ad598e32d03f54ad2157d04ee
  - batch: [`0x33f15f13d6…`](https://suiscan.xyz/testnet/object/0x33f15f13d61ac6c55b3daf6a3dd1572f22bacb492b8141a6fb197e33d8b473fc)
- B submits withdrawal of 3.00 shares into mcbAAPL with max fee 1 bps (below the live fee: must skip)
  - sui: [`CQA6CbUustHa…`](https://suiscan.xyz/testnet/tx/CQA6CbUustHaZFjQdLpRs9TYG5358qgwif6vm1m57N7o)
  - walrus: [`cDwnJaYJd_1g…`](https://walruscan.com/testnet/blob/cDwnJaYJd_1gFg-GwstIpd6bnZpaHFiOEPP93A-ZSs8)
  - commitment: 0x4c8533321b7d3c5eb48d05fa6cb34143a95c697c1d633f0131c62c243049865e
  - batch: [`0x33f15f13d6…`](https://suiscan.xyz/testnet/object/0x33f15f13d61ac6c55b3daf6a3dd1572f22bacb492b8141a6fb197e33d8b473fc)
- window closes at 2026-09-26T15:55:50.417Z (seq 1, 4 envelopes)
- **PASS** Seal denies the keeper before the window closes (NoAccessError)
- keeper apply_batch seq 1
  - sui: [`HaVNfEGYBVGB…`](https://suiscan.xyz/testnet/tx/HaVNfEGYBVGBFD2e1mTWat9YeU8qiLXSajFk85A6F6r4)
  - walrusManifest: [`IMokrH5_Tyn7…`](https://walruscan.com/testnet/blob/IMokrH5_Tyn7MHqLzggvaihj_N3IP4JqmH2GmTt9te8)
  - root: 0xbc932e7caea5060b40e711fa679728d44cf78c8cc9c1019f1938cd34162773fc
  - #0 applied pay
  - #1 rejected (overdraft)
  - #2 escrowed withdraw
  - #3 escrowed withdraw
- **PASS** total_shares unchanged across the private payment (10.025000)
- **PASS** double-spend rule: in-window overdraft rejected, first payment applied
- **PASS** both withdrawals escrowed

**4. Withdrawal settlement on Unichain (WrapSwapRouter -> ParityHook) and debit on Sui**

- keeper settleWithdrawals + debit_withdrawal
  - unichain: [`0x302cb33da6…`](https://sepolia.uniscan.xyz/tx/0x302cb33da6d8c51b87b83c1101bcc8a4c353b2fb9b4c2b417550b44f82003e28)
  - sui: [`Ez9oPVpzyvQv…`](https://suiscan.xyz/testnet/tx/Ez9oPVpzyvQv6BVkYEgtBTPHEvvVzdv34twz5JH3vhNc)
  - walrusManifest: [`Bq9268Kr9qqT…`](https://walruscan.com/testnet/blob/Bq9268Kr9qqTqt03kTULcBEshviwOvVXN3MusVerUBU)
  - 0x9927214d… settled debited 3.001349
  - 0x4c853332… skipped restored 3.000310
- B received mcbAAPL (the other issuer's wrapper)
  - amount: 2.962962 mcbAAPL
  - faceValue: 2.962962 mcbAAPL
- **PASS** cross-issuer withdrawal delivered at least face value
- **PASS** fee-capped withdrawal emitted WithdrawalSkipped
- balances after, decrypted via Seal
  - A: 1.0250 (expected 1.0250)
  - B: 5.9986 (expected 5.9986: skipped credit restored, unused fee reservation refunded)
- **PASS** A debited exactly the payment
- **PASS** B = before + payment - settled debit; WithdrawalSkipped restored its credit
- **PASS** leaf Merkle proofs verify after settlement

**5. Reserves after**

- reserves after
  - suiTotalShares: 7.023650
  - vaultSharesOutstanding: 7.023650
  - vaultSharesHeld: 7.023650
  - checkedBlock: 63585760
- **PASS** Sui total_shares == ShareVault.sharesOutstanding (after)
- **PASS** ShareVault shares held >= outstanding (after)

**DEMO PASS**

### Browser click-through: Send panel, fee-model vault

Run on 2026-09-26 (~16:05 UTC) in the app's **Send** panel (`/app?tab=send`) against live Sui testnet and Unichain Sepolia, with ShareVault `0xd501…f3bC` and the keeper running as `pnpm dev:sui-keeper`. Nine screenshots are in `~/wrapswap-run/status/sui-shots/send-live/`; a demo-mode run (no wallet, simulated states, live numbers) is in `send-demo/`.

How it was driven: headless Chromium can't operate the Slush or MetaMask extensions, so the harness (`services/crank/sui/clickthrough.ts`) injects stand-ins that sign with the same demo keys. One is an EIP-1193 provider behind the app's own Connect button; the other is a wallet-standard Sui wallet that dapp-kit lists as "Demo Wallet (test harness)". Everything else is real: the page, both chains, Seal, Walrus and the keeper. To do it by hand, import the two Sui keys into Slush and `DEMO_MNEMONIC` index 1 into MetaMask.

| # | Step | Chain | Tx |
| --- | --- | --- | --- |
| 1 | Payer deposits 5 mAAPLx (xStocks) into ShareVault | Unichain | [`0xf58db617…`](https://sepolia.uniscan.xyz/tx/0xf58db6179468a23d2464970897d93a10b0349bb1fc5c6438e9e530d95ee30db4) |
| 2 | Keeper credits 5 shares (`credit_deposit`) | Sui | [`DfVRLCue13…`](https://suiscan.xyz/testnet/tx/DfVRLCue13HSeh67hGuD3CbE4RnApZsgHoVhQPG6wZ2u) |
| 3 | Payer decrypts their balance in the browser (Seal `seal_approve_leaf`, Merkle proof checked) | Sui (read) | `03-deposit-credited.png` |
| 4 | Payer sends 3 shares, sealed to batch 2 (confidential: amount and payee encrypted) | Sui | [`9mpHossDSy…`](https://suiscan.xyz/testnet/tx/9mpHossDSyLaYkVEL5Fqpn4M9zo3V2rcpNPB2UUb7x8q) |
| 5 | Window closes; keeper applies batch 2, total unchanged | Sui | [`AHjYiXGWTL…`](https://suiscan.xyz/testnet/tx/AHjYiXGWTLewJZXXGjveB4uUF2Av71KTYGwSnGPeUrv5) |
| 6 | Payee decrypts their own leaf, which includes the 3 shares | Sui (read) | `06-recipient-balance.png` |
| 7 | Payee withdraws 5 shares to Coinbase (mcbAAPL, the other issuer), sealed | Sui | [`cLGVr27yXm…`](https://suiscan.xyz/testnet/tx/cLGVr27yXm4ipD5aikAQK5bdwMi4tG77qQmTfNsAR3g) |
| 8 | Keeper applies batch 3 (withdrawal moved to escrow) | Sui | [`8C3hfVjScT…`](https://suiscan.xyz/testnet/tx/8C3hfVjScT9PoCzrbDtQka44DnHcR5xf3ovpKMGm9jNP) |
| 9 | ShareVault converts mAAPLx → mcbAAPL through WrapSwapRouter → ParityHook and delivers **4.938271 mcbAAPL** (= 5 shares ÷ 1.0125) | Unichain | [`0x38c217b6…`](https://sepolia.uniscan.xyz/tx/0x38c217b6fad1e497a63c37adaed68ba195c9eef08dc5e8352fabae5d87048104) |
| 10 | Keeper debits 5.0022410625 shares (Convert fee grossed up; unused reservation refunded) | Sui | [`4aiUD9xkCi…`](https://suiscan.xyz/testnet/tx/4aiUD9xkCiKX7MMi8o89HAaMuwkJsviH9mAC4GkV8kHF) |

After the run, `GET /pay/reserves` returned `suiTotalShares == vaultShares == vaultSharesHeld == 7.0214092375`, with `invariant: true` and `solvent: true`.

Earlier runs on the retired vault (`0x275C…3187`, pre fee-model pool) passed the same flow; their screenshots remain in `~/wrapswap-run/status/sui-shots/` and the logs in `~/wrapswap-run/logs/`.

## Tests

- Move: `cd sui/unison_pay && sui move test`, 22/22. Covers window gating, sequence ordering, total unchanged on internal batches, u128 above u64, single-use receipts, pause/resume, foreign cap, and allow/deny for both Seal policies.
- Solidity: `forge test --match-path contracts/test/ShareVault.t.sol`. That's 14 tests × both currency orderings, including a 1000-run solvency fuzz and the forced `WithdrawalSkipped` (`maxFeeBps` below the live fee), plus two fork tests against the live fee-model deployment (both conversion directions), run when `UNICHAIN_SEPOLIA_RPC_URL` is set: 30/30.
- API: `vitest run api/src/routes/pay.test.ts`, 5/5 (`GET /pay/reserves`, including `solvent`).
- End to end: `DEMO_CHECK=1 scripts/dev/sui-demo`. Output above; the log is written to `~/wrapswap-run/logs/sui-demo.log`.

## Disclosures and limits

1. **Custody.** ShareVault on Unichain Sepolia holds the issuer tokens; Sui credits are claims against it. This is a custodial design.
2. **Operator visibility.** Tier B hides amounts from the public, not from the keeper, which must read amounts to stop overdrafts. The keeper's plaintext ledger lives off-repo. Nautilus (decrypt and apply inside an attested enclave) would remove this; this version does not include it. This is not zero-knowledge.
3. **Confidential, not anonymous.** Payments are unlinkable to the public, but deposits and withdrawals are ordinary ERC-20 movements on Unichain, and the anonymity set at the boundary is the withdrawal batch. The Walrus manifest lists which Sui addresses hold a leaf, though not their balances; every leaf is re-encrypted with a fresh nonce each root, so unchanged balances can't be told from changed ones.
4. **Single relayer.** One keeper attests deposits and settles withdrawals, optimistically. It enforces `Sui total_shares ≤ ShareVault custody`: it refuses any credit that would exceed custody and pauses the pool if the invariant ever breaks. `/pay/reserves` publishes the same check (`solvent`). It can still censor or delay.
5. **Vault redeploy.** Onchain's fee-model redeploy moved the AAPL pool to a new ParityHook, and the vault's pool key is immutable, so ShareVault was redeployed (`0xd501…f3bC`) with a fresh Sui pool. The retired vault/pool pair ended 1:1 at 31.0407853 shares of mock tokens; its custody stays where it is. The new vault re-quotes the exact-input trade it executes (post-trade-skew fee) and tops up the input so the payee always gets face value.
6. **No share bridge.** Shares never cross chains. Only credits (Sui) and issuer conversions (Unichain) move.
7. **Transfer restrictions unverified.** Native issuer behaviour on a generic node returned `OpcodeNotFound`, including an attempted holder transfer; that doesn't prove transfers are allowlisted. Mocks are used. Delivering a gated wrapper to an arbitrary recipient may fail in production, and in that case the withdrawal skips and the credit is restored.
8. **Testnet only.** Walrus has no public mainnet publisher, the Seal servers used are testnet open-mode servers, and the issuer tokens are mocks.
9. **Tax and regulation.** Paying with tokenized equity is jurisdiction-specific and is not determined by the protocol. Transferring a security as payment is not the same regulated activity as trading it.
10. **Relayer gas.** Each withdrawal settles inside `try/catch`, so a caller that trusts `eth_estimateGas` can hand the vault too little gas; the conversion then runs out of gas and is *skipped* (credit restored). This happened once on 1301 (`WithdrawalSkipped`, `FailedInnerCall`). The keeper sets an explicit limit of 300k gas plus 600k per withdrawal. A future vault revision should enforce a `gasleft()` floor per withdrawal on chain.
11. **Settlement gap.** Between `settleWithdrawals` on Unichain and `debit_withdrawal` on Sui (seconds), the vault is below the Sui total. `/pay/reserves` reports `invariant: false` for that interval; the UI shows it as "settling" for up to 60 s before calling it a mismatch.
12. **Cut from the plan for time.** zkLogin, sponsored gas, batch sharding (a single Batch per window serialises submits), dollar-denominated send, Postgres indexing and `/pay/history`.

READY FOR MERGE
