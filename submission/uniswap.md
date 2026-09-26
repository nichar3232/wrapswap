# Unison: Uniswap prize (Best Uniswap Stack Contribution)

**Live:** https://nichars-mac-mini.tail43cacc.ts.net/app · contracts: Verify footer on every page (`/#verify`) · repo (public), tag `v1-ethglobal-tokyo`

Unison converts one stock between issuer wrappers, share for share, in Uniswap v4 pools on Unichain Sepolia (AAPL, NVDA, TSLA).

## What we built on the stack

- **ParityHook** ([`0x484b…e0c8`](https://sepolia.uniscan.xyz/address/0x484bc6aa8f6D472AD67F3ce8dD86f1f8A166e0c8#code), verified): a custom-accounting hook.
  - `beforeSwapReturnDelta` fills at share parity from ERC-6909 inventory.
  - Fees go through `OVERRIDE_FEE_FLAG`: 2 bps base, plus a skew fee only on trades that deepen the imbalance, all to the LP.
  - `afterSwap` enforces a 50 bps peg guard on fall-through.
- **DarkCrossHook** (one per asset): sealed batches settled inside `PoolManager.unlock`; residuals swap into the ParityHook pool. It has no hook flags.
- **WrapSwapRouter**: `unlock` → `swap` → `settle`/`take`, with the swapper and recipient in `hookData`.

## Proof (Uniscan)

| What | Tx |
| --- | --- |
| Convert, skew-increasing: 5.14 bps = 2.00 base + 3.14 skew | [0x53058b66…6967](https://sepolia.uniscan.xyz/tx/0x53058b66852381de1aab326442304d553ab204d248215fc7c00a18d36cf06967) |
| Convert through the live app: 100 mcbAAPL → 101.22975 mAAPLx at 2.00 bps, equal to the quote | [0xddf2db93…d00c](https://sepolia.uniscan.xyz/tx/0xddf2db935ab574b6264938abd48b65e046958da1abf9605da522e0ef48ffd00c) |
| Dark Cross AAPL batch 17: crossed at midpoint, residual filled by ParityHook | [0x5bfcf5a5…3295](https://sepolia.uniscan.xyz/tx/0x5bfcf5a59ac2fe5ca48d431c2114c6d6f79706d1622902a9554b819be2273295) |
| Dark Cross NVDA batch 140 / TSLA batch 148 | [0xa3ab2779…6d52](https://sepolia.uniscan.xyz/tx/0xa3ab2779cd8845c6c813167cbc176df20a4fcdfd934d96cfd30c85f8e59e6d52) · [0x091dd5c8…59cf](https://sepolia.uniscan.xyz/tx/0x091dd5c855260b09d9ac48f360570c91eecea733213868f321e763ab44ad59cf) |

## Mapping to the prize

| Prize ask | Where |
| --- | --- |
| Build on the Uniswap stack | v4 PoolManager on Unichain; one hook, three pools |
| Novel hook usage | Parity fill via `beforeSwapReturnDelta` and an LP-fee override that prices imbalance, not price. README → *Verify the integration* has line ranges. |
| Working, verifiable deployment | All contracts verified on Uniscan; `pnpm preflight` checks the live stack |
| Developer feedback | [FEEDBACK.md](../FEEDBACK.md): delta signs, ERC-6909 fee accounting, fee-override semantics, HookMiner, unlock debugging. |
