# ETHGlobal Tokyo 2026 — project submission draft

Placeholders used in this file: `{{URL:repo}}`, `{{URL:web-live}}`, `{{URL:video}}`, `{{URL:uniscan-parityhook}}`, `{{URL:uniscan-darkcrosshook}}`, `{{URL:uniscan-eligibility}}`, `{{URL:addr-parityhook}}`, `{{URL:addr-darkcrosshook}}`, `{{URL:addr-eligibility}}`, `{{URL:addr-registry}}`, `{{URL:addr-calendar}}`, `{{URL:addr-oracle}}`, `{{URL:addr-mcbaapl}}`, `{{URL:addr-maaplx}}`, `{{URL:feedback-md}}`

**About these fields.** The Hacker Dashboard form sits behind a login and the public event page returned HTTP 500 on 2026-09-26, so the exact form fields couldn't be fetched. The public [event details page](https://ethglobal.com/events/tokyo2026/info/details) confirms the dashboard asks for a title, a description and a repository link, lets you pick up to three partner prizes (each with an integration explanation and feedback), and requires disclosure of AI use. The fields below follow that plus the lane's fallback list. **Confirm the field names in the dashboard before pasting.**

Rules from the details page that affect this submission:
- The deadline is **Sun 2026-09-27 09:00 JST**, which is Sat 2026-09-26 24:00 UTC.
- The video must be 2–4 minutes, at least 720p, with a real human voice, no AI voiceover, no speed changes, and an intro under 20 s.
- The repo must show commit history from during the hackathon.
- AI use must be documented, including which files are AI-generated and any spec or prompt files.

---

## Project name

WrapSwap

## Short description (≤100 chars)

Uniswap v4 hook: share-for-share conversion between tokenized-stock wrappers, no USDC leg.

## Description

The same Apple share trades on-chain through different issuers, such as Coinbase's tokenized AAPL on Base and Backed's xStocks AAPLx. Each wrapper has its own liquidity, so switching issuers today means selling into USDC and buying back.

WrapSwap is share-for-share conversion, no USDC leg. A Uniswap v4 hook, ParityHook, runs directly on a pool of the two issuer tokens and is the settlement engine for every flow:

- **Parity fill.** The hook fills the whole swap from its own ERC-6909 inventory at the adapters' share ratio (1 mcbAAPL = 1.0125 shares = 1.0125 mAAPLx in the demo). The fee is 2 bps base, plus up to 13 bps for inventory skew, plus 10 bps while NYSE is closed, capped at 25 bps.
- **Fall-through.** If inventory can't cover a swap, it executes against the same pool's concentrated liquidity. A 50 bps peg guard reverts any swap that would move the price further than that from parity.
- **Dark cross.** Larger orders commit, reveal and cross in a batch at an oracle mid, 5 bps per side. The uncrossed residual is swapped into the ParityHook pool inside the same `unlock`.

Users only ever hold real issuer securities; shares are internal accounting. Swaps are gated to non-US users through the Coinbase Verified Country EAS attestation. On testnet, an owner-set `demoMode` bypasses the gate so anyone can try it, and that toggle is public on-chain.

The closed-market fee is deliberate: the hook keeps quoting when NYSE is closed and prices the off-hours risk. On Unichain Sepolia this weekend, the same 100 mcbAAPL quote is 14.60 bps (101.102175 mAAPLx out), against 4.60 bps (101.203425 mAAPLx out) with the market open.

## How it's made

