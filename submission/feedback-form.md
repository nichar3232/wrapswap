# Uniswap hackathon feedback form — draft

Placeholders used in this file: `{{URL:repo}}`, `{{URL:feedback-md}}`

Form: https://developers.uniswap.org/hackathon-feedback. Field labels and order below were fetched from the live form on 2026-09-26 (20 fields). The fetch returned the labels and types but not the dropdown option lists. For each dropdown, pick the option closest to the suggested answer. Fields marked **OWNER** need the submitter's own identity, rating or consent. This draft doesn't fill them in.

| # | Field (exact label) | Req. | Type | Draft answer |
|---|---|---|---|---|
| 1 | First name | yes | text | **OWNER** |
| 2 | Last name | no | text | **OWNER** |
| 3 | Email | yes | text | **OWNER** |
| 4 | Telegram handle | yes | text | **OWNER** |
| 5 | Which hackathon did you participate in? | yes | dropdown | ETHGlobal Tokyo 2026 |
| 6 | Did you complete a project during the hackathon? | yes | dropdown | Yes. Select this only after the ETHGlobal submission is in (checklist step 5). |
| 7 | What did you build? | yes | text | See the answer under the table. |
| 8 | Are you building an AI-powered or agentic project? | yes | dropdown | No. AI coding agents helped build it, but the product's pricing and settlement are deterministic contracts. |
| 9 | Were you able to successfully integrate Uniswap into your project? | yes | dropdown | Yes |
| 10 | How long did it take to get your first successful integration working? | yes | dropdown | **OWNER** — no start-to-first-swap time was recorded. Pick honestly. |
| 11 | What was the biggest blocker you faced? | no | text | See the answer under the table. |
| 12 | If applicable: what was the hardest part of building an agentic app on Uniswap? | no | text | Leave blank (not an agentic app). |
| 13 | How helpful was the Uniswap documentation for your use case? | yes | rating 1–5 | **OWNER**. Context: custom-accounting delta signs, the fee-override scope and hook-originated callback skips all needed a source read (FEEDBACK.md §1, §3, §6). |
| 14 | How would you rate the support Uniswap provided overall? | yes | rating 1–5 | **OWNER**. No office-hours or Discord interactions are recorded in the repo. |
| 15 | Do you plan to continue building the project you started at this hackathon? | yes | dropdown | **OWNER** |
| 16 | What type of support did you use? | no | checkbox | ☑ Technical docs ☑ Code examples / templates. Tick others only if you actually used them. |
| 17 | What support was missing, or could have been better? | no | text | See the answer under the table. |
| 18 | Any additional feedback? | no | text | See the answer under the table. |
| 19 | Can we follow up with you about your feedback? | yes | radio Yes/No | **OWNER** |
| 20 | Terms agreement | yes | checkbox | **OWNER** — read the terms and tick the box yourself. |

## 7. What did you build?

Unison (repo name WrapSwap) does share-for-share conversion between issuer wrappers of the same stock, with no cash leg: for example Coinbase's tokenized AAPL (which lives on Base) and Backed's xStocks AAPLx. It is live on Unichain Sepolia and Sui testnet for AAPL, NVDA and TSLA. The core is a Uniswap v4 hook, ParityHook, that runs directly on a pool of the two issuer tokens. It fills swaps from its own ERC-6909 inventory at the adapters' share ratio via beforeSwapReturnDelta. The fee is 2 bps base (owner-settable) plus a skew fee of min(15 bps × |post-trade skew|, 50 bps), charged only on trades that increase inventory imbalance, all to the LP. When inventory can't cover a swap, it falls through to the pool's concentrated liquidity under a 50 bps peg guard. A commit-reveal Dark Cross settles at an oracle mid (1 bp of crossed volume to the protocol) and fills residuals from the same hook's inventory inside one unlock. A third product, Send, pays in shares confidentially through a ShareVault on Unichain and a Seal-encrypted pool on Sui. Swappers are gated to non-US users via the Coinbase Verified Country EAS attestation; on testnet this gate is bypassed with an owner-set demoMode.

## 11. What was the biggest blocker you faced?

Getting custom-accounting deltas right across all four swap cases (direction × exact-in/out) with 6- and 18-decimal tokens. Hooks.sol adds the specified delta to amountSpecified, so a full exact-input fill needs a positive specified delta. We only confirmed that by reading the source. A second blocker was dependency pins: the v4-core v4.0.0 tag doesn't compile with current periphery (PoolOperation.sol), so we had to pin matching commits by hand.

## 17. What support was missing, or could have been better?

- A four-case BeforeSwapDelta sign table and a full-fill helper.
- A claims-backed hook inventory example: fees and inventory share one ERC-6909 balance per id.
- Docs stating that the LP-fee override is per swap, never written to slot0, and doesn't apply to the hook-filled portion.
- HookMiner at a supported (non-test) path, with a CREATE2-proxy broadcast example.
- CurrencyNotSettled carrying the currency and amount.
- Synchronized core/periphery tags with a compiler matrix.

## 18. Any additional feedback?

Full source-linked feedback, pinned to v4-core 46c6834 / v4-periphery 9969eec, is at {{URL:feedback-md}}. It has seven sections: beforeSwapReturnDelta ergonomics, ERC-6909 accounting, dynamic fee override on custom-accounting pools, hook address mining, amountSpecified sign conventions, unlock/settle debugging, and docs gaps. Each gives what happened, the exact file or API, and a suggested fix. Repo: {{URL:repo}}.
