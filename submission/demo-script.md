# Unison demo video script — 3:00 hard cap

Placeholders used in this file: `{{URL:repo-readme-integrations}}`

- **Length.** 3:00 total: Part A 0:00–2:20, Part B 2:20–3:00. ETHGlobal rejects videos under 2:00 or over 4:00. Don't speed up footage to fit.
- **Voiceover.** Read it in your own voice; AI voiceovers are not allowed. The whole voiceover is 360 words, which is 2:24 at 150 wpm. Every block also fits its own slot at 150 wpm (tightest: B1, 23 words in 10 s = 9.2 s).
- **Numbers.** Every on-screen number comes from `packages/types/src/generated/demo.ts` (INTERFACES.md §10) or, for Part B, DEMO.md §4:
  - Part A uses **Variant ANVIL**: block warped to `1790692200`.
  - Part B uses **Variant UNICHAIN-SEPOLIA**: the live 1301 pools ("Seed state at deploy block 63586745" in §10; live figures at time of writing). The fee has no market-hours input.
  - If the app shows a different number, stop and re-seed. Don't narrate over a mismatch.
- **Tokens.** Demo tokens are mocks with issuer-faithful decimals and multipliers:
  - `mcbAAPL` mocks Coinbase tokenized AAPL: 6 decimals, 1.0125 shares per token.
  - `mAAPLx` mocks Backed xStocks AAPLx: 18 decimals, 1.0 share per token.
  - Parity: 1 mcbAAPL = 1.0125 mAAPLx.
- **Wording.** Call the unit "shares", never by a token name. Users only ever hold issuer tokens.

---

## Part A — local anvil stack, Variant ANVIL (0:00–2:20)

Start state: a fresh `scripts/dev/record-ready` stack, before any swap.
- Hook inventory: 8,000 mcbAAPL + 12,150 mAAPLx; skew −0.20.
- Demo wallet (account 1): 500 mcbAAPL + 500 mAAPLx.

### A1 · 0:00–0:18 — The problem

- **Screen:** Title card, then the app's Move → Convert view showing the two issuer tokens side by side.
- **Voiceover (41 words):** "Apple stock now lives on-chain through several issuers: Coinbase's tokenized AAPL on Base, Backed's xStocks AAPLx, and more. Same share, separate wrappers, separate liquidity. Switching issuers today means selling for cash and buying back. Unison does share-for-share conversion, no cash leg."
- **Caption:** `Same share · different wrappers · fragmented liquidity` → `Unison: share-for-share conversion, no cash leg`

### A2 · 0:18–0:58 — Convert, PARITY fill

- **Screen:**
  1. Move → Convert.
  2. From `mcbAAPL`, To `mAAPLx`, amount `100`.
  3. The quote card shows shares in 101.25, base fee 2.00 bps, skew fee "0 — this trade rebalances the pool" = **2.00 bps**; fee 0.02025 mAAPLx.
  4. Output **101.22975 mAAPLx**.
  5. Click Convert and wait for the receipt.
  6. The wallet now shows 400 mcbAAPL and 601.22975 mAAPLx.
- **Voiceover (78 words):** "This is our local stack. I convert 100 mcbAAPL, our mock of Coinbase's token, into mAAPLx. The adapter says each mcbAAPL is 1.0125 shares, so that's 101.25 shares. The badge says PARITY: the hook fills the whole swap from its own inventory, inside beforeSwap, at exactly the share ratio. This trade rebalances the pool, so it pays only the two basis point base fee, all to the LP. I receive 101.22975 mAAPLx. No cash leg, no curve slippage."
- **Caption:** `PARITY · 100 mcbAAPL = 101.25 shares → 101.22975 mAAPLx · fee 2.00 bps base + 0 skew (rebalancing)`

### A3 · 0:58–1:25 — Liquidity tab: inventory and skew

- **Screen:**
  1. Liquidity tab, AAPL. Hook inventory per wrapper (read it off the screen).
  2. The skew gauge moved from −0.20 to **−0.19**. The fee in each direction: the rebalancing direction pays the base fee only.
  3. Peg status: pool price vs parity 1.0125, guard 50 bps.
  4. The LP range around parity.
- **Voiceover (58 words):** "The Liquidity tab shows that inventory: ERC-6909 claims the hook holds inside the PoolManager. Skew moved from minus 0.20 to minus 0.19. The skew fee prices inventory imbalance, and only trades that deepen it pay it. If inventory can't cover a swap, it falls through to this same pool's concentrated liquidity, guarded to within 50 bps of parity."
- **Caption:** `Hook inventory (ERC-6909) · skew −0.20 → −0.19 · skew fee only on imbalance-increasing trades · peg guard 50 bps`

