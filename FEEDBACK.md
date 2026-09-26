# Uniswap v4 developer feedback — Unison

Unison (repo and contracts named WrapSwap) is share-for-share conversion between issuer wrappers of the same stock, no cash leg, built on a Uniswap v4 hook. ParityHook is the settlement engine: every flow — parity fill, fall-through, and dark cross residual — settles through it. Solidity 0.8.26, EVM cancun, via-IR.

Pinned upstream (the compatible pair we built against; see [Dependency pins](#7-docs-gaps)):

- v4-core `46c6834698c48bc4a463a86d8420f4eb1d7f3b75` (package 1.0.2)
- v4-periphery `9969eec44cfdf07e24b41de47f40276a58401976` (package 1.0.4)

Conventions in this file: upstream code is linked by pinned permalink. WrapSwap code is cited by double-brace `LINE:Contract.function(argTypes)` placeholders; the deployment step resolves these to GitHub line links. Design decisions are cited as "DECISIONS.md: <entry>". Each item has three parts: **What happened** (what we actually hit), **Where** (the exact API or file), and **Suggested fix**.

---

## 1. `beforeSwapReturnDelta` ergonomics

**What happened.** ParityHook fills a swap entirely from its own inventory at the adapter parity ratio, or it doesn't fill at all. It returns the full `BeforeSwapDelta` or `ZERO_DELTA`, and a zero delta lets the swap fall through to the same pool's concentrated liquidity (DECISIONS.md: "Fills are all-or-nothing from inventory via beforeSwapReturnDelta; otherwise a zero delta falls through…"; [`ParityHook.beforeSwap` (ParityHook.sol#L245)](contracts/src/ParityHook.sol#L245)). Getting the delta right took four cases: direction × exact-in/exact-out. The delta is expressed in *specified/unspecified* terms, but inventory and fees are naturally reasoned about in *currency0/currency1* and *in/out* terms. Hooks.sol adds the returned specified delta to `amountSpecified`. So fully absorbing an exact-input swap needs a **positive** specified delta equal to the input, and exact output mirrors that. We only got this right by reading the source and testing both modes with 6- and 18-decimal tokens (commit `67ab80c`: "decimal-normalized parity exact-input, exact-output and fallback tests").

**Where.**
- [Hooks.sol L250–278 (`beforeSwap` delta application)](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/Hooks.sol#L250-L278)
- `BeforeSwapDeltaLibrary` / `toBeforeSwapDelta(int128 deltaSpecified, int128 deltaUnspecified)` in `src/types/BeforeSwapDelta.sol`
- The pinned periphery ships no `BaseHook` source utility, so every enabled callback is implemented directly (DECISIONS.md: "Implement only enabled hook callbacks directly: the pinned periphery has no BaseHook source utility"; [`ParityHook.getHookPermissions` (ParityHook.sol#L106)](contracts/src/ParityHook.sol#L106)).

**Suggested fix.**
1. Add a four-row table to the custom-accounting docs. Rows: `zeroForOne` × `amountSpecified < 0 / > 0`. Columns: the specified currency, the unspecified currency, the sign of each `BeforeSwapDelta` component for a full fill, and the resulting caller `BalanceDelta`.
2. Ship a helper such as `BeforeSwapDeltaLibrary.fullFill(bool exactInput, uint256 amountIn, uint256 amountOut)` that returns the correctly signed and ordered delta, so hooks don't hand-roll the orientation.
3. Ship a `BaseHook` (or its current successor) in the same tagged periphery release as the core it compiles against.

## 2. ERC-6909 accounting

**What happened.** Hook inventory is ERC-6909 claims owned by ParityHook in the PoolManager. Keepers deposit it with [`ParityHook.depositInventory` (ParityHook.sol#L126)](contracts/src/ParityHook.sol#L126) and withdraw it with [`ParityHook.withdrawInventory` (ParityHook.sol#L134)](contracts/src/ParityHook.sol#L134) (DECISIONS.md: "Inventory is ERC-6909 claims owned by ParityHook in the PoolManager…"). A fill mints input claims to the hook and burns output claims inside `beforeSwap`, with no ERC-20 transfer in the callback. Fees retained by the hook land in the **same** claim balance as inventory: ERC-6909 has one balance per (owner, id). So the hook has to track `feesAccrued` itself and subtract it from spendable inventory. Otherwise ordinary fills and keeper withdrawals would consume fee revenue (DECISIONS.md: "Exclude accrued fee claims from spendable hook inventory"; "fee claims are tracked separately and excluded from inventory and skew"). Mixed decimals made this harder: raw fee amounts in a 6-decimal and an 18-decimal token can't be added, so fee PnL is kept in share units (DECISIONS.md: "Express hook fee PnL in share units").

**Where.**
- [PoolManager.sol L322–336 (`mint`/`burn` → currency deltas)](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/PoolManager.sol#L322-L336)
- `IERC6909Claims` in `src/interfaces/external/IERC6909Claims.sol`

**Suggested fix.** Publish a worked example of a "claims-backed hook inventory". It should cover sub-accounting for fees versus inventory in one 6909 balance, the invariant to test (`balanceOf(hook, id) == inventory + feesAccrued`), and a settlement ledger with four columns: caller delta, hook delta, ERC-20 balance of the PoolManager, and claim balance. Show it for one exact-in fill and one exact-out fill.

## 3. Dynamic fee override on custom-accounting pools

**What happened.** The pool key uses `DYNAMIC_FEE_FLAG`, and ParityHook returns `totalPips | OVERRIDE_FEE_FLAG` from `beforeSwap` on every swap, whether it fills from inventory or falls through (DECISIONS.md: "PoolKey is the two issuer tokens … fee = DYNAMIC_FEE_FLAG"; [`ParityHook.beforeInitialize` (ParityHook.sol#L223)](contracts/src/ParityHook.sol#L223)). We hit three problems:

- **The override is per-swap and never persisted.** An early test asserted that `slot0.lpFee` changed after the override. It doesn't: the override affects only that swap's charged fee. We rewrote the assertion to check the amounts actually charged (DECISIONS.md: "v4 LP fee override affects swap fee without persisting slot0: validate charged amounts").
- **The override doesn't touch the inventory fill.** On a full custom-accounting fill, the curve sees no remaining `amountSpecified`, so the LP-fee override charges nothing. The hook has to take its own fee inside the delta, as `feeAmount = ceil(grossOut · totalPips / 1e6)` ([`ParityHook.quote` (ParityHook.sol#L175)](contracts/src/ParityHook.sol#L175)). The same number means "LP fee" on the fall-through path and "hook fee" on the inventory path, and the docs don't draw that line.
- **Units.** Our first hook priced in basis points. The final design moved to pips because pips are the v4 LP-fee unit and keep the fractional-bps skew term from truncating: the fee is `baseFeePips` (default 200) + a skew fee of `min(ceil(1500·|post-trade skew|), 5000)` pips charged only on trades that increase |skew| (DECISIONS.md: "Fee is expressed in pips (the v4 LP-fee unit)" and the "final fee model" entry; [`CanonicalShares.skewFeePips`](contracts/src/libraries/CanonicalShares.sol), [`ParityHook.feeBreakdown` (ParityHook.sol#L170)](contracts/src/ParityHook.sol#L170)). Rounding also differed by one raw unit between two code paths on dust amounts, so we keep separate rounding functions to make quotes match execution (DECISIONS.md: "Keep separate fee rounding functions for hook output and vault redemption"; commit `7e408d0`).

**Where.**
- [LPFeeLibrary.sol L15–19 (dynamic/override flags)](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/LPFeeLibrary.sol#L15-L19)
- [Pool.sol L303–304 (override selected per swap)](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/Pool.sol#L303-L304)

**Suggested fix.** Next to the override example, state explicitly: (a) the override does not write `slot0`; (b) it applies only to the portion of the swap that reaches the curve, so a hook that returns a full `BeforeSwapDelta` must charge its fee in the delta; (c) the unit is pips (1e-6), with a bps ↔ pips conversion line. A `LPFeeLibrary.fromBps(uint16)` helper would make (c) impossible to get wrong.

## 4. Hook address mining

**What happened.** ParityHook's permissions are `beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta` (flags `0x20C8`, INTERFACES.md §1.7). The deploy script deploys hooks through the canonical CREATE2 deployer proxy, so the salt has to be mined against the proxy's address, not the broadcasting EOA's. A salt mined against the EOA predicts a different address, with different permission bits ([`DeployFinal` HookMiner call (DeployFinal.s.sol#L80)](contracts/script/DeployFinal.s.sol#L80)). `HookMiner` is imported from `v4-periphery/test/shared/`, which is a test path rather than a supported public utility.

**Where.** [HookMiner.sol L14–38](https://github.com/Uniswap/v4-periphery/blob/9969eec44cfdf07e24b41de47f40276a58401976/test/shared/HookMiner.sol#L14-L38) (bounded salt loop; the address is derived from the `deployer` argument).

**Suggested fix.** Move `HookMiner` to a supported `src/utils/` path. Add a broadcast example that passes `0x4e59b44847b379578588920cA78FbF26c0B4956C` as the deployer, plus a one-line post-deploy assertion (`Hooks.validateHookPermissions(IHooks(addr), expected)`) so a mis-mined address fails in the script rather than at `initialize`.

## 5. `amountSpecified` sign conventions

**What happened.** The pinned core treats `amountSpecified < 0` as exact input and `> 0` as exact output. We froze that convention into our own API: `quote(PoolKey, bool zeroForOne, int256 amountSpecified)` ([`ParityHook.quote` (ParityHook.sol#L175)](contracts/src/ParityHook.sol#L175); DECISIONS.md: "exact-in and exact-out both follow the pinned v4-core sign convention (amountSpecified < 0 is exact input)"). The canonical demo swap is `amountSpecified = −100000000` for 100 mcbAAPL exact-in (INTERFACES.md §10). Meanwhile the periphery quoter uses unsigned `exactAmount` with separate `quoteExactInputSingle` / `quoteExactOutputSingle` functions. Our API route calls both the hook quote and a V4Quoter simulation (INTERFACES.md §5 `/route`), so it has to translate between the two conventions. The rounding direction also flips between the modes: output is floored for exact-in, and input is ceiled for exact-out (DECISIONS.md: "Rounding favours the hook").

**Where.** `SwapParams.amountSpecified` in [PoolOperation.sol](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/types/PoolOperation.sol); `IV4Quoter.QuoteExactSingleParams.exactAmount` in v4-periphery `src/interfaces/IV4Quoter.sol`.

**Suggested fix.** Put the sign convention in the NatSpec of `SwapParams.amountSpecified` itself, not only in guides. Offer `SwapParamsLibrary.exactIn(uint256)` / `exactOut(uint256)` constructors, and use the same signed-or-unsigned convention across core and the quoter, or document the mapping in one table.

## 6. Unlock/settle debugging

**What happened.** The dark cross (`DarkCrossHook`) settles a whole batch inside a single `PoolManager.unlock`. It moves crossed amounts between escrow balances and swaps each residual exact-input into the ParityHook pool ([`DarkCrossHook.settle` (DarkCrossHook.sol#L262)](contracts/src/DarkCrossHook.sol#L262), [`DarkCrossHook.unlockCallback` (DarkCrossHook.sol#L297)](contracts/src/DarkCrossHook.sol#L297); DECISIONS.md: "DarkCrossHook … routes residuals into the ParityHook pool inside the same unlock"). We hit three problems:

- **An unsettled delta surfaces far from its cause.** `CurrencyNotSettled` fires at the end of `unlock`, with no currency or amount, far from the line that caused the imbalance.
- **One trader's residual could revert the whole batch.** An unfillable residual (limit or insufficient inventory) inside the unlock would revert everyone's settlement. We isolate each residual swap behind an external self-call wrapped in try/catch, and unlock that trader's collateral on failure (DECISIONS.md: "Isolate unfillable residual self-calls and unlock their collateral: one trader's limit must not block the whole batch"). This surfaces as `ResidualSkipped` rather than a batch revert.
- **Hook-originated swaps skip callbacks silently.** v4 skips a hook's callbacks when the hook itself is `msg.sender`, so a swap a hook originates on its own pool never runs its own `beforeSwap`/`afterSwap`. In our earlier design, that forced us to record TWAP observations explicitly (DECISIONS.md: "Record residual TWAP observations explicitly: v4 suppresses callbacks when a hook originates its own swap"). In the final design the dark cross contract carries no hook flags and swaps into the ParityHook pool. Because the sender is not ParityHook, ParityHook's `beforeSwap` does run for residuals, so the residual fills from hook inventory at the same base + skew fee as any other swap; whatever inventory can't fill is refunded rather than sent to the curve (INTERFACES.md §1.8).

**Where.**
- [Hooks.sol L253 (callback skip when `msg.sender == hook`)](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/Hooks.sol#L253)
- `IPoolManager.CurrencyNotSettled()`
- `TransientStateLibrary.currencyDelta` in `src/libraries/TransientStateLibrary.sol`

**Suggested fix.**
1. Add the currency and the outstanding delta to `CurrencyNotSettled` as error parameters, or ship a Foundry cheat or trace helper that dumps non-zero `currencyDelta`s at unlock exit.
2. Document `TransientStateLibrary.currencyDelta` as the debugging tool, with an example that asserts deltas mid-callback.
3. Add a callback-execution diagram for hook-originated swaps.
4. Document the "try/catch per leg inside one unlock" pattern for batch settlers.

## 7. Docs gaps

**Dependency pins.** The v4-core tag `v4.0.0` (`e50237c`) nests `SwapParams` in `IPoolManager.sol`. The current periphery imports the standalone [`PoolOperation.sol`](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/types/PoolOperation.sol), and periphery has no release tags. Mixing the latest core tag with current periphery failed to compile (DECISIONS.md: "Pin compatible current core/periphery commits instead of mixing stale core v4.0.0 with current periphery"; commit `d27e0da`). *Fix:* publish synchronized core/periphery/template tags and a tested compiler matrix.

**Quoting custom hooks.** [V4Quoter.sol L18–32](https://github.com/Uniswap/v4-periphery/blob/9969eec44cfdf07e24b41de47f40276a58401976/src/lens/V4Quoter.sol#L18-L32) is non-view by design (revert-and-decode). Our API simulates it for fall-through quotes and reads the hook's own `quote` for inventory fills (INTERFACES.md §5 `/route`). *Fix:* add a viem `simulateContract` example that preserves custom hook revert data (`PegGuardTripped`, `NotEligible`), and state that a hook with custom accounting should expose its own view quote.

**Router-aware identity for gated hooks.** In `beforeSwap`, `sender` is the router, not the end user. Our eligibility gate trusts a swapper named in `hookData` only when `sender` is an allowlisted router, and never uses `tx.origin` (DECISIONS.md: "the swapper comes from hookData only when the sender is an allowlisted router, else the sender"; "Gate production liquidity on the callback sender and never tx.origin"; [`IEligibility.resolveSwapper` (IEligibility.sol#L28)](contracts/src/interfaces/IEligibility.sol#L28)). *Fix:* publish a canonical `hookData` convention (or Universal Router support) for passing an attested end-user identity to hooks.

**Liquidity seeding.** Seeding a pool through PositionManager needs four coordinated steps: ERC-20 approval, Permit2 allowance, action encoding, and per-currency settlement (DECISIONS.md: "Use official PositionManager and Permit2 for real fork liquidity"). *Fix:* one runnable end-to-end example with sorted currencies and mixed 6/18-decimal amounts.

**Deployment records.** The [deployments JSON feed](https://developers.uniswap.org/deployments.json) already gives chain IDs and source references (DECISIONS.md: "Use the existing Uniswap deployment JSON feed as evidence and suggest enriched records"). *Fix:* add deployment block and bytecode hash per record, and pin `sourceCodeUrl` to `sourceRef` rather than `main`, so fork checks are reproducible.

**Tick spacing vs requested ranges.** Rounding LP ranges outward to tick spacing silently widens a requested ± band (DECISIONS.md: "Use tickSpacing=1 in the lit pool and outward-rounded ±2% price ticks: a 240-tick range would incorrectly widen the requested position"). The frozen design uses spacing 10 around a 50 bps peg guard (DECISIONS.md: "10-tick spacing keeps LP ranges fine-grained around a 50 bps peg guard"). *Fix:* add a docs note, with a helper, on choosing tick spacing for pegged pairs.

## Adjacent findings (not Uniswap code)

These cost build time on the same stack. They're recorded here for completeness.

- **Base B20 on Anvil.** Coinbase's tokenized AAPL on Base is a native B20 token. Generic Anvil returns `OpcodeNotFound` on it, so we switched to a mock with the same ERC-20/multiplier/pause surface, which is what the Unichain Sepolia and local demos use (commit `fa74701`).
- **Issuer decimals.** Live AAPLc has 8 decimals, and `multiplier()` alone can't normalize raw amounts. All share math takes token decimals (DECISIONS.md: "Normalize issuer amounts by token decimals before applying sharesPerToken").
- **Node 24 / Undici on macOS.** Node 24's bundled Undici crashed with `setTypeOfService EINVAL` during sustained API use. We installed the upstream-fixed dispatcher ([undici#5547](https://github.com/nodejs/undici/pull/5547)) (DECISIONS.md: "Install Undici 8.11.2's fixed dispatcher for Node clients"; commit `736a92e`).
