# WrapSwap demo video script — 3:00 hard cap

Placeholders used in this file: `{{URL:repo-readme-integrations}}`

- **Length.** 3:00 total: Part A 0:00–2:20, Part B 2:20–3:00. ETHGlobal rejects videos under 2:00 or over 4:00. Don't speed up footage to fit.
- **Voiceover.** Read it in your own voice; AI voiceovers are not allowed. The whole voiceover is 365 words, which is 2:26 at 150 wpm. Every block also fits its own slot at 150 wpm (tightest: B2, 44 words in 20 s = 17.6 s).
- **Numbers.** Every on-screen number comes from INTERFACES.md §10:
  - Part A uses **Variant ANVIL**: NYSE OPEN, block warped to `1790692200` (Tue 2026-09-29 10:30 EDT).
  - Part B uses **Variant UNICHAIN-SEPOLIA**: real clock, NYSE CLOSED Sat 2026-09-26 to Mon 2026-09-28 13:30 UTC.
  - If the app shows a different number, stop and re-seed. Don't narrate over a mismatch.
- **Tokens.** Demo tokens are mocks with issuer-faithful decimals and multipliers:
  - `mcbAAPL` mocks Coinbase tokenized AAPL: 6 decimals, 1.0125 shares per token.
  - `mAAPLx` mocks Backed xStocks AAPLx: 18 decimals, 1.0 share per token.
  - Parity: 1 mcbAAPL = 1.0125 mAAPLx.
- **Wording.** Call the unit "shares", never by a token name. Users only ever hold issuer tokens.

---

## Part A — local anvil stack, Variant ANVIL (0:00–2:20)

Start state: a fresh `scripts/dev/record-ready` stack, before any swap.
- Hook inventory: 8,000 mcbAAPL (8,100 shares) + 12,150 mAAPLx (12,150 shares); skew −0.20.
- Demo wallet (account 1): 500 mcbAAPL + 500 mAAPLx.

### A1 · 0:00–0:18 — The problem

- **Screen:** Title card, then the app's Convert tab showing the two issuer tokens side by side.
- **Voiceover (41 words):** "Apple stock now lives on-chain through several issuers: Coinbase's tokenized AAPL on Base, Backed's xStocks AAPLx, and more. Same share, separate wrappers, separate liquidity. Switching issuers today means selling into USDC and buying back. WrapSwap does share-for-share conversion, no USDC leg."
- **Caption:** `Same share · different wrappers · fragmented liquidity` → `WrapSwap: share-for-share conversion, no USDC leg`

### A2 · 0:18–0:58 — Convert, PARITY fill

- **Screen:**
  1. Convert tab. The header shows NYSE **OPEN**.
  2. From `mcbAAPL`, To `mAAPLx`, amount `100`.
  3. The quote panel shows the **PARITY** badge and a fee breakdown: base 2.00 bps + skew 2.60 bps + market closed 0.00 bps = **4.60 bps**; fee 0.046575 mAAPLx.
  4. Output **101.203425 mAAPLx**.
  5. Click Convert and wait for the receipt.
  6. The wallet now shows 400 mcbAAPL and 601.203425 mAAPLx.
- **Voiceover (76 words):** "This is our local stack with the market open. I convert 100 mcbAAPL, our mock of Coinbase's token, into mAAPLx. The adapter says each mcbAAPL is 1.0125 shares, so that's 101.25 shares. The badge says PARITY: the hook fills the whole swap from its own inventory, inside beforeSwap, at exactly the share ratio. The fee is two basis points base plus 2.6 for inventory skew, 4.6 total. I receive 101.203425 mAAPLx. No USDC, no curve slippage."
- **Caption:** `PARITY · 100 mcbAAPL = 101.25 shares → 101.203425 mAAPLx · fee 4.60 bps = 2.00 base + 2.60 skew + 0.00 closed`

### A3 · 0:58–1:25 — Pool tab: inventory and skew

- **Screen:**
  1. Pool tab. Inventory: **8,100 mcbAAPL** (8,201.25 shares) and **12,048.75 mAAPLx** (12,048.75 shares).
  2. The skew gauge moved from −0.20 to **−0.19**; the next skew fee is **2.47 bps**.
  3. Peg status: pool price vs parity 1.0125, guard 50 bps.
  4. The LP range around parity.
- **Voiceover (59 words):** "The Pool tab shows that inventory: ERC-6909 claims the hook holds inside the PoolManager. Skew moved from minus 0.20 to minus 0.19, so the next skew fee drops to 2.47 basis points. The fee prices inventory imbalance. If inventory can't cover a swap, it falls through to this same pool's concentrated liquidity, guarded to within 50 bps of parity."
- **Caption:** `Hook inventory (ERC-6909): 8,100 mcbAAPL · 12,048.75 mAAPLx · skew −0.20 → −0.19 · next skew fee 2.47 bps · peg guard 50 bps`