### A4 · 1:25–2:20 — Dark Cross: commit-reveal, residual fills from ParityHook

- **Screen:**
  1. Move → Dark Cross. The current batch shows COMMIT, then REVEAL, then SETTLE.
  2. Counterparty A: sell **60 mcbAAPL**, limit **1.0100**, route residual ON.
  3. Counterparty B: sell **50.625 mAAPLx**, limit **1.0150**.
  4. Commit hashes appear, then the reveals.
  5. The crank settles at mid **1.0125**.
  6. The batch detail shows:
     - Crossed **50 mcbAAPL ↔ 50.625 mAAPLx**.
     - A receives **50.6199375 mAAPLx**; B receives **49.995 mcbAAPL** (1 bp of each side's crossed amount, to the protocol).
     - Residual: **10 mcbAAPL → 10.122975 mAAPLx** filled from ParityHook inventory at **2.00 bps** (≥ min 10.1).
  7. The fills list shows `DARK-CROSS` and `DARK-RESIDUAL` rows under one settlement tx hash.
- **Voiceover (96 words):** "Bigger holders can cross off-book. Counterparty A commits to sell 60 mcbAAPL, limit 1.0100. B commits to sell 50.625 mAAPLx, limit 1.0150. Until reveal, the orders are only hashes. The crank settles at the 1.0125 mid: 50 mcbAAPL cross against 50.625 mAAPLx, one basis point per side to the protocol. A's leftover 10 mcbAAPL doesn't wait for another batch. In the same unlock, it fills from ParityHook inventory: 10.12 mAAPLx out, at the 2 bps base fee, above A's limit. Anything inventory can't fill is refunded. Commit-reveal hides orders until reveal; it isn't full cryptographic privacy."
- **Caption:** `Mid 1.0125 · crossed 50 mcbAAPL ↔ 50.625 mAAPLx · 1 bp per side to protocol · residual 10 mcbAAPL → 10.122975 mAAPLx via ParityHook (2 bps base, to the LP)`

---

## Part B — live Unichain Sepolia, Variant UNICHAIN-SEPOLIA (2:20–3:00)

Show a **quote only**. The fee has no market-hours input. The pool already holds live swaps, so the numbers below are the live 1301 quote **at time of writing** (block 63589883, Sat 2026-09-26 17:05 UTC). Any later swap moves the skew line, so read the final figures off the screen.

### B1 · 2:20–2:30 — Verified hook on Uniscan

- **Screen:** `https://sepolia.uniscan.xyz/address/0x484bc6aa8f6D472AD67F3ce8dD86f1f8A166e0c8#code` → Contract tab, green "verified" check, `beforeSwap` in the source.
- **Voiceover (23 words):** "Same hook, live on Unichain Sepolia, verified. It gates swaps to non-US wallets via Coinbase's Verified Country attestation; testnet runs a demoMode bypass."
- **Caption:** `ParityHook · Unichain Sepolia (1301) · verified · non-US gate: Coinbase Verified Country EAS (demoMode on for testnet)`

### B2 · 2:30–2:50 — Live quote, both directions

- **Screen:**
  1. `https://nichars-mac-mini.tail43cacc.ts.net/app` (live stack on the mini via Tailscale Funnel; see DEMO.md), Move → Convert, asset AAPL.
  2. From `mcbAAPL`, To `mAAPLx`, amount `100`.
  3. At time of writing, AAPL inventory is long mAAPLx (|skew| 0.188), so 100 mcbAAPL → mAAPLx reduces skew: the breakdown is base 2.00 + **skew 0** = **2.00 bps**; output **101.22975 mAAPLx**.
  4. Flip the direction (100 mAAPLx → mcbAAPL): it deepens the imbalance, so the skew fee applies: 2.00 + **2.97** (15 bps × post-trade |skew|) = **4.97 bps**, output 98.716345 mcbAAPL (at time of writing). The deployer's proof swap at deploy time filled this side at 5.14 bps.
- **Voiceover (43 words):** "A same-share swap has no price risk, so the base fee is 2 basis points. Only a trade that deepens the hook's inventory imbalance pays a skew fee: this way 2.00 bps, the other way 4.97. All of it goes to the LP."
- **Caption:** `cheap direction 2.00 bps (skew fee 0) · imbalance-increasing 4.97 bps (+ 15 bps × |post skew|) · 100% to the LP` (at time of writing)

### B3 · 2:50–3:00 — Integration table, close

- **Screen:** `{{URL:repo-readme-integrations}}`, the README "Verify the integration" section, slow scroll. End card with the tagline.
- **Voiceover (21 words):** "Every Uniswap integration point is linked by line in the README, alongside our v4 feedback. Unison: share-for-share conversion, no cash leg."
- **Caption:** `github.com · README → Verify the integration` → `Unison — share-for-share conversion, no cash leg`

---

## Number check (§10)

| On screen | Variant | Source (`packages/types/src/generated/demo.ts` unless noted) |
|---|---|---|
| 1.0125 shares per mcbAAPL; 100 mcbAAPL = 101.25 shares | shared | `tokens.mcbAAPL.sharesPerTokenX18`, `parityFill.shares` |
| 8,000 mcbAAPL / 12,150 mAAPLx start inventory, skew −0.20 | shared | `inventory`, `skewX18.initial` |
| 2.00 bps, fee 0.02025, out 101.22975 mAAPLx | ANVIL | `variants.anvil.parityFill` |
| 400 mcbAAPL + 601.22975 mAAPLx after the fill | ANVIL | `variants.anvil.end.demoMcbAAPL/demoMAAPLx` |
| skew −0.19 after the fill | shared | `skewX18.afterParityFill` |
| A 60 mcbAAPL @1.0100, B 50.625 mAAPLx @1.0150, mid 1.0125 | shared | `dark.orders`, `dark.oracleMidX18` |
| crossed 50 ↔ 50.625; A gets 50.6199375; B gets 49.995; 1 bp | shared | `dark.crossedBase/crossedQuote`, `dark.crossOut`, `dark.crossFeePips = 100` |
| residual 10 mcbAAPL → 10.122975 mAAPLx, 2.00 bps, min 10.1 | ANVIL | `variants.anvil.residual`, `dark.residual.minOut` |
| 2.00 bps (skew-reducing), out 101.22975; reverse 4.97 bps = 2.00 + 2.97 skew, out 98.716345 mcbAAPL (at time of writing) | UNICHAIN-SEPOLIA | DEMO.md §4.1 (live `ParityHook.quote` on 1301, block 63589883) |
| deploy-time proof swap at 5.14 bps | UNICHAIN-SEPOLIA | README.md proof transactions |

## Technical claims in the voiceover → source

| Claim | Source |
|---|---|
| Hook fills from inventory inside beforeSwap at the share ratio | [`ParityHook.beforeSwap` (ParityHook.sol#L245)](../contracts/src/ParityHook.sol#L245); DECISIONS.md "Fills are all-or-nothing from inventory via beforeSwapReturnDelta" |
| Fee = 2 bps base (owner-settable) + min(15·\|post-trade skew\|, 50) bps on imbalance-increasing trades, 100% to the LP | [`ParityHook`](../contracts/src/ParityHook.sol): `DEFAULT_BASE_FEE_PIPS`, `SKEW_FEE_PIPS`, `SKEW_FEE_CAP_PIPS`, `quote`, `feeBreakdown` |
| Inventory is ERC-6909 claims in the PoolManager | [`ParityHook.depositInventory` (ParityHook.sol#L126)](../contracts/src/ParityHook.sol#L126); DECISIONS.md "Inventory is ERC-6909 claims owned by ParityHook in the PoolManager" |
| Fall-through to the same pool, 50 bps peg guard | [`ParityHook.afterSwap` (ParityHook.sol#L297)](../contracts/src/ParityHook.sol#L297); DECISIONS.md "afterSwap reverts when the post-swap price is more than 50 bps from adapter parity" |
| Commit-reveal; settle at the oracle mid (≤ 30 min old); 1 bp on crossed volume to the protocol; residual to ParityHook at base + skew, unfilled part refunded | [`DarkCrossHook.commit` (DarkCrossHook.sol#L201)](../contracts/src/DarkCrossHook.sol#L201), [`DarkCrossHook.reveal` (DarkCrossHook.sol#L228)](../contracts/src/DarkCrossHook.sol#L228); `DarkCrossHook.CROSS_FEE_PIPS = 100` (1 bp) |
| Residual swapped into the ParityHook pool in the same unlock | [`DarkCrossHook.settle` (DarkCrossHook.sol#L262)](../contracts/src/DarkCrossHook.sol#L262); DECISIONS.md "routes residuals into the ParityHook pool inside the same unlock"; residual fills from inventory only, unfilled part refunded (DECISIONS.md "final fee model") |
| Non-US gate via Coinbase Verified Country EAS; demoMode on testnet | [`IEligibility.check` (IEligibility.sol#L21)](../contracts/src/interfaces/IEligibility.sol#L21), [`IEligibility.setDemoMode` (IEligibility.sol#L18)](../contracts/src/interfaces/IEligibility.sol#L18); DECISIONS.md "IEligibility has an EAS implementation (Coinbase Verified Country, restricted country \"US\")… demoMode is owner-set and emits DemoModeSet" |
