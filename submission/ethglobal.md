# ETHGlobal Tokyo 2026 — project submission draft

Placeholders used in this file: `{{URL:repo}}`, `{{URL:video}}`, `{{URL:feedback-md}}`

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

The off-hours fee is deliberate and narrow: a same-share swap carries no underlying price risk, so off-hours the only risk is rebalancing lag (issuers can't mint or redeem until the open), which grows with inventory skew. The hook keeps quoting when NYSE is closed and charges 15 bps × |post-trade skew| only to trades that increase skew. On Unichain Sepolia this weekend (book |skew| 0.10), 100 mcbAAPL → mAAPLx rebalances and costs 3.29 bps; the reverse deepens skew and costs 4.93 bps (1.64 bps off-hours), at time of writing.

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
- Live demo: https://nichars-mac-mini.tail43cacc.ts.net/app (landing: https://nichars-mac-mini.tail43cacc.ts.net)
- Video: {{URL:video}}

## Contract addresses (Unichain Sepolia, chain 1301)

<!-- testnet:start -->
Unichain Sepolia (chain 1301). Manifest: [`deployments/unichain-sepolia.json`](deployments/unichain-sepolia.json), deploy commit `b4ef312`, start block 63572662, pool id `0xfb36965758ff8acaa8074d8349af34ba6b914298b27032abe95bd4ef06252821`. Eligibility runs with `demoMode` on (testnet).

| Contract | Address | Uniscan (source) |
| --- | --- | --- |
| ParityHook | `0x4142CA2E270A3f94cB8B56b1F6e1C74465a8a0c8` | [verified](https://sepolia.uniscan.xyz/address/0x4142CA2E270A3f94cB8B56b1F6e1C74465a8a0c8#code) |
| DarkCrossHook (AAPL) | `0xBfcdFf560AaEe80E9030be7574e2451a1296883A` | [verified](https://sepolia.uniscan.xyz/address/0xBfcdFf560AaEe80E9030be7574e2451a1296883A#code) |
| WrapSwapRouter | `0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3` | [verified](https://sepolia.uniscan.xyz/address/0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3#code) |
| IssuerRegistry | `0xA5d433FA4E90D21859B325Be34F0B8845F8E9070` | [verified](https://sepolia.uniscan.xyz/address/0xA5d433FA4E90D21859B325Be34F0B8845F8E9070#code) |
| NyseCalendar | `0x70396f1Be86e3d7F70C017cbbe69efED861387A1` | [verified](https://sepolia.uniscan.xyz/address/0x70396f1Be86e3d7F70C017cbbe69efED861387A1#code) |
| EASEligibility | `0x85ABBc06C69D9426907352034a5A7C3D30EB5C5A` | [verified](https://sepolia.uniscan.xyz/address/0x85ABBc06C69D9426907352034a5A7C3D30EB5C5A#code) |
| MockPriceOracle | `0xBe2fb3259454F35bC5999f345873c870b5DE3dB1` | [verified](https://sepolia.uniscan.xyz/address/0xBe2fb3259454F35bC5999f345873c870b5DE3dB1#code) |
| MockIssuerToken mcbAAPL (Coinbase, 6 dec) | `0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c` | [verified](https://sepolia.uniscan.xyz/address/0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c#code) |
| B20MultiplierAdapter (mcbAAPL) | `0xc3bE8635F1CB05aBCd5DF001157aAb9349184828` | [verified](https://sepolia.uniscan.xyz/address/0xc3bE8635F1CB05aBCd5DF001157aAb9349184828#code) |
| MockIssuerToken mAAPLx (xStocks, 18 dec) | `0x433DAfF77AD96b9319957D83d9d422E70c996C45` | [verified](https://sepolia.uniscan.xyz/address/0x433DAfF77AD96b9319957D83d9d422E70c996C45#code) |
| XStocksMultiplierAdapter (mAAPLx) | `0x577C983f0c3cf3868d543C1c4cbb2807B65ddA78` | [verified](https://sepolia.uniscan.xyz/address/0x577C983f0c3cf3868d543C1c4cbb2807B65ddA78#code) |
| MockIssuerToken mcbNVDA (Coinbase, 6 dec) | `0x9b1dc2Cb4cF7b3e514555944E5cE07A54265A2D2` | [verified](https://sepolia.uniscan.xyz/address/0x9b1dc2Cb4cF7b3e514555944E5cE07A54265A2D2#code) |
| B20MultiplierAdapter (mcbNVDA) | `0xF76aC3064b5b8a458a46e281acf047069F2eD762` | [verified](https://sepolia.uniscan.xyz/address/0xF76aC3064b5b8a458a46e281acf047069F2eD762#code) |
| MockIssuerToken mNVDAx (xStocks, 18 dec) | `0xEdcD509ab5404529ed5169379EeE14A755E3027c` | [verified](https://sepolia.uniscan.xyz/address/0xEdcD509ab5404529ed5169379EeE14A755E3027c#code) |
| XStocksMultiplierAdapter (mNVDAx) | `0x612b15a552D49616A60aa4B740A84D3e2E306211` | [verified](https://sepolia.uniscan.xyz/address/0x612b15a552D49616A60aa4B740A84D3e2E306211#code) |
| MockIssuerToken mcbTSLA (Coinbase, 6 dec) | `0x0757eEe1292046c7303f5C603001e0a9069a6B80` | [verified](https://sepolia.uniscan.xyz/address/0x0757eEe1292046c7303f5C603001e0a9069a6B80#code) |
| B20MultiplierAdapter (mcbTSLA) | `0x2De6944b9c3C00c9Fe2f407C91DF28c7283c8Ef6` | [verified](https://sepolia.uniscan.xyz/address/0x2De6944b9c3C00c9Fe2f407C91DF28c7283c8Ef6#code) |
| MockIssuerToken mTSLAx (xStocks, 18 dec) | `0x752746b311B256170f1a3156B34465D5A4363153` | [verified](https://sepolia.uniscan.xyz/address/0x752746b311B256170f1a3156B34465D5A4363153#code) |
| XStocksMultiplierAdapter (mTSLAx) | `0x81e70214de47206a58c03179291e7DD8e2C168a5` | [verified](https://sepolia.uniscan.xyz/address/0x81e70214de47206a58c03179291e7DD8e2C168a5#code) |
| TestShareFaucet (1,000 of each wrapper / 24 h) | `0xD25b4916eC55aA1F550052ff90d1EcD6B51AABdC` | [verified](https://sepolia.uniscan.xyz/address/0xD25b4916eC55aA1F550052ff90d1EcD6B51AABdC#code) |
| PoolSwapTest | `0x8525eD020Aa0CEa75884546b834d1eb40D3987b3` | [verified](https://sepolia.uniscan.xyz/address/0x8525eD020Aa0CEa75884546b834d1eb40D3987b3#code) |
| PoolModifyLiquidityTest | `0x57428942dEC15511cE19700877001813EE5fE81d` | [verified](https://sepolia.uniscan.xyz/address/0x57428942dEC15511cE19700877001813EE5fE81d#code) |

Canonical Uniswap v4 (from Uniswap's deployment docs): PoolManager [`0x00B036B58a818B1BC34d502D3fE730Db729e62AC`](https://sepolia.uniscan.xyz/address/0x00B036B58a818B1BC34d502D3fE730Db729e62AC), V4Quoter [`0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472`](https://sepolia.uniscan.xyz/address/0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472), StateView [`0xc199F1072a74D4e905ABa1A84d9a45E2546B6222`](https://sepolia.uniscan.xyz/address/0xc199F1072a74D4e905ABa1A84d9a45E2546B6222), PositionManager [`0xf969Aee60879C54bAAed9F3eD26147Db216Fd664`](https://sepolia.uniscan.xyz/address/0xf969Aee60879C54bAAed9F3eD26147Db216Fd664). EAS: OP-stack predeploy `0x4200000000000000000000000000000000000021`.

ParityHook pools (one hook, dynamic fee, tick spacing 10):

- AAPL (mcbAAPL / mAAPLx): pool id `0xfb36965758ff8acaa8074d8349af34ba6b914298b27032abe95bd4ef06252821` · Dark Cross
- NVDA (mcbNVDA / mNVDAx): pool id `0x4bf2d33a06bd7604898199c65e34bc8e74ddc9c9d0e3e0569c99e947abcc4173`
- TSLA (mcbTSLA / mTSLAx): pool id `0x428b5ab44fd961a0c84b554a924b93a4a8d4598ddf1b6414a3be95449062f339`

Proof transactions:

- Deployer WrapSwapRouter.swapExactIn, 100 mAAPLx -> 98.71674 mcbAAPL (skew-increasing, off-hours 1.64 bps, total 4.93 bps): [`0x8fb8d9c3c90cb31c830ec331197e62b10f3fa9b0f50c5689b5e78dc6ecc5ac12`](https://sepolia.uniscan.xyz/tx/0x8fb8d9c3c90cb31c830ec331197e62b10f3fa9b0f50c5689b5e78dc6ecc5ac12)
- Dark Cross batch 16 settled by the crank (2 crossed, residual routed through ParityHook): [`0x43cdac4b32a03c49b6f7dc937a094a4f94861b172df5380391cace646571bb0e`](https://sepolia.uniscan.xyz/tx/0x43cdac4b32a03c49b6f7dc937a094a4f94861b172df5380391cace646571bb0e)
- TestShareFaucet.claim() (1,000 of each of 6 wrappers): [`0x5fd33936c421b2046415fbae6197ba09fee575d4f95755b4ad31ee19017913ca`](https://sepolia.uniscan.xyz/tx/0x5fd33936c421b2046415fbae6197ba09fee575d4f95755b4ad31ee19017913ca)

Test funds: `TestShareFaucet.claim()` sends 1,000 of every mock wrapper (once per address per 24 h). Unichain Sepolia ETH faucets (from Unichain's docs): [Superchain Faucet](https://app.optimism.io/faucet), [QuickNode](https://faucet.quicknode.com/unichain/sepolia), [thirdweb](https://thirdweb.com/unichain-sepolia-testnet).
<!-- testnet:end -->

## Prize tracks

- **Uniswap: Best Uniswap Stack Contribution** (primary).
  - *How we used it:* ParityHook is a generic wrapper-parity hook primitive. It shows a settlement-engine pattern for custom-accounting hooks: an all-or-nothing `beforeSwapReturnDelta` fill from ERC-6909 claims, with a zero-delta fall-through to the same pool under a peg guard and one fee schedule through the LP-fee override. DarkCrossHook settles dark-cross residuals into that pool inside a single `unlock`. See the README "Uniswap stack integration" table for line-linked integration points.
  - *Feedback:* paste the short form from `submission/feedback-form.md` answers 11 and 17, and link {{URL:feedback-md}}.
- Up to two more partner prizes may be selected. **OWNER:** decide; none are drafted here.
