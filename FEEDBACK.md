# Uniswap v4 Developer Feedback — Unison (ETHGlobal Tokyo 2026)

**Project:** Unison, cross-issuer tokenized-stock conversion at NAV parity, built as a Uniswap v4 hook on Unichain Sepolia.
**Repo:** https://github.com/nichar3232/wrapswap
**Deployments:** `deployments/unichain-sepolia.json` (ParityHook, 3 pools, WrapSwapRouter, DarkCross ×3, ShareVault, faucet)

## What we built on v4

- **ParityHook**: one hook contract serving all three wrapper pools (e.g. AAPL on Coinbase ↔ AAPL on xStocks). It replaces the AMM curve in `beforeSwap` via `beforeSwapReturnDelta`, prices at NAV through per-issuer adapters plus an oracle, and fills from ERC-6909 inventory held in the PoolManager.
- **Dynamic fees**: 2 bps base, plus a skew charge of min(15 × |skew|, 50) bps applied only to swaps that increase inventory imbalance, all paid to LPs. A peg guard blocks any fill more than 50 bps off NAV.
- **DarkCross hooks**: sealed batch orders commit, then settle at the oracle mid, and any residual routes through the pool.
- **WrapSwapRouter**: a thin router that runs the `unlock` / callback flow and settles deltas.

## What worked well

- **The custom-curve pattern (`beforeSwapReturnDelta`)** is the reason this product can exist on Uniswap at all. Wrappers of the same stock should trade 1:1, and no constant-product or concentrated-liquidity curve does that. Overriding the curve while keeping the PoolManager as the venue (routing, accounting, composability) is the core v4 unlock for us.
- **ERC-6909 claims** made hook-held inventory clean. We keep inventory as claims inside the PoolManager instead of moving ERC-20s on every fill.
- **Flash accounting** kept multi-leg flows (a dark-cross residual into a pool swap) to one `unlock` with net settlement.
- **The singleton design** let one hook serve three pools with shared adapter and oracle config.

## Friction and suggestions

1. **Custom-curve / return-delta docs.** Sign conventions for `BeforeSwapDelta` (specified vs. unspecified token, exact-in vs. exact-out) are the easiest place to get a silent wrong answer. *Suggestion:* a canonical custom-curve example (NAV or 1:1 pricing) with a table of delta signs for all four swap cases, plus the matching test assertions.
2. **Hook address flags.** Mining a salt so the address encodes the right permission bits is a required step that new builders discover by reverting. *Suggestion:* surface the HookMiner flow and a `validateHookPermissions` failure message that says which flag is missing, directly on the "first hook" page.
3. **Quoting custom-curve pools.** Off-chain quoting assumes the pool's curve. For a hook that returns its own delta, frontends need a hook-aware quote path. *Suggestion:* document the recommended pattern (static-call simulation vs. a hook `quote()` view) so integrators don't guess.
4. **Unichain Sepolia address discovery.** Finding the current PoolManager, PositionManager, StateView and Quoter addresses per network took more searching than it should. *Suggestion:* one machine-readable address registry (JSON) per chain in the docs.
5. **Multi-pool hooks.** One hook serving several pools is natural in v4 but under-documented: per-pool config keyed by `PoolId`, initialization guards, and what `afterInitialize` should enforce. *Suggestion:* a short pattern guide.
6. **Testing templates.** A Foundry template covering the full `unlock` → callback → `settle`/`take` cycle for a custom router would have saved us a few hours.

## Would we build on v4 again?

Yes. The hook model let us enforce parity between issuers' wrappers without standing up a separate venue. The friction above is almost entirely docs and tooling, not protocol design.