- **Contracts.** Solidity 0.8.26 (cancun, via-IR) with Foundry, pinned to v4-core `46c6834` and v4-periphery `9969eec` (DECISIONS.md: "Pin compatible current core/periphery commits").
- **ParityHook** uses the `beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta` permissions, mined into its address through the CREATE2 proxy.
  - `beforeInitialize` accepts only dynamic-fee pools of two registered wrappers of one underlying.
  - `beforeSwap` computes the fee from pre-swap inventory skew and the on-chain NYSE calendar. It then either returns a full `BeforeSwapDelta` that mints and burns ERC-6909 claims, or returns a zero delta so the swap falls through.
  - `afterSwap` enforces the peg guard.
  - Every path returns the fee as a per-swap LP-fee override.
  - Rounding always favours the hook.
  - Sources: [`ParityHook.beforeSwap` (ParityHook.sol#L226)](../contracts/src/ParityHook.sol#L226), [`ParityHook.afterSwap` (ParityHook.sol#L279)](../contracts/src/ParityHook.sol#L279), [`ParityHook.quote` (ParityHook.sol#L176)](../contracts/src/ParityHook.sol#L176); DECISIONS.md: "Rounding favours the hook".
- **DarkCrossHook** has no pool attached. It escrows the token being sold, verifies commit hashes on reveal, and settles permissionlessly at an oracle mid, which must be no older than 900 s. Residuals route into the ParityHook pool within one `PoolManager.unlock`, and a failure on one trader's residual is isolated from the rest of the batch. Sources: [`DarkCrossHook.settle` (DarkCrossHook.sol#L246)](../contracts/src/DarkCrossHook.sol#L246); DECISIONS.md: "Isolate unfillable residual self-calls and unlock their collateral".
- **Eligibility** checks a Coinbase Verified Country EAS attestation: trusted attester, recipient, not revoked or expired, country ≠ "US". A router-supplied swapper in `hookData` is honoured only for allowlisted routers. Source: [`IEligibility.resolveSwapper` (IEligibility.sol#L28)](../contracts/src/interfaces/IEligibility.sol#L28).
- **Off-chain.** A TypeScript API and indexer on Postgres 16. The indexer handles reorgs with block-hash cascades (DECISIONS.md: "Indexer reorg safety comes from cascading deletes"). A crank pushes the mock oracle mid, runs `checkPeg` and settles batches. The web app uses React, Vite and viem, and a shared `@wrapswap/types` package re-verifies the canonical demo arithmetic on every build.
- **Tricky parts** (detailed in FEEDBACK.md):
  - Signing the `BeforeSwapDelta` correctly for exact-in and exact-out.
  - Keeping fee claims separate from ERC-6909 inventory.
  - The fee override not persisting in slot0.
  - Coinbase's B20 token not executing on generic Anvil, so the demo uses mocks with issuer-faithful decimals and multipliers.

## Tech stack

Solidity 0.8.26, Foundry, Uniswap v4-core / v4-periphery (PoolManager, ERC-6909 claims, dynamic fees, PositionManager, Permit2, V4Quoter), Ethereum Attestation Service (Coinbase Verified Country), Unichain Sepolia, TypeScript, Node.js, viem, Postgres 16, React + Vite, Playwright.

## AI usage (required disclosure)

The project was built with AI coding agents (Claude) working in parallel lanes against a written spec. The spec and planning artifacts are in the repo: `INTERFACES.md` (the frozen interface spec), `DECISIONS.md` (the decision log), `PROGRESS.md`, and `interface-change-requests/`. The submission texts in `submission/` and `FEEDBACK.md` were AI-drafted and owner-reviewed. **OWNER:** before submitting, confirm that the orchestration prompts are committed as ETHGlobal requires, and say here which parts you wrote or directed.

## Links

- Repo: {{URL:repo}}
- Live demo: {{URL:web-live}}
- Video: {{URL:video}}

## Contract addresses (Unichain Sepolia, chain 1301)

| Contract | Address | Explorer |
|---|---|---|
| ParityHook | {{URL:addr-parityhook}} | {{URL:uniscan-parityhook}} |
| DarkCrossHook | {{URL:addr-darkcrosshook}} | {{URL:uniscan-darkcrosshook}} |
| Eligibility (EAS) | {{URL:addr-eligibility}} | {{URL:uniscan-eligibility}} |
| IssuerRegistry | {{URL:addr-registry}} | — |
| NyseCalendar | {{URL:addr-calendar}} | — |
| Mock price oracle | {{URL:addr-oracle}} | — |
| mcbAAPL (mock Coinbase AAPL, 6 dec) | {{URL:addr-mcbaapl}} | — |
| mAAPLx (mock xStocks AAPLx, 18 dec) | {{URL:addr-maaplx}} | — |

Uniswap v4 PoolManager and periphery: the official Unichain Sepolia deployments listed in `deployments/unichain-sepolia.json`.

## Prize tracks

- **Uniswap: Best Uniswap Stack Contribution** (primary).
  - *How we used it:* ParityHook is a generic wrapper-parity hook primitive. It shows a settlement-engine pattern for custom-accounting hooks: an all-or-nothing `beforeSwapReturnDelta` fill from ERC-6909 claims, with a zero-delta fall-through to the same pool under a peg guard and one fee schedule through the LP-fee override. DarkCrossHook settles dark-cross residuals into that pool inside a single `unlock`. See the README "Uniswap stack integration" table for line-linked integration points.
  - *Feedback:* paste the short form from `submission/feedback-form.md` answers 11 and 17, and link {{URL:feedback-md}}.
- Up to two more partner prizes may be selected. **OWNER:** decide; none are drafted here.
