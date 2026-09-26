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
| Pool (90 s window) | [`0xf414bbcc050bb2c0407d76f482bc830323a6dd93195ef1b5fae855e939a12fe1`](https://suiscan.xyz/testnet/object/0xf414bbcc050bb2c0407d76f482bc830323a6dd93195ef1b5fae855e939a12fe1) |
| OperatorCap | [`0x0c2376ef722f33b53b3df106ea1672bba5e931e8b23f6033506cdcddc145f12c`](https://suiscan.xyz/testnet/object/0x0c2376ef722f33b53b3df106ea1672bba5e931e8b23f6033506cdcddc145f12c) |
| Seal probe package | [`0xebb8a7e3ae227d2b3bc9f52934a2b0003ad93da11cc66e018888412aef654d32`](https://suiscan.xyz/testnet/object/0xebb8a7e3ae227d2b3bc9f52934a2b0003ad93da11cc66e018888412aef654d32) |

Seal key servers (testnet, open mode, threshold 2): mysten-testnet-1 `0x73d05d62…6db75`, mysten-testnet-2 `0xf5d14a81…623c8`, Ruby Nodes `0x6068c0ac…41da2` ([docs.sui.io/sui-stack/seal/pricing](https://docs.sui.io/sui-stack/seal/pricing)).
Walrus testnet: publisher `https://publisher.walrus-testnet.walrus.space`, aggregator `https://aggregator.walrus-testnet.walrus.space`.

Unichain Sepolia (1301):

| Contract | Address |
| --- | --- |
| ShareVault | [`0x76B1661dB3858b5455Ae4371291c954fa248Bd5d`](https://sepolia.uniscan.xyz/address/0x76B1661dB3858b5455Ae4371291c954fa248Bd5d#code) (verified; deploy [`0xb227e5b1…`](https://sepolia.uniscan.xyz/tx/0xb227e5b1e10323530a5895a00f793e086d4b6d6c561c3c5c4a45e99d1cc97ef3); `send.shareVault` in `deployments/unichain-sepolia.json`) |
| WrapSwapRouter | [`0x49d7eA31c619E80785Fa31CBc5bE052ED4EC40Cb`](https://sepolia.uniscan.xyz/address/0x49d7eA31c619E80785Fa31CBc5bE052ED4EC40Cb#code) |
| ParityHook (final fee model, all assets) | [`0x484bc6aa8f6D472AD67F3ce8dD86f1f8A166e0c8`](https://sepolia.uniscan.xyz/address/0x484bc6aa8f6D472AD67F3ce8dD86f1f8A166e0c8#code) |
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

Run: `DEMO_CHECK=1 scripts/dev/sui-demo`, 2026-09-26T17:41:57.969Z (DEMO_CHECK=1), Sui testnet + Unichain Sepolia, final fee-model deployment, ShareVault `0x76B1…Bd5d`. Full log: `~/wrapswap-run/logs/sui-demo-pass-final.log`.

- Sui package: [`0x2f18fa6d27…`](https://suiscan.xyz/testnet/object/0x2f18fa6d27e46235a4dcb9c0de62adbf612e3f60700ffeeac4e13d50ea4f452c)
- Pool: [`0xf414bbcc05…`](https://suiscan.xyz/testnet/object/0xf414bbcc050bb2c0407d76f482bc830323a6dd93195ef1b5fae855e939a12fe1)
- ShareVault: [`0x76B1661dB3…`](https://sepolia.uniscan.xyz/address/0x76B1661dB3858b5455Ae4371291c954fa248Bd5d)
- Wallet A: sui 0xb07be57ee7e7d5ca43f681c6938cc8698fd892b42d1b33f613909ae585c741c7 / evm 0x90d2d9C4966e81D1D8c50f3aaD51b3F9299f7612
- Wallet B: sui 0x490aca12124d8cc2bdf1eb007a9cca8fa0dfe60ffed4908c3cbf8a990fdfc4c9 / evm 0x588e53E014c69df42a0adbc5d65009e5CBff0f1A

**1. Setup and reserves before**

- reserves before
  - suiTotalShares: 0.000000
  - vaultSharesOutstanding: 0.000000
  - vaultSharesHeld: 0.000000
  - checkedBlock: 63592090
- **PASS** Sui total_shares == ShareVault.sharesOutstanding (before)
- **PASS** ShareVault shares held >= outstanding (before)

**2. Deposits on Unichain Sepolia (issuer tokens into ShareVault custody)**

- A deposits 2 mcbAAPL -> credit to Sui 0xb07be57e…
  - unichain: [`0xbb0dce3f9f…`](https://sepolia.uniscan.xyz/tx/0xbb0dce3f9fb6e8471e02f7f700112ae024c595c99be1309713aa71e00ba5fed3)
- B deposits 8.00 mAAPLx -> credit to Sui 0x490aca12…
  - unichain: [`0xa36555c376…`](https://sepolia.uniscan.xyz/tx/0xa36555c376a953e454e58f4e0edfbddb329bccb38744121d947b8eb79e759f82)
- keeper credit_deposit (2.0250 shares)
  - sui: [`8WJ7vbF1c6vd…`](https://suiscan.xyz/testnet/tx/8WJ7vbF1c6vdayQSYPEJ2xBQqEvpsE16JVabsHxZdVyR)
  - evm: [`0xbb0dce3f9f…`](https://sepolia.uniscan.xyz/tx/0xbb0dce3f9fb6e8471e02f7f700112ae024c595c99be1309713aa71e00ba5fed3)
  - walrusManifest: [`VmpaHJAOKrCz…`](https://walruscan.com/testnet/blob/VmpaHJAOKrCz0JHUKqtiqE6nEUGzZbFrq6VXE_Hh54o)
- keeper credit_deposit (8.0000 shares)
  - sui: [`9DPRTisopKwt…`](https://suiscan.xyz/testnet/tx/9DPRTisopKwtLmcrj1K2pPbC8fxJKDok6XmUDi1pUPuE)
  - evm: [`0xa36555c376…`](https://sepolia.uniscan.xyz/tx/0xa36555c376a953e454e58f4e0edfbddb329bccb38744121d947b8eb79e759f82)
  - walrusManifest: [`xRkp_B2HJzzg…`](https://walruscan.com/testnet/blob/xRkp_B2HJzzglu-2y2H6G8gEz5Y8AQseh8Xka7OJGB4)
- **PASS** both deposits attested on Sui
- balances decrypted client-side via Seal (seal_approve_leaf) and Merkle-verified
  - A: 2.0250 shares, proof verified
  - B: 8.0000 shares, proof verified
- **PASS** leaf Merkle proofs verify against the on-chain root
- reserves after deposits
  - suiTotalShares: 10.025000
  - vaultSharesOutstanding: 10.025000
  - vaultSharesHeld: 10.025000
  - checkedBlock: 63592126
- **PASS** Sui total_shares == ShareVault.sharesOutstanding (after deposits)
- **PASS** ShareVault shares held >= outstanding (after deposits)

**3. Private payment A -> B on Sui, plus withdrawals, in one window**

- withdrawal quote (hook-output gross-up)
  - target: mcbAAPL
  - shares: 3.0000
  - direct: false
  - feePips: 482
  - sharesDebited: 3.001445
- **PASS** cross-issuer withdrawal must convert (custody lacks enough mcbAAPL)
- A submits encrypted payment (1 share to B)
  - sui: [`H8zn1DrFtYjT…`](https://suiscan.xyz/testnet/tx/H8zn1DrFtYjTfevCQroVkgaVS1eqJv9PwJzfFAJ12XbW)
  - walrus: [`WUsa0Ez3aEMF…`](https://walruscan.com/testnet/blob/WUsa0Ez3aEMFC76pc5_NFGb22WHbC88r7Zr9DxTIRbw)
  - commitment: 0x7c1f68820b94be22a38f6961c526d89936e89095b95aeb4ff7ed413c76c8326a
  - batch: [`0xe5fd0bbc97…`](https://suiscan.xyz/testnet/object/0xe5fd0bbc978da8c5fa43133879fc9d64d0b1d528975243b83f4da37d0f8de642)
- A submits a second payment exceeding the remaining balance (must be rejected)
  - sui: [`9hTQvWRhCJZG…`](https://suiscan.xyz/testnet/tx/9hTQvWRhCJZGWw1hBmY6DSvrXfDTp43gaeU5Pqz3RgC3)
  - walrus: [`9n6SIvaWSz5q…`](https://walruscan.com/testnet/blob/9n6SIvaWSz5qK9ZFYjwIe71eT4bATVTFOcULtLhi_kc)
  - commitment: 0xbebf6240d9fa22f3f28ab6a5661dad58c54f9fd39e2c62c6f1d1a78d29619119
  - batch: [`0xe5fd0bbc97…`](https://suiscan.xyz/testnet/object/0xe5fd0bbc978da8c5fa43133879fc9d64d0b1d528975243b83f4da37d0f8de642)
- B submits withdrawal of 3.00 shares into mcbAAPL (max fee 100 bps)
  - sui: [`2XGN6J4zQKDS…`](https://suiscan.xyz/testnet/tx/2XGN6J4zQKDSN3YbVHow6xnxv8wChftrKFmZ7soe1HU1)
  - walrus: [`26LBohBJhnsN…`](https://walruscan.com/testnet/blob/26LBohBJhnsNwrXpGm8UlBk6qJuquAkK6R0rUrLSJIs)
  - commitment: 0xe7dbb8c71af21480b46a00277d510b99ff692fcadb4d50d331177255dc757565
  - batch: [`0xe5fd0bbc97…`](https://suiscan.xyz/testnet/object/0xe5fd0bbc978da8c5fa43133879fc9d64d0b1d528975243b83f4da37d0f8de642)
- B submits withdrawal of 3.00 shares into mcbAAPL with max fee 1 bps (below the live fee: must skip)
  - sui: [`9ZN6yTF6TXUy…`](https://suiscan.xyz/testnet/tx/9ZN6yTF6TXUyr8nkEJFZqTUET51mHoTb5FzpPCXdZ6C8)
  - walrus: [`A17mpTEViyWW…`](https://walruscan.com/testnet/blob/A17mpTEViyWWppS0CNnmefk6rFaj2Urgy7vPDjr256E)
  - commitment: 0xfdda3d6ced57b4a1947b7373f9080e6efa882c8252c81298e70a106feeefc6af
  - batch: [`0xe5fd0bbc97…`](https://suiscan.xyz/testnet/object/0xe5fd0bbc978da8c5fa43133879fc9d64d0b1d528975243b83f4da37d0f8de642)
- window closes at 2026-09-26T17:44:12.656Z (seq 1, 4 envelopes)
- **PASS** Seal denies the keeper before the window closes (NoAccessError)
- keeper apply_batch seq 1
  - sui: [`mfr63QPuVr2P…`](https://suiscan.xyz/testnet/tx/mfr63QPuVr2PbWSmRBuEGoDHG8HND24EXyFwumB9CYU)
  - walrusManifest: [`RFdjdH871QSu…`](https://walruscan.com/testnet/blob/RFdjdH871QSuF8P6EnNOLkhLNVt0_qU79Rau6gfwtSM)
  - root: 0x3ddb40821ee4f65b632601a4515cafcbc993b5e23fbc3e4f11f2906f7becf175
  - #0 applied pay
  - #1 rejected (overdraft)
  - #2 escrowed withdraw
  - #3 escrowed withdraw
- **PASS** total_shares unchanged across the private payment (10.025000)
- **PASS** double-spend rule: in-window overdraft rejected, first payment applied
- **PASS** both withdrawals escrowed

**4. Withdrawal settlement on Unichain (WrapSwapRouter -> ParityHook) and debit on Sui**

- keeper settleWithdrawals + debit_withdrawal
  - unichain: [`0x55e6802406…`](https://sepolia.uniscan.xyz/tx/0x55e68024068cf5fbaf112d12e487f4ac8c54f4b74ae4bffde96c3d5393dd7c54)
  - sui: [`3QmwHs1B2F7s…`](https://suiscan.xyz/testnet/tx/3QmwHs1B2F7s9ba87nAGP5FB7EAx7kKuvG3q4mS89vQR)
  - walrusManifest: [`H0Qz1Fs9Srom…`](https://walruscan.com/testnet/blob/H0Qz1Fs9SrommO1D_sVdkMRnRbd6RntnqfaLirMKzXA)
  - 0xe7dbb8c7… settled debited 3.001445
  - 0xfdda3d6c… skipped restored 3.000310
- B received mcbAAPL (the other issuer's wrapper)
  - amount: 2.962962 mcbAAPL
  - faceValue: 2.962962 mcbAAPL
- **PASS** cross-issuer withdrawal delivered at least face value
- **PASS** fee-capped withdrawal emitted WithdrawalSkipped
- balances after, decrypted via Seal
  - A: 1.0250 (expected 1.0250)
  - B: 5.9985 (expected 5.9985: skipped credit restored, unused fee reservation refunded)
- **PASS** A debited exactly the payment
- **PASS** B = before + payment - settled debit; WithdrawalSkipped restored its credit
- **PASS** leaf Merkle proofs verify after settlement

**5. Reserves after**

- reserves after
  - suiTotalShares: 7.023554
  - vaultSharesOutstanding: 7.023554
  - vaultSharesHeld: 7.023554
  - checkedBlock: 63592272
- **PASS** Sui total_shares == ShareVault.sharesOutstanding (after)
- **PASS** ShareVault shares held >= outstanding (after)

**DEMO PASS**

### Browser click-through: Send panel, final deployment

Run on 2026-09-26 (~17:50 UTC) in the app's **Send** panel (`/app?tab=send`) against live Sui testnet and Unichain Sepolia on the final fee-model deployment (router `0x49d7…40Cb`, ParityHook `0x484b…e0c8`, ShareVault `0x76B1…Bd5d`), with the keeper running as `pnpm dev:sui-keeper`. Nine screenshots are in `~/wrapswap-run/status/sui-shots/send-live/`; a demo-mode run (no wallet, simulated states, live numbers) is in `send-demo/`.

How it was driven: headless Chromium can't operate the Slush or MetaMask extensions, so the harness (`services/crank/sui/clickthrough.ts`) injects stand-ins that sign with the same demo keys. One is an EIP-1193 provider behind the app's own Connect button; the other is a wallet-standard Sui wallet that dapp-kit lists as "Demo Wallet (test harness)". Everything else is real: the page, both chains, Seal, Walrus and the keeper. To do it by hand, import the two Sui keys into Slush and `DEMO_MNEMONIC` index 1 into MetaMask.

| # | Step | Chain | Tx |
| --- | --- | --- | --- |
| 1 | Payer deposits 5 mAAPLx (xStocks) into ShareVault | Unichain | [`0xb1d818df…`](https://sepolia.uniscan.xyz/tx/0xb1d818df53f0ab92de3d89e115e3ec16a6e6739fbe8a6716a172485582ae8b81) |
| 2 | Keeper credits 5 shares (`credit_deposit`) | Sui | [`9D9u3gLh5v…`](https://suiscan.xyz/testnet/tx/9D9u3gLh5vfrsiMSLXtBcvw7AQR2a3PzPtaRGnabiAFo) |
| 3 | Payer decrypts their balance in the browser (Seal `seal_approve_leaf`, Merkle proof checked) | Sui (read) | `03-deposit-credited.png` |
| 4 | Payer sends 3 shares, sealed to batch 2 (amount and payee encrypted) | Sui | [`Cd9YepBeMf…`](https://suiscan.xyz/testnet/tx/Cd9YepBeMfAPQcnFcQGiTqoK3fwXFQTKALvYDmexhFWu) |
| 5 | Window closes; keeper applies batch 2, total unchanged | Sui | [`4dtHGYtxgW…`](https://suiscan.xyz/testnet/tx/4dtHGYtxgWesaYVhDWoFb1bZpWDL2kT7Z6BUmPQ4yUzz) |
| 6 | Payee decrypts their own leaf, which includes the 3 shares | Sui (read) | `06-recipient-balance.png` |
| 7 | Payee withdraws 5 shares to Coinbase (mcbAAPL, the other issuer), sealed | Sui | [`71m6E9Eb9g…`](https://suiscan.xyz/testnet/tx/71m6E9Eb9g2TEVSp7HriUJLdYPPFaai1JF8tyBgjKLkL) |
| 8 | Keeper applies batch 3 (withdrawal moved to escrow) | Sui | [`ERNPGq8LzE…`](https://suiscan.xyz/testnet/tx/ERNPGq8LzEVT8RAmp5rbXsV3EGh1X8SyT4hPQJNY1YoH) |
| 9 | ShareVault converts mAAPLx → mcbAAPL through WrapSwapRouter → ParityHook and delivers **4.938271 mcbAAPL** (= 5 shares ÷ 1.0125) | Unichain | [`0x635b4c36…`](https://sepolia.uniscan.xyz/tx/0x635b4c364390866199ca8f025e02d9fd0ed9d886f0f0aa9801521db8a0cf949d) |
| 10 | Keeper debits 5.0023807875 shares (Convert fee grossed up; unused reservation refunded) | Sui | [`2CdgAK4GFq…`](https://suiscan.xyz/testnet/tx/2CdgAK4GFqj9fhDneTjUJWdVMMrwNwVZk5kjC4f7S2mC) |

After the run, `GET /pay/reserves` returned `suiTotalShares == vaultShares == vaultSharesHeld == 7.021173325`, with `invariant: true` and `solvent: true`.

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
5. **Vault redeploys.** ShareVault's pool key is immutable, so each onchain redeploy of the AAPL pool meant a new vault and a fresh Sui pool. The active pair is ShareVault `0x76B1…Bd5d` on the final fee model with Sui pool `0xf414…2fe1`; earlier pairs ended 1:1 on mock tokens and are listed only in `deployments/sui-testnet.json`. The vault re-quotes the exact-input trade it executes and tops up the input so the payee always gets face value.
6. **No share bridge.** Shares never cross chains. Only credits (Sui) and issuer conversions (Unichain) move.
7. **Transfer restrictions unverified.** Native issuer behaviour on a generic node returned `OpcodeNotFound`, including an attempted holder transfer; that doesn't prove transfers are allowlisted. Mocks are used. Delivering a gated wrapper to an arbitrary recipient may fail in production, and in that case the withdrawal skips and the credit is restored.
8. **Testnet only.** Walrus has no public mainnet publisher, the Seal servers used are testnet open-mode servers, and the issuer tokens are mocks.
9. **Tax and regulation.** Paying with tokenized equity is jurisdiction-specific and is not determined by the protocol. Transferring a security as payment is not the same regulated activity as trading it.
10. **Relayer gas.** Each withdrawal settles inside `try/catch`, so a caller that trusts `eth_estimateGas` can hand the vault too little gas; the conversion then runs out of gas and is *skipped* (credit restored). This happened once on 1301 (`WithdrawalSkipped`, `FailedInnerCall`). The keeper sets an explicit limit of 300k gas plus 600k per withdrawal. A future vault revision should enforce a `gasleft()` floor per withdrawal on chain.
11. **Settlement gap.** Between `settleWithdrawals` on Unichain and `debit_withdrawal` on Sui (seconds), the vault is below the Sui total. `/pay/reserves` reports `invariant: false` for that interval; the UI shows it as "settling" for up to 60 s before calling it a mismatch.
12. **Cut from the plan for time.** zkLogin, sponsored gas, batch sharding (a single Batch per window serialises submits), dollar-denominated send, Postgres indexing and `/pay/history`.

READY FOR MERGE