### A4 · 1:25–2:20 — Dark Cross: commit-reveal, residual settles into ParityHook

- **Screen:**
  1. Dark Cross tab. The current batch shows COMMIT, then REVEAL, then SETTLE.
  2. Counterparty A: sell **60 mcbAAPL**, limit **1.0100**, route residual ON.
  3. Counterparty B: sell **50.625 mAAPLx**, limit **1.0150**.
  4. Commit hashes appear, then the reveals.
  5. The crank settles at mid **1.0125**.
  6. The batch detail shows:
     - Crossed **50 mcbAAPL ↔ 50.625 mAAPLx**.
     - A receives **50.5996875 mAAPLx**; B receives **49.975 mcbAAPL** (5 bps per side).
     - Residual: **10 mcbAAPL → 10.120474125 mAAPLx** via ParityHook at **4.47 bps** (≥ min 10.1).
  7. The fills list shows `DARK-CROSS` and `DARK-RESIDUAL` rows under one settlement tx hash.
- **Voiceover (101 words):** "Bigger holders can cross off-book. Counterparty A commits to sell 60 mcbAAPL, limit 1.0100. B commits to sell 50.625 mAAPLx, limit 1.0150. Until reveal, the orders are only hashes. The crank settles at the 1.0125 mid: 50 mcbAAPL cross against 50.625 mAAPLx, five basis points per side. A's leftover 10 mcbAAPL doesn't wait for another batch. In the same unlock, it's swapped into the ParityHook pool: 10.12 mAAPLx out, at a 4.47 bps fee, above A's limit. So every flow, whether parity fill, fall-through or dark residual, settles through one hook. Commit-reveal hides orders until reveal; it isn't full cryptographic privacy."
- **Caption:** `Mid 1.0125 · crossed 50 mcbAAPL ↔ 50.625 mAAPLx · 5 bps/side · residual 10 mcbAAPL → 10.120474125 mAAPLx via ParityHook (4.47 bps) · one unlock`

---

## Part B — live Unichain Sepolia, Variant UNICHAIN-SEPOLIA (2:20–3:00)

Record while NYSE is closed (before Mon 2026-09-28 13:30 UTC). Show a **quote only**. The pool already holds live swaps, so the numbers below are the live 1301 quote **at time of writing** (block 63577136, Sat 2026-09-26 13:32 UTC). Any later swap moves the skew line, so read the final figures off the screen.

### B1 · 2:20–2:30 — Verified hook on Uniscan

- **Screen:** `https://sepolia.uniscan.xyz/address/0x1D2C9335813B8d3fFDCCC9d43aAf73d7871b20c8#code` → Contract tab, green "verified" check, `beforeSwap` in the source.
- **Voiceover (23 words):** "Same hook, live on Unichain Sepolia, verified. It gates swaps to non-US wallets via Coinbase's Verified Country attestation; testnet runs a demoMode bypass."
- **Caption:** `ParityHook · Unichain Sepolia (1301) · verified · non-US gate: Coinbase Verified Country EAS (demoMode on for testnet)`

### B2 · 2:30–2:50 — Live quote, NYSE closed

- **Screen:**
  1. `https://nichars-mac-mini.tail43cacc.ts.net/app` (live stack on the mini via Tailscale Funnel; see DEMO.md), Convert tab. The header shows NYSE **CLOSED** · next open Mon 13:30 UTC.
  2. From `mcbAAPL`, To `mAAPLx`, amount `100`.
  3. At time of writing (book long mAAPLx, |skew| 0.10), 100 mcbAAPL → mAAPLx reduces skew, so the breakdown is base 2.00 + skew 1.29 + **off-hours 0** = **3.29 bps**; output **101.21668875 mAAPLx**.
  4. Flip the direction (100 mAAPLx → mcbAAPL): it increases skew, so off-hours adds **1.64 bps** (15 bps × post-trade |skew| 0.109) = **4.93 bps**; the deployer's proof swap filled exactly this (98.71674 mcbAAPL out).
- **Voiceover (47 words):** "It's the weekend, so NYSE is closed. A same-share swap has no price risk; the only off-hours risk is that issuers can't rebalance until Monday. So a trade that rebalances the hook pays nothing extra, 3.29 bps, and one that deepens the skew pays 4.93."
- **Caption:** `NYSE CLOSED · rebalancing 3.29 bps (off-hours 0) · skew-increasing 4.93 bps (off-hours 15 bps × |post skew|)` (at time of writing)

### B3 · 2:50–3:00 — Integration table, close

- **Screen:** `{{URL:repo-readme-integrations}}`, the README "Uniswap stack integration" table, slow scroll. End card with the tagline.
- **Voiceover (21 words):** "Every Uniswap integration point is linked by line in the README, alongside our v4 feedback. WrapSwap: share-for-share conversion, no USDC leg."
- **Caption:** `github.com · README → Uniswap stack integration` → `WrapSwap — share-for-share conversion, no USDC leg`

---

## Number check (§10)

| On screen | Variant | §10 source |
|---|---|---|
| 1.0125 shares per mcbAAPL; 100 mcbAAPL = 101.25 shares | shared | `sharesPerTokenX18`, `parityFill.shares` |
| 8,000 mcbAAPL / 12,150 mAAPLx start inventory, skew −0.20, skew fee 2.60 bps | shared | `inventory`, `skewX18.initial`, `parityFill.skewPips = 260` |
| 4.60 bps, fee 0.046575, out 101.203425 mAAPLx | ANVIL | `variants.anvil.parityFill` |
| 400 mcbAAPL + 601.203425 mAAPLx after the fill | ANVIL | `variants.anvil.end.demoMAAPLx/demoMcbAAPL` |
| 8,100 mcbAAPL / 12,048.75 mAAPLx, skew −0.19, next 2.47 bps | shared | Step 1 "Inventory after", `skewX18.afterParityFill`, `residual.skewPips = 247` |
| A 60 mcbAAPL @1.0100, B 50.625 mAAPLx @1.0150, mid 1.0125 | shared | `dark.orders`, `dark.oracleMidX18` |
| crossed 50 ↔ 50.625; A gets 50.5996875; B gets 49.975 | shared | `dark.crossedBase/crossedQuote`, `dark.crossOut` |
| residual 10 mcbAAPL → 10.120474125 mAAPLx, 4.47 bps, min 10.1 | ANVIL | `variants.anvil.residual`, `dark.residual.minOut` |
| 3.29 bps = 2.00 + 1.29 + 0 off-hours (skew-reducing), out 101.21668875; reverse 4.93 bps = 2.00 + 1.29 + 1.64 (at time of writing) | UNICHAIN-SEPOLIA | live `ParityHook.quote` on 1301, block 63580053 |
| next open Mon 2026-09-28 13:30 UTC | UNICHAIN-SEPOLIA | `variants.unichain-sepolia.nextOpen = 1790602200` |

## Technical claims in the voiceover → source

| Claim | Source |
|---|---|
| Hook fills from inventory inside beforeSwap at the share ratio | [`ParityHook.beforeSwap` (ParityHook.sol#L226)](../contracts/src/ParityHook.sol#L226); DECISIONS.md "Fills are all-or-nothing from inventory via beforeSwapReturnDelta" |
| Fee = 2 bps base + skew + off-hours 15 bps·\|post-trade skew\| on skew-increasing trades, cap 25 bps | [`ParityHook.feeBreakdown` (ParityHook.sol#L171)](../contracts/src/ParityHook.sol#L171); DECISIONS.md "Fee is expressed in pips: min(200 + ceil(1300·\|skew\|) + (NYSE closed and the trade increases \|skew\| ? ceil(1500·\|post-trade skew\|) : 0), 2500)" |
| Inventory is ERC-6909 claims in the PoolManager | [`ParityHook.depositInventory` (ParityHook.sol#L119)](../contracts/src/ParityHook.sol#L119); DECISIONS.md "Inventory is ERC-6909 claims owned by ParityHook in the PoolManager" |
| Fall-through to the same pool, 50 bps peg guard | [`ParityHook.afterSwap` (ParityHook.sol#L279)](../contracts/src/ParityHook.sol#L279); DECISIONS.md "afterSwap reverts when the post-swap price is more than 50 bps from adapter parity" |
| Commit-reveal; settle at oracle mid; 5 bps per side | [`DarkCrossHook.commit` (DarkCrossHook.sol#L185)](../contracts/src/DarkCrossHook.sol#L185), [`DarkCrossHook.reveal` (DarkCrossHook.sol#L212)](../contracts/src/DarkCrossHook.sol#L212); DECISIONS.md "crossing charges 5 bps per side to treasury" |
| Residual swapped into the ParityHook pool in the same unlock | [`DarkCrossHook.settle` (DarkCrossHook.sol#L246)](../contracts/src/DarkCrossHook.sol#L246); DECISIONS.md "routes residuals into the ParityHook pool inside the same unlock" |
| Non-US gate via Coinbase Verified Country EAS; demoMode on testnet | [`IEligibility.check` (IEligibility.sol#L21)](../contracts/src/interfaces/IEligibility.sol#L21), [`IEligibility.setDemoMode` (IEligibility.sol#L18)](../contracts/src/interfaces/IEligibility.sol#L18); DECISIONS.md "IEligibility has an EAS implementation (Coinbase Verified Country, restricted country \"US\")… demoMode is owner-set and emits DemoModeSet" |
| NYSE closed read from the chain clock | [`NyseCalendar.isOpen` (NyseCalendar.sol#L54)](../contracts/src/NyseCalendar.sol#L54); DECISIONS.md "Market-hours logic everywhere reads the latest block timestamp" |
