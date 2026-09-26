# Unison reframe: contracts scoping report

Scope: what has to change in `contracts/` so the implementations meet `INTERFACES.md` as frozen at tag
`interfaces-frozen` (commit `e9b7bf0`). This file is a report only. Nothing else in the repo was modified.

Baseline measured for this report:

- `forge build` succeeds.
- `forge test --no-match-test 'Fork|GroundTruth'`: 34 passed, 0 failed. All 34 exercise the legacy design.
- `contracts/src/interfaces/*.sol` match the §1 code blocks in `INTERFACES.md` byte for byte. I checked all 8 files
  with a script, so the interfaces themselves are not in scope.
- The v4 libraries are installed `--no-git` by `scripts/install-contracts.sh:4-6` at the pinned commits. `lib/` is
  gitignored.
- I recomputed every §10 number independently: sqrtPriceX96 for both orderings, ticks, LP ticks, shares, fees,
  crossings, residual, end balances and calendar timestamps. All of them are arithmetically consistent. §7 lists the
  preconditions under which the contracts can actually produce them.

Settled decisions are taken as given and not reopened: issuer/issuer pools, uAAPL as internal accounting only, "share-for-share
conversion, no USDC leg", hook as settlement engine, EAS Verified Country (non-US) with demoMode, anvil video with NYSE warped
open, live Sepolia on the real clock.

Decisions this report makes (the contracts lane should copy them into `decisions/contracts.md`):

- **D1.** `CanonicalStock.sol` is deleted, not kept as dead code. §11 says it must not be deployed, and leaving it in
  place tempts reuse.
- **D2.** The two mock tokens collapse into one `MockIssuerToken` implementing `IMockIssuerToken`. `MockB20.sol` is
  deleted.
- **D3.** Adapters become three contracts: `StaticAdapter`, `B20MultiplierAdapter` and `XStocksMultiplierAdapter`,
  plus a shared abstract `MultiplierAdapterBase`. `IIssuerAdapter` is deleted.
- **D4.** `ParityHook.beforeSwap` gates on `registry.active(token)`, which covers both the registry pause and adapter
  health, instead of adapter health alone. It still reverts with `AdapterUnhealthy`. See erratum E3.
- **D5.** `ParityHook.beforeInitialize` additionally rejects an initial price more than `PEG_GUARD_BPS` off parity,
  using the existing `PegGuardTripped` error (erratum E12). It also rejects `tickSpacing != 10`, using
  `UnsupportedPool`.
- **D6.** `DarkCrossHook` holds no owner. Everything is fixed at construction: `parityPoolKey`, tokens, treasury.
- **D7.** `Deploy.s.sol` stops importing `Addresses.sol`. Externals come from env with Unichain Sepolia defaults taken from
  §4.
- **D8.** Treasury proceeds from DarkCross (cross fees and forfeits) are credited to the treasury's escrow `available`
  balance. They are not transferred out inside `settle` (erratum E10).
- **D9.** The block numbers in the deployment manifest come from a second, read-only `manifest()` entry point in
  `Deploy.s.sol`. It finds each contract's creation block with `eth_getCode` binary search through `vm.rpc`
  (erratum E5).

---

## 1. Contracts: function-level diffs

Legend: **KEEP** (already conforms), **MODIFY**, **REWRITE**, **DELETE**, **NEW**. Risk: L / M / H.

### 1.1 `contracts/src/ParityHook.sol` — REWRITE (L)

Today: a hook on `vault(uAAPL)/issuer` pools with a bps fee formula, a peg check in `beforeSwap`, a `Converted` event, no
eligibility, no hookData, no `IParityHook`. Target: `contract ParityHook is IParityHook, Ownable` (plus
`IUnlockCallback`), running on **issuer/issuer** pools.

| Function / element | Current (file:line) | Required per INTERFACES.md | Risk |
|---|---|---|---|
| imports | `ParityHook.sol:19-22` import concrete `IssuerRegistry`, `CanonicalStock`, `NyseCalendar`, `IIssuerAdapter` | Import `IParityHook`, `IIssuerRegistry`, `INyseCalendar`, `IEligibility`, `IWrapperAdapter`, `CanonicalShares`, `TransientStateLibrary` (tests only). Drop `CanonicalStock` entirely. | L |
| state | `:30-36` `vault`, `providers`, `feeAccrued` | `IPoolManager public immutable poolManager`, `IIssuerRegistry public immutable registry`, `INyseCalendar public immutable calendar`, `IEligibility public immutable eligibility`, `mapping(address=>bool) isKeeper`, `mapping(Currency=>uint256) feesAccrued` (renamed from `feeAccrued`), `mapping(PoolId=>bool) pegTripped`. Constants `BASE_FEE_PIPS=200`, `SKEW_FEE_PIPS=1300`, `CLOSED_FEE_PIPS=1000`, `MAX_FEE_PIPS=2500`, `PEG_GUARD_BPS=50` (already there at `:34`, KEEP), `HOOK_DATA_VERSION=1`. Implement the interface getters with `public constant`. Confirm the via-IR compile accepts constant-implements-interface. If not, write explicit `function X() external pure`. | L |
| `OffParity` error, `Converted` event | `:37-40` | DELETE. Use the interface errors and events (`PegGuardTripped`, `InventoryFill`, `FallThrough`, `FeeQuoted`, `InventoryChanged`, `FeesSwept`, `PegGuardStatus`, `KeeperSet`, `PoolRegistered`). | L |
| `onlyManager` | `:41-44` `require(..., "manager only")` | `revert NotPoolManager()`. | L |
| constructor | `:46-54` `(m, r, vault, c, owner)`, grants `providers[owner]` and `providers[vault]` | `(IPoolManager, IIssuerRegistry, INyseCalendar, IEligibility, address owner)`. Set `isKeeper[owner]=true` and emit `KeeperSet`. Keep `Hooks.validateHookPermissions`. **The constructor args change, so the init-code hash changes and the hook address must be re-mined (§1.1.3).** | M |
| `getHookPermissions` | `:56-61` beforeInitialize, beforeSwap, afterSwap, beforeSwapReturnDelta | **KEEP.** This is already exactly `0x20C8`. | L |
| `setProvider` | `:63-65` | DELETE. Replaced by `setKeeper(address,bool)` (onlyOwner, emits `KeeperSet`) and `isKeeper`. | L |
| `inventory(Currency)` | `:67-69` `balanceOf(this,id) - feeAccrued[c]` | **KEEP** the semantics and rename the storage to `feesAccrued`. Add `inventoryShares(c) = CanonicalShares.toSharesDown(inventory(c), spt(c), dec(c))`, reverting `IIssuerRegistry.UnknownIssuer` for an unregistered currency, and `feesAccrued(c)`. | L |
| `depositInventory` | `:71-75` `providers[msg.sender]`, unlock payload `(bool,c,a,who)` | Keeper-only (`NotKeeper(caller)`). `amount==0` reverts `ZeroAmount`. The currency must satisfy `registry.isIssuer`, else `IIssuerRegistry.UnknownIssuer`. Use a typed callback payload (action enum). Emit `InventoryChanged(c, msg.sender, 0, +a, inventoryAfter)`. | L |
| `withdrawInventory` | `:77-80` onlyOwner, `(c,a)`, bare `require` | Signature changes to `(Currency, uint256, address to)` and it becomes keeper-only. `a > inventory(c)` reverts `InsufficientInventory(c, available, a)`. Emit `InventoryChanged(c, msg.sender, 1, -a, after)`. Must not touch `feesAccrued`. | L |
| `sweepFees` | `:82-86` returns nothing | `returns (uint256 amount)`. Burn claims equal to `feesAccrued[c]`, take to `to`, emit `FeesSwept`. Zero fees is a no-op that returns 0. | L |
| `unlockCallback` | `:88-100` | Same mechanics (sync, then transferFrom to PM, then `settle()==a` to reject fee-on-transfer, then `mint`; or `burn` then `take`). Add a transient `_expectingCallback` flag that is set by the three entry points, so no other path can drive it. Discriminate actions with an enum. | M |
| `beforeInitialize` | `:102-106` fee check, then `_issuer` requiring the **vault on one side** (`:108-114`) | `key.fee != DYNAMIC_FEE_FLAG` reverts `DynamicFeeRequired(key.fee)`. Both currencies must be `registry.active` with equal, non-zero `underlyingOf`, else `UnsupportedPool(c0,c1)`. Emit `PoolRegistered(id, c0, c1, underlying, tickSpacing)`. Per D5, also require `tickSpacing == 10` and that the initial price is within `PEG_GUARD_BPS` of parity. **This is the PoolKey change from vault/issuer to issuer/issuer.** | M |
| `_issuer` | `:108-114` | DELETE. Replace with `_pair(key)`, which returns `(token0, token1, spt0, spt1, dec0, dec1)` after checking `registry.active` for both. | L |
| `feeBpsNow` | `:116-127` bps, `13*|a-b|/(0.8*(a+b))` capped at 13, `+10` closed | DELETE. Replace with `feeBreakdown(PoolKey)`: `s_i = toSharesDown(inventory(c_i))`, `skewPips = ceil(1300·|s0−s1|/(s0+s1))`, `totalPips = min(200+skew+(open?0:1000), 2500)`, `skewX18` truncated. It must use the shared `CanonicalShares.totalFeePips` / `skewPips`. | M |
| `beforeSwap` | `:129-190` | REWRITE; the full specification is in §1.1.1. Main deltas: (a) resolve the swapper from hookData and check eligibility; (b) check adapter health and registry active; (c) quote in canonical shares with the §1.7 rounding; (d) fill all-or-nothing and **fall through on dust instead of reverting `"dust"` (`:157`)**; (e) emit the events; (f) the **peg guard moves out of `beforeSwap` (`:175-183`) into `afterSwap`**; (g) the override becomes `totalPips | OVERRIDE_FEE_FLAG` instead of `bps*100` (`:155`). | H |
| `afterSwap` | `:192-220` reads raw transient slots 0..2, emits `Converted` | On the fill path, return `(selector, 0)` immediately with no events. On fall-through, compute `pegStatus` from post-swap slot0. `deviationBps > 50` reverts `PegGuardTripped(id, dev)`. Otherwise emit `FallThrough(id, swapper, sender, zeroForOne, reason, delta.amount0(), delta.amount1(), totalPips, dev)`. Clear the transient slots. Use namespaced transient slots, e.g. `keccak256("wrapswap.parity.swap")`, not slots 0..2. | H |
| NEW `quote(key, zeroForOne, amountSpecified)` | — | A view sharing one internal `_quote()` with `beforeSwap`, so the view and the execution are bit-identical. `amountSpecified == 0` reverts `ZeroAmount`. An unsupported key reverts `UnsupportedPool`. An unhealthy adapter reverts `AdapterUnhealthy` (erratum E9). `fillable = inventory(out) >= grossOut && amountIn>0 && amountOut>0`. | M |
| NEW `pegStatus(key)`, `checkPeg(key)`, `pegTripped(id)` | — | `pegStatus`: `parityPriceX18 = spt0·1e18/spt1` (floor), `poolPriceX18` per §1.9 (floor, **exact single floor**; see §1.1.6), `deviationBps` (ceil), `tripped = dev > 50`. `checkPeg` is permissionless: it emits `PegGuardStatus` and stores the value only when it differs from `pegTripped[id]`. | M |
| NEW `feeBreakdown(key)` | — | As above. Also emitted as `FeeQuoted` on every swap reaching `beforeSwap`. | L |
| NEW `eligibility()`, `registry()`, `calendar()` | — | Typed as interfaces (currently concrete types at `:31-33`). | L |

#### 1.1.1 `beforeSwap` target algorithm (normative order)

1. `onlyManager`. Build `(token0, token1, spt, dec)` from the registry. Any token not `registry.active` reverts
   `AdapterUnhealthy(token)` (D4).
2. **Eligibility from hookData (§3).** `len==0` means `swapper=sender, uid=0`. `len==96` means read the first word
   manually and require it to equal `1` (do not rely on `abi.decode(uint8)`, which panics on dirty bits; see erratum
   E14). Then `swapper = eligibility.resolveSwapper(sender, claimed)` and `uid` = the third word. Any other length or
   version reverts `InvalidHookData()`. `eligibility.check(swapper, uid)` returning false reverts
   `IEligibility.NotEligible(swapper, reason)`. `check` is `view`, so it is a STATICCALL with no reentrancy surface.
3. `fee = feeBreakdown(key)` from **pre-swap** inventory. Emit `FeeQuoted`.
4. `q = _quote(...)`. Exact-in when `amountSpecified < 0`, exact-out when `> 0` (§1.1.4).
5. If `inventory(out) >= q.grossOut && q.amountIn > 0 && q.amountOut > 0`:
   - `poolManager.mint(this, in.id, amountIn)`, `poolManager.burn(this, out.id, amountOut)`,
     `feesAccrued[out] += feeAmount`;
   - emit `InventoryFill`, then `InventoryChanged(in, swapper, 2, +amountIn, invAfter)`, then
     `InventoryChanged(out, swapper, 3, -grossOut, invAfter)`;
   - tstore `{mode=FILL}`;
   - return the BeforeSwapDelta: exact-in `toBeforeSwapDelta(+amountIn, -amountOut)`, exact-out
     `toBeforeSwapDelta(-amountOut, +amountIn)`, and the override `totalPips | OVERRIDE_FEE_FLAG`.
6. Otherwise: tstore `{mode=FALL, reason = (amountIn==0||amountOut==0) ? 2 : 1, swapper, feePips}` and return
   `ZERO_DELTA` with the same override.

#### 1.1.2 Removal of the uAAPL ERC-20 mint/burn path

- `CanonicalStock` is deleted (§1.3). The hook's only token flows are ERC-6909 claims of the two issuer tokens.
- The `vault` immutable (`ParityHook.sol:32`) goes, along with the `providers[address(v)]` grant (`:52`), the
  `intoVault` branching (`:139-141`, `:161`, `:178-180`, `:209`) and the `CanonicalStock.pullInventory` provider path
  (`CanonicalStock.sol:88-97`).
- "Shares" now exist only as `uint256` values from `CanonicalShares`: `Quote.shares`, `InventoryFill.shares`,
  `inventoryShares`. No `ERC20` is inherited anywhere in `src/` except the mocks.
- Grep gate for the contracts lane: `grep -rn "CanonicalStock\|uAAPL\|vault" contracts/src contracts/script` must return
  nothing after the rewrite. `contracts/src/interfaces/` is already clean.

#### 1.1.3 Hook permission flags and address mining

- **ParityHook:** flags stay `0x20C8`, i.e. `BEFORE_INITIALIZE (1<<13) | BEFORE_SWAP (1<<7) | AFTER_SWAP (1<<6) |
  BEFORE_SWAP_RETURNS_DELTA (1<<3)`. `getHookPermissions` at `:56-61` already matches. The creation code and
  constructor args change, so the CREATE2 salt must be re-mined:
  - `Deploy.s.sol` uses `HookMiner.find(CREATE2_PROXY, 0x20C8, code, args)`, which already exists at
    `Deploy.s.sol:112-119`, with the new args.
  - Tests use `deployCodeTo("ParityHook.sol:ParityHook", args, address(uint160(0x20C8) | (0x4444 << 144)))` instead of
    the brute-force loop at `ParityVault.t.sol:67-75`.
  - The manifest asserts `uint160(parityHook) & 0x3fff == 0x20c8`.
  - The address is **not** stable across code changes. Every consumer must read it from `deployments/<network>.json`.
- **DarkCrossHook:** flags go from `0x08C0` (`beforeAddLiquidity|beforeSwap|afterSwap`, `DarkCrossHook.sol:165-169`,
  mined at `Deploy.s.sol:83-87`) to **none**. Delete `getHookPermissions`, `beforeAddLiquidity`, `beforeSwap` and
  `afterSwap`. Deploy with plain `CREATE` (`new DarkCrossHook(...)`) with no mining. The manifest writes
  `flags: "0x0000", permissions: []`. Those are declared values, not the address bits (erratum E7b). The test's
  `vm.etch` to `0x100000+0x8c0` at `DarkCrossHook.t.sol:143-145` goes away.

#### 1.1.4 Exact-out handling

- Quote per §1.7: `grossOut = grossForNet(B, pips)` (ceil), `feeAmount = grossOut − B`,
  `shares = toSharesUp(grossOut, sptOut, decOut)`, `amountIn = fromSharesUp(shares, sptIn, decIn)`.
- Delta: `toBeforeSwapDelta(-int128(B), +int128(amountIn))`. The pinned `Hooks.beforeSwap`
  (`lib/v4-core/src/libraries/Hooks.sol:273-277`) does `amountToSwap += hookDeltaSpecified`, so `B + (−B) = 0`, and
  `Pool.swap` returns early on `amountSpecified == 0` (`Pool.sol:320`) **before** the price-limit checks. This means
  any `sqrtPriceLimitX96` is accepted on the fill path, but the router must still pass a valid one for fall-through.
- The hook delta is mapped to (currency0, currency1) by `params.amountSpecified < 0 == params.zeroForOne`
  (`Hooks.sol:307-309`). The hook is owed `amountIn` of the input and owes `B` of the output. `mint(in, amountIn)` and
  `burn(out, B)` net that to zero.
- Use `SafeCast.toInt128` on both legs (existing `:170-171`). An `amountSpecified` beyond `int128` reverts before any
  state change.
- `PoolSwapTest` exact-out assertions (`deltaAfterOut <= amountSpecified`) hold with equality. `V4Quoter`'s
  `NotEnoughLiquidity` check (`BaseV4Quoter.sol:56`) also holds.
- The existing exact-out rounding (`ParityHook.sol:150-153`, bps with `mulDivRoundingUp`) is directionally right but
  uses the wrong unit and formula. Replace it wholesale with `CanonicalShares`.

#### 1.1.5 ERC-6909 inventory accounting under both currency orderings

| | mcbAAPL is currency0 (anvil default order) | mAAPLx is currency0 |
|---|---|---|
| inventory keys | `Currency(mcbAAPL).toId()`, `Currency(mAAPLx).toId()` (ordering-independent) | same |
| skewX18 sign for §10 (−0.2) | negative | **positive** (+0.2) |
| mcbAAPL→mAAPLx `zeroForOne` | true | false |
| exact-in delta mapping | specified=currency0 → `(amount0=+in, amount1=−out)` | specified=currency1 → `(amount0=−out, amount1=+in)` |
| init sqrtPriceX96 / tick | `79721800701433069633245772272326702` / 276448 | `78737580939686982353822` / −276449 |

Rules:

- Inventory is keyed per **currency**, not per pool, and is shared by every pool this hook registers. D5 pins
  `tickSpacing == 10`, so exactly one pool per pair is possible.
- `inventory = balanceOf(hook, id) − feesAccrued[c]`. This can never underflow, because fees are only added out of
  claims the hook retains: burn `amountOut`, keep `feeAmount` of `grossOut`.
- The input side mints `amountIn` claims. It is never "fee-reduced".
- Every value in `_quote` must be derived from `(in, out) = zeroForOne ? (c0, c1) : (c1, c0)`. The only
  ordering-dependent outputs are `skewX18` and `pegStatus` (price of currency0 in currency1).
- Tests run every ParityHook case under both orderings (§4.3).

#### 1.1.6 Peg-guard placement and exact price math

- Move the guard from `beforeSwap` (`:175-183`, a pre-swap check with a non-§1.9 formula
  `sqrt²/2^96` vs `unit·2^96/r`) to `afterSwap`, on fall-through only.
- On the fill path there is no price move, and the fill is at parity by construction, so there is no check.
- `poolPriceX18` must equal the TypeScript `(s·s·10^dec0·1e18) / (2^192·10^dec1)` bit for bit. `s` can reach 2^160,
  so a naïve `mulDiv(s, s, …)` followed by more multiplications loses exactness. Use the exact decomposition:
  `D = 2^192·10^dec1`, `A = FullMath.mulDiv(s, s, D)`, `R = mulmod(s, s, D)`,
  `price = A·K + FullMath.mulDiv(R, K, D)` with `K = 10^dec0·1e18`. `A·K` fits in 256 bits for `dec0 ≤ 18`. This is
  covered by fuzz test `CanonicalShares.t.sol::testFuzz_poolPriceX18MatchesReference`.
- A pool that is already off peg can still be corrected. A swap whose post-swap price lands inside the band succeeds;
  only swaps that end outside the band revert.

#### 1.1.7 Fee override on fall-through

- Return `totalPips | LPFeeLibrary.OVERRIDE_FEE_FLAG` on **both** paths. It only matters on fall-through, where
  concentrated-liquidity LPs earn `totalPips`. The hook earns nothing there.
- `totalPips ≤ 2500 < 1e6` passes `LPFeeLibrary.validate`.
- Stored `slot0.lpFee` stays 0 for dynamic pools. The override is per-swap, which is the existing assertion at
  `ParityVault.t.sol:269-270`, kept in the rewrite.
- If Unichain Sepolia has a protocol fee set, the effective swap fee is `protocolFee ⊕ lpFee`. `FallThrough.feePips`
  reports only the LP part (erratum E15).

### 1.2 `contracts/src/DarkCrossHook.sol` — REWRITE (L)

Today it is a pool hook on a `uAAPL/USDC` fee-500 "lit" pool, with a Chainlink/TWAP mid, a qty/price-in-USD order
model, an in-contract EAS gate and forfeits redistributed to revealers. Target:
`contract DarkCrossHook is IDarkCrossHook, IUnlockCallback`, not a pool hook, settling an issuer pair
(base = mcbAAPL, quote = mAAPLx) at `IPriceOracle.getMid`, with residuals routed into the **ParityHook pool**.

| Function / element | Current (file:line) | Required | Risk |
|---|---|---|---|
| local interfaces `IDarkCalendar`, `IDarkOracle`, `IDarkEAS` | `:20-43` | DELETE. Use `IPriceOracle` and `IEligibility`. The EAS struct moves to `EASEligibility`. | L |
| constants | `:51-56` `FEE_BPS=5`, `ORACLE_STALE_SECS=86460`, `MAX_RESIDUAL_SLIPPAGE_BPS`, `TRUSTED_ATTESTER` | `BATCH_BLOCKS=20` (KEEP), `COMMIT_BLOCKS=12`, `REVEAL_BLOCKS=6`, `MAX_PARTICIPANTS=64`, `CROSS_FEE_PIPS=500`, `FORFEIT_BPS=10` (KEEP), `ORACLE_MAX_AGE=900`. Delete the rest. Add `MIN_LOCK` per erratum E11 (implementation constant, not in the interface). | L |
| immutables | `:57-67` `vault`, `usdc`, `calendar`, `eas`, `schema`, `owner`, `demoMode` | `poolManager`, `parityHook (IParityHook)`, `oracle (IPriceOracle)`, `eligibility (IEligibility)`, `baseToken`, `quoteToken`, `treasury`, `batchOrigin = block.number`. `parityPoolKey` is stored (a struct can't be immutable) and set in the constructor after validating `hooks == parityHook`, the currencies `{base, quote}` and `fee == DYNAMIC_FEE_FLAG`. `demoMode` moves to `IEligibility`. | M |
| `poolKey`, `configured`, `configurePool` | `:68-69`, `:171-185` | DELETE. Replaced by the constructor-set `parityPoolKey()`. | L |
| transient `INTERNAL_SLOT` | `:71-81` | KEEP the pattern. Rename it to a "settling" flag guarding `unlockCallback` and `executeResidual`. | L |
| structs `Balance`, `Order`, `Observation` | `:83-104` | `Order` becomes `IDarkCrossHook.Order` (commitHash, lockToken, locked, attestationUid, revealed, valid, sellBase, amountIn, limitPriceX18, routeResidual, crossedIn, residualIn). DELETE `Observation`. Add `mapping(uint256=>BatchResult)`. | M |
| storage `balances`, `orders`, `traders`, `settled`, `observations` | `:105-111` | `balances[account][token]` keyed by `address` instead of `Currency`, with a `balances(account, token) returns (available, locked)` view. `order(batchId, trader)` view. `participants`, `settled`, `batchResult`. DELETE observations. | L |
| events/errors | `:112-127` | Replace with the interface set (`Funded`, `Withdrawn`, `Committed(…, lockToken, locked)`, `Revealed`, `RevealRejected`, `Crossed(…, amountOut, feeAmount, mid)`, `ResidualRouted`, `ResidualSkipped`, `Forfeited(…, token, amount)`, `BatchSettled(8 fields)`). Errors: `NotPoolManager`, `Unauthorized(caller)`, `UnsupportedToken`, `WrongPhase(expected, actual)`, `InvalidCommit`, `AlreadyCommitted`, `BatchFull`, `UnknownCommit`, `AlreadyRevealed`, `CommitMismatch`, `AlreadySettled(id)`, `BatchNotSettleable`, `OracleStale`, `InsufficientEscrow`. | L |
| constructor | `:139-163` | `(IPoolManager, IParityHook, IPriceOracle, IEligibility, address base, address quote, PoolKey parityKey, address treasury)`. Require `base != quote`, both non-zero, `treasury != 0`, and the key check above. | L |
| `getHookPermissions`, `beforeAddLiquidity`, `beforeSwap`, `afterSwap`, `_observe`, `twapPrice`, `priceToSqrt`, `_mid`, `requiredBuyLock` | `:165-169`, `:269-299`, `:301-341`, `:343-359`, `:484-492`, `:242-245` | DELETE. No pool attachment, no TWAP, no Chainlink, no USD pricing. | L |
| `currentBatch` | `:191-197` returns `uint8` | Arithmetic **already conforms**. Change the return type to `Phase`, which is ABI-identical to `uint8`, and use the named constants. | L |
| `participants` | `:187-189` | **KEEP.** | L |
| NEW `commitHashOf` | hash built inline at `:251` as `keccak256(abi.encode(buy,qty,price,route,salt,id,sender))` | `keccak256(abi.encode(block.chainid, address(this), batchId, trader, sellBase, amountIn, limitPriceX18, routeResidual, salt))`. **Fixes cross-deployment and cross-chain replay.** | M |
| `fund` | `:203-209` `(Currency,uint256)` with the fee-on-transfer check | `(address token, uint256 amount)`. A token other than base/quote reverts `UnsupportedToken`. KEEP the balance-delta check. Emit `Funded`. | L |
| `withdraw` | `:211-215` underflow panic | `amount > available` reverts `InsufficientEscrow(token, available, amount)`. Emit `Withdrawn`. | L |
| `_gate` | `:217-224` in-contract EAS check, reverts `Unauthorized` | DELETE. Replaced by `eligibility.enforce(msg.sender, uid)`. | L |
| `commit` | `:226-240` reverts on denial; `(h, Currency, amount, uid)` | `(bytes32 commitHash, address lockToken, uint256 lockAmount, bytes32 uid) returns (bool)`. Checks in order: COMMIT phase else `WrongPhase(COMMIT, actual)`; supported token; `commitHash != 0 && lockAmount >= MIN_LOCK` else `InvalidCommit`; not already committed (`AlreadyCommitted`); participants < 64 (`BatchFull`); `lockAmount <= available` (`InsufficientEscrow`). **Then** call `enforce`. On false return `false` with no state written. On true, lock the funds, store the order with `attestationUid`, push the participant, emit `Committed`. Call `enforce` last among the reads so a denial provably changes nothing. | M |
| `reveal` | `:247-267` silently drops an invalid order | REVEAL phase of the batch **the caller committed to**, i.e. `batchId = current`, with phase checked as REVEAL. Unknown order reverts `UnknownCommit`. Revealed twice reverts `AlreadyRevealed`. Hash mismatch reverts `CommitMismatch`. Set `revealed=true`. Validity checks: `lockToken == (sellBase?base:quote)` (1), `locked >= amountIn` (2), `amountIn>0` (3), `limit>0` (4). The first failure emits `RevealRejected(reason)` and sets `valid=false`, with no forfeit. Otherwise `valid=true` and emit `Revealed`. | M |
| `settle` | `:361-431` Chainlink/TWAP mid, a single `cross=min(buys,sells)` in share qty, USD cost math, treasury gets the fee difference, unlock `(id, mid)` | New order: phase rule (`id < current`, or `== current && SETTLE`, else `BatchNotSettleable(id)`); `AlreadySettled(id)`; `(mid, updatedAt) = oracle.getMid(base, quote)`; `block.timestamp − updatedAt > 900` reverts `OracleStale`. Then the §1.8 steps 1-4: eligibility by limit, `QasBase`, `crossedBase`, `crossedQuote`; cumulative-floor allocation on **both** sides for `crossedIn` and gross received; fee `ceil(gross·500/1e6)` to the treasury's escrow (D8); `amountOut` to the trader's available balance; emit `Crossed`. Then `poolManager.unlock(abi.encode(uint8(1), batchId))` for residuals (step 5). Then forfeits (step 6), unlock the remaining locks, store `BatchResult`, emit `BatchSettled`. Guard divisions when `B==0` or `Q==0`. | H |
| `_spend` | `:433-437` | KEEP (decrements lock). | L |
| `_forfeits` | `:439-462` distributes the penalty to revealers weighted by qty | Penalty `floor(locked·10/1e4)` (at least 1 given `MIN_LOCK ≥ 1000`) goes **to the treasury only**, same token. Emit `Forfeited(id, trader, token, amount)`. DELETE the redistribution loop. | M |
| `unlockCallback` | `:464-482` payload `(id, mid)`, requires `entered` | Payload `abi.encode(uint8(1), batchId)`. Require `msg.sender == poolManager` (`NotPoolManager`), the settling flag set, and version 1. For each valid order with `routeResidual && residualIn > 0`, call `try this.executeResidual(...)`; on catch emit `ResidualSkipped(id, trader, reason)`. The reason bytes are a nested `WrappedError`; see §5. | M |
| `executeResidual` | `:494-536` swaps on the USDC lit pool with `priceToSqrt(bound)`; pays a USDC fee to the treasury | Self-only while settling (KEEP the `:495` guard, with `Unauthorized(msg.sender)`). `zeroForOne = (sellBase ? base : quote) == currency0`. Swap `parityPoolKey` exact-input `-residualIn` with `sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_PRICE+1 : MAX_SQRT_PRICE-1`, and **hookData `abi.encode(uint8(1), trader, order.attestationUid)`**. Afterwards require `out >= minOut` (§1.8 step 5 formula) or revert, which makes the outer try skip it. The actual consumed input may be less than `residualIn` if the fall-through hits the limit; credit only what was consumed. `_resolve` both currencies, credit the output to escrow, emit `ResidualRouted(id, trader, poolId, sellBase, inUsed, out)`. **No DarkCross fee on residuals.** The ParityHook fee applies inside the swap. | H |
| `_resolve` | `:538-546` | **KEEP** (sync, transfer, settle; or take). | L |
| NEW `order`, `batchResult`, `balances` views; `parityHook()`, `oracle()`, `eligibility()`, `treasury()`, `baseToken()`, `quoteToken()` | — | Straight getters. | L |
| `nonReentrant` modifier | `:128-133` storage bool | KEEP, or switch to a transient-storage lock. Apply to `fund`, `withdraw`, `commit`, `reveal`, `settle`. | L |

**DarkCross residual routing into the new pool (callout).**

- The residual swap targets `parityPoolKey`, i.e. the same `PoolKey` as `deployments.pool.key`. There is no separate
  lit pool.
- DarkCross is `sender` to the PoolManager and must be a **trusted router** in `IEligibility`, so ParityHook honours
  `swapper = trader`.
- ParityHook then (a) checks the trader's eligibility again with the committed uid, and (b) fills from inventory if
  possible, otherwise falls through to concentrated liquidity under the peg guard.
- Either failure mode (`NotEligible`, `PegGuardTripped`, token paused, `out < minOut`) reverts only the inner
  `executeResidual` frame. PoolManager transient deltas from that frame revert with it, so the outer unlock still nets
  to zero.
- §10 residual path for A: 10 mcbAAPL → 10.120474125 mAAPLx on anvil. `minOut` 10.1e18 is met.

### 1.3 `contracts/src/CanonicalStock.sol` — DELETE (S)

- Every function goes: `mint` `:35-47`, `redeem` `:49-65`, `backing` `:67-79`, `sweepFees` `:81-86`,
  `setInventoryProvider` `:88-90`, `pullInventory` `:93-97`, `pause` `:99-101`, `_active` `:103-105`,
  `_snapshot` `:107-111`.
- The ERC20 "Canonical Apple Share / uAAPL" (`:31`) must not exist.
- The replacement is the NEW `contracts/src/libraries/CanonicalShares.sol` (§1.9 signatures; `FullMath` everywhere).
  - Its `totalFeePips(s0, s1, open)` hardcodes 200/1300/1000/2500. This matches the TypeScript, which takes
    `skewFeePips` only in `skewPips`.
  - `feeOnGross` is `mulDivRoundingUp(gross, pips, 1e6)`. `grossForNet` is `mulDivRoundingUp(net, 1e6, 1e6-pips)`.
  - `skewX18` truncates toward zero; `skewPips` uses ceil; `deviationBps` uses ceil; `poolPriceX18` uses the exact
    decomposition (§1.1.6).
- Risk is low: nothing else imports `CanonicalStock` after ParityHook and Deploy are rewritten.

### 1.4 `contracts/src/IssuerRegistry.sol` — MODIFY (S)

| Function | Current | Required | Risk |
|---|---|---|---|
| contract decl | `:6` `IssuerRegistry is Ownable` | `is IIssuerRegistry, Ownable` | L |
| storage | `:7-9` | Add `mapping(address=>bytes32) underlyingOf`. KEEP `adapterOf`, `paused`, `list`. | L |
| events | `:10-12` non-indexed; `IssuerPaused(token)` lacks the bool | Use the interface events (indexed; `IssuerPaused(token, paused)`). | L |
| `add` | `:15-22` bare require | `token==0`, or `ratio()` not healthy / zero, or `underlying()==0` reverts `InvalidAdapter(adapter)`. Already registered reverts `AlreadyRegistered(token)`. Store `underlyingOf`. Emit `IssuerAdded(token, adapter, underlying)`. | L |
| `remove` | `:24-36` takes an **adapter** | Takes a **token**. Unknown reverts `UnknownIssuer(token)`. Delete `adapterOf`/`underlyingOf`/`paused`, swap-pop the list, emit `IssuerRemoved`. | L |
| `pause` | `:38-43` takes an adapter; one-way | Rename to `setPaused(address token, bool)`. `UnknownIssuer`. Emit `IssuerPaused(token, paused)`. | L |
| `adapters` | `:45-47` | **KEEP (already conforms).** | L |
| `adapterOf` | `:8` public mapping | **KEEP (already conforms).** | L |
| `isIssuer` | `:49-51` | **KEEP (already conforms).** | L |
| `paused` | `:9` public mapping | **KEEP (already conforms).** | L |
| `active` | `:53-55` uses `IIssuerAdapter.paused()` | `isIssuer && !paused[t] && healthy`, where `(, healthy) = IWrapperAdapter(adapterOf[t]).ratio()`. Wrap the adapter call in try/catch and return false on revert, so a reverting adapter can't brick views. | M |

### 1.5 `contracts/src/NyseCalendar.sol` — MODIFY (S)

| Function | Current | Required | Risk |
|---|---|---|---|
| decl | `:6` | `is INyseCalendar, Ownable` | L |
| `HolidaySet` | `:9` non-indexed | Interface event (`day` indexed). | L |
| constructor holidays | `:11-32` | **KEEP.** I verified the 20 days map to the 2026-2027 NYSE holidays. Consider adding the 2026-11-27 and 2026-12-24 13:00 early closes (`setEarlyClose(day, 46800)`). They are not needed for §10. | L |
| `setHoliday` | `:34-37` | **KEEP (already conforms).** | L |
| `setEarlyClose` | `:39-42` bare require, no event | Out of range reverts `InvalidEarlyClose(s)`. Allow `0` to clear (erratum E13). Emit `EarlyCloseSet`. | L |
| `isOpen` | `:44-52` | **KEEP (already conforms).** I checked it against §10: `isOpen(1790692200)=true`, `isOpen(Sat 2026-09-26)=false`, `nextTransition(Sat)=1790602200`. | L |
| `nextTransition` | `:54-65` `revert("no transition within year")` | Replace the string revert with `NoTransitionWithinYear(ts)`. Logic otherwise KEEP. | L |
| `holidays`, `earlyClose` | `:7-8` public mappings | **KEEP (already conform).** | L |

### 1.6 Adapters

| File | Status | Function diffs | Risk |
|---|---|---|---|
| `contracts/src/adapters/IIssuerAdapter.sol` (`:4-9`) | DELETE | The legacy interface (`token`, `sharesPerToken`, `paused`, `name`) is superseded by `IWrapperAdapter`. | L |
| `contracts/src/adapters/StaticAdapter.sol` | REWRITE (S) | `StaticAdapter is IWrapperAdapter, Ownable`. Constructor `(token, bytes32 underlying, string name, uint256 spt, address owner)`; `tokenDecimals` is read once from `IERC20Metadata` and stored immutable. `setSharesPerToken` (`:19-22`) reverts `InvalidRatio(0)` on zero and emits `RatioUpdated(token, old, new)`. `setPaused` (`:24-26`) emits `AdapterPaused`. `health() = (paused, false, updatedAt)`, where `updatedAt` is the last set time. `ratio() = (spt, !paused)`. DELETE `MockAdapter` (`:29-31`). | L |
| `contracts/src/adapters/B20Adapter.sol` | REWRITE → `B20MultiplierAdapter` (S) | `sharesPerToken()` reads `multiplier()` (existing `:20-22`) and reverts `InvalidRatio` if 0 or above a sanity cap of `1e24`, i.e. one token equal to at most 1e6 shares. `paused` reads `IMockIssuerToken(token).transfersPaused()` instead of `pausedFeatures().length` (`:24-26`). The real B20 on chain 8453 is out of scope because the `Network` enum is anvil and unichain-sepolia only. `health() = (paused, false, uint64(block.timestamp))`; see erratum E8. `ratio()` returns `(spt, !paused && spt>0)` and does not revert, using try/catch on the token. `underlying()` and `tokenDecimals()` are immutable. `name() = "Coinbase B20"` (KEEP). | M |
| NEW `contracts/src/adapters/XStocksMultiplierAdapter.sol` | NEW (S) | The same as B20 over an xStocks-shaped `multiplier()`. The §4 example lists mAAPLx as `XStocksMultiplier`. Share the code through `abstract contract MultiplierAdapterBase`. | L |

### 1.7 Mocks

| File | Status | Diff | Risk |
|---|---|---|---|
| `contracts/src/mocks/MockIssuerToken.sol` | REWRITE (S) | `is IMockIssuerToken, ERC20, Ownable`. Constructor `(name, symbol, decimals, initialMultiplier)`. `sharesPerToken` (`:9`) and `setSharesPerToken` (`:24-27`) become `multiplier` and `setMultiplier`, which reverts `InvalidMultiplier(0)` and emits `MultiplierUpdated`. Add `transfersPaused` and `setTransfersPaused` (emits `TransfersPaused`), and `_update` reverting `TokenPaused()` while paused (logic currently in `MockB20.sol:27-30`). `mint` is onlyOwner (KEEP `:20-22`). `decimals` (KEEP `:16-18`). mcbAAPL uses 6 decimals; the current code and tests use 8 (`MockB20.sol:8`). | L |
| `contracts/src/mocks/MockB20.sol` | DELETE | Folded into `MockIssuerToken` (D2). | L |
| `contracts/src/mocks/MockOracle.sol` | DELETE → NEW `contracts/src/mocks/MockPriceOracle.sol` | Implements `IMockPriceOracle`. `setMid` is pusher-only (`NotPusher`), zero reverts `ZeroMid`, and it stores `updatedAt = block.timestamp` and emits `MidUpdated`. `setPusher` is owner-only and emits `PusherSet`. `getMid(base, quote)`: stored value, else the inverse `floor(1e36/stored)` with the same `updatedAt`, else `NoPrice`. | L |
| NEW `contracts/src/EASEligibility.sol` | NEW (M) | Implements `IEASEligibility`: the decision procedure of §1.4 in order, reasons 0-7; `enforce` emits `EligibilityDenied(account, msg.sender, reason, uid)`; `setDemoMode` emits `DemoModeSet`; `setTrustedRouter` emits `TrustedRouterSet`; `resolveSwapper` per §1.4; `NotOwner(caller)` on owner functions. `eas == address(0)` (anvil) with demoMode off must return `(false, 1)` and not revert. It carries the local EAS `Attestation` struct and a minimal `IAttestationIndexer.getAttestationUid(address,bytes32)`. The `restrictedCountry` compare is `keccak256(bytes(decoded)) == keccak256("US")`, with the decode wrapped in try/catch. Undecodable data maps to reason 2 (WRONG_SCHEMA); record that decision in `decisions/contracts.md`. | M |

### 1.8 Interfaces (`contracts/src/interfaces/*.sol`) — UNAFFECTED

Frozen. Verified identical to `INTERFACES.md` §1.1-§1.8. Owned by the interfaces lane. See §6 for the per-file listing.

### 1.9 Mapping: every INTERFACES.md §1 function → task

Task IDs refer to §6.

| Interface | Function → task |
|---|---|
| IWrapperAdapter | `token` T4 (already conforms in `StaticAdapter.sol:7` / `B20Adapter.sol:12`, kept) · `underlying` T4 · `name` T4 (already conforms, kept) · `tokenDecimals` T4 · `sharesPerToken` T4 (already conforms semantically; add `InvalidRatio`) · `health` T4 · `ratio` T4 |
| IIssuerRegistry | `add` T5 · `remove` T5 · `setPaused` T5 · `adapters` already conforms (T5 keeps) · `adapterOf` already conforms · `underlyingOf` T5 · `isIssuer` already conforms · `paused` already conforms · `active` T5 |
| INyseCalendar | `isOpen` already conforms · `nextTransition` T6 (error only) · `holidays` already conforms · `earlyClose` already conforms · `setHoliday` already conforms (T6 swaps in the interface event) · `setEarlyClose` T6 |
| IEligibility / IEASEligibility | `owner` `demoMode` `setDemoMode` `check` `enforce` `isTrustedRouter` `setTrustedRouter` `resolveSwapper` `eas` `attestationIndexer` `schemaUid` `trustedAttester` `restrictedCountry` → all T7 (new contract) |
| IPriceOracle / IMockPriceOracle | `getMid` `setMid` `setPusher` `isPusher` → T3 |
| IMockIssuerToken | `multiplier` `transfersPaused` `mint` (already conforms, `MockIssuerToken.sol:20`) `setMultiplier` `setTransfersPaused` → T3. IERC20Metadata is already conformant via OZ `ERC20`. |
| IParityHook | `BASE_FEE_PIPS` `SKEW_FEE_PIPS` `CLOSED_FEE_PIPS` `MAX_FEE_PIPS` `HOOK_DATA_VERSION` T8 · `PEG_GUARD_BPS` already conforms (`ParityHook.sol:34`) · `poolManager` already conforms (`:30`) · `registry` `calendar` T8 (retype) · `eligibility` T8 · `isKeeper` `setKeeper` T8 · `depositInventory` `withdrawInventory` `sweepFees` T8 · `inventory` already conforms semantically (`:67`; T8 renames the storage) · `inventoryShares` `feesAccrued` T8 · `feeBreakdown` `quote` `pegStatus` `pegTripped` `checkPeg` T8 · hook callbacks `beforeInitialize` / `beforeSwap` / `afterSwap` T8 |
| IDarkCrossHook | `BATCH_BLOCKS` already conforms (`DarkCrossHook.sol:51`) · `FORFEIT_BPS` already conforms (`:53`) · `COMMIT_BLOCKS` `REVEAL_BLOCKS` `MAX_PARTICIPANTS` `CROSS_FEE_PIPS` `ORACLE_MAX_AGE` T9 · `poolManager` already conforms (`:57`) · `batchOrigin` already conforms (`:67`, `:162`) · `parityHook` `oracle` `eligibility` `baseToken` `quoteToken` `parityPoolKey` `treasury` T9 · `currentBatch` T9 (arithmetic conforms; return type only) · `commitHashOf` T9 · `fund` `withdraw` `balances` T9 · `commit` `reveal` `settle` T9 · `order` T9 · `participants` already conforms (`:187`) · `settled` already conforms (`:108`) · `batchResult` T9 |
| CanonicalShares (§1.9) | `toSharesDown` `toSharesUp` `fromSharesDown` `fromSharesUp` `parityPriceX18` `skewX18` `skewPips` `totalFeePips` `feeOnGross` `grossForNet` `poolPriceX18` `deviationBps` → T1 |

---

## 2. Security review of the reframed design

Test names are `File.t.sol::function`. Every test listed here is NEW, and is also listed in §4.3.

### S1. Rounding direction on every conversion — severity: High if wrong; design as specified is correct

Every conversion and the direction it must round:

| Conversion | Rule | Favours |
|---|---|---|
| exact-in `shares` | `toSharesDown` | hook |
| exact-in `grossOut` | `fromSharesDown` | hook |
| exact-in `feeAmount` | ceil | hook |
| exact-out `grossOut` | `grossForNet`, ceil | hook |
| exact-out `shares` | `toSharesUp` | hook |
| exact-out `amountIn` | `fromSharesUp` | hook |
| skew inputs | `toSharesDown`; `skewPips` ceil, so the fee is higher | hook |
| peg `parityPriceX18` / `poolPriceX18` | floor | — |
| peg `deviationBps` | ceil | conservative: trips early |
| dark `QasBase` / `crossedQuote` | floor | never over-crosses |
| dark allocations | cumulative floor | exact conservation, no dust creation |
| cross fee | ceil | treasury |
| forfeit | floor | trader. Only safe with `MIN_LOCK`; see S6. |
| residual `minOut` | floor | looser by ≤1 raw unit; acceptable |

- **Exploit sketch if one of these is flipped:** make exact-out `amountIn` use `fromSharesDown`. Then an exact-out swap
  for 1 wei of mAAPLx, paying in 6-decimal mcbAAPL, computes `amountIn = floor(2·1e6/1.0125e18) = 0`. The fill guard
  `amountIn > 0` would catch that, but at `B = 1e12` the same bug under-charges by up to 1 raw mcbAAPL per swap. On an
  L2 a loop of such swaps drains inventory at roughly 1e-6 AAPL per tx, net of gas. The 6/18 decimal mismatch is what
  makes it material.
- **Tests:**
  - `CanonicalShares.t.sol::testFuzz_downLeUp`
  - `CanonicalShares.t.sol::testFuzz_roundTripNeverGainsShares`
  - `ParityHook.t.sol::testFuzz_exactInRoundsForHook`
  - `ParityHook.t.sol::testFuzz_exactOutRoundsForHook`
  - `ParityHook.t.sol::testFuzz_dustFallsThroughReason2`
  - `ParityHookInvariant.t.sol::invariant_noExtractionBeyondFee`

### S2. Donation / inflation on inventory — severity: Low

- **Sketch:** anyone can raise the hook's ERC-6909 balance with `PoolManager.transfer(hook, id, amt)` or
  `mint(hook, id, amt)` inside their own unlock. `inventory()` counts it, but no `InventoryChanged` is emitted.
  - Effect 1: the skew, and so the fee, moves. Cutting a swap's fee by Δpips needs a donation on the order of
    `Δskew × inventory`. The saving is `swap × Δpips / 1e6 ≤ inventory × 1300 / 1e6`, which is far below the
    donation. It is unprofitable by at least about 700×.
  - Effect 2: the indexer's `inventoryAfter` diverges from the chain, but the API reads the chain (§5 `/inventory`).
  - There is no share token, so ERC-4626-style inflation does not apply. Direct ERC20 transfers to the hook are simply
    stuck; they are not inventory.
- **Mitigation:** keep `inventory = balanceOf − feesAccrued`, since donations only benefit the hook. `feesAccrued` can
  only grow out of retained claims, so there is no underflow.
- **Tests:**
  - `ParityHook.t.sol::test_donatedClaimsCountAsInventory`
  - `ParityHook.t.sol::testFuzz_donationCannotReduceFeeProfitably`
  - `ParityHookInvariant.t.sol::invariant_claimsEqualInventoryPlusFees`

### S3. Reentrancy across unlock callbacks — severity: Medium

- **Sketches:**
  - (a) An attacker calls `ParityHook.unlockCallback` directly with a crafted withdraw payload. Guarded by
    `NotPoolManager` and the transient `_expectingCallback` flag.
  - (b) Inside the attacker's own unlock, the attacker calls `depositInventory`/`withdrawInventory` (as a keeper),
    hoping to share deltas. `PoolManager.unlock` reverts `AlreadyUnlocked`.
  - (c) `DarkCrossHook.unlockCallback` is invoked outside `settle`. It requires the settling flag and version 1.
  - (d) `executeResidual` is called externally. Self-only while settling.
  - (e) The transient fill flag from swap N leaks into swap N+1 in the same unlock (a UR multi-swap, or several
    residuals), so a fall-through is treated as a fill and the peg guard is skipped. `afterSwap` must always clear it.
  - (f) `beforeSwap` makes external calls (`registry.active` → adapter → token, `eligibility.check`,
    `calendar.isOpen`). All of them are `view`, so the compiler emits STATICCALL and they cannot re-enter.
- **Tests:**
  - `ParityHook.t.sol::test_unlockCallbackRejectsNonManager`
  - `ParityHook.t.sol::test_depositInsideForeignUnlockReverts`
  - `ParityHook.t.sol::test_transientStateClearedBetweenSwapsInOneUnlock`, using a test router that does a fill and
    then a fall-through in a single unlock and asserts the peg guard fires on the second
  - `DarkCrossHook.t.sol::test_unlockCallbackOnlyDuringSettle`
  - `DarkCrossHook.t.sol::test_executeResidualOnlySelf`
  - `DarkCrossHook.t.sol::test_settleNonReentrant`

### S4. Adapter staleness and malicious ratio — severity: High (economic)

- **Sketches:**
  - (a) Corporate-action front-run. A multiplier increase of Δ (say 0.4%) is predictable. The attacker buys the
    rising token from inventory at the old parity just before the update, then sells it back after. Profit is
    `Δ − 2·fee ≈ 0.4% − 0.09%` of the size, capped by inventory. Fills are at parity by construction, so the peg guard
    does not help.
  - (b) A compromised token owner (the mock owner is the deployer) sets the multiplier ×2 and drains the other side's
    inventory in one fill.
  - (c) The adapter returns 0 or a huge ratio, causing division by zero or overflow in `toShares`.
  - (d) The token is paused but the adapter doesn't report it. For multiplier adapters `stale` is always false.
- **Mitigations:**
  - `beforeSwap` requires `registry.active`, which includes the registry pause (D4 / E3). Ops pause across announced
    actions.
  - Adapters revert `InvalidRatio` outside `(0, 1e24]` and `ratio()` reports `healthy=false`.
  - Optionally cap the fill size per swap (not in the interface; not recommended for the demo).
  - The residual risk is documented as a trust assumption on the issuer multiplier.
- **Tests:**
  - `Adapters.t.sol::test_multiplierAdapter_pausedTokenUnhealthy`
  - `Adapters.t.sol::test_staticAdapter_zeroRatioReverts`
  - `Adapters.t.sol::test_multiplierAdapter_outOfBoundsRatioUnhealthy`
  - `ParityHook.t.sol::test_beforeSwapRevertsAdapterUnhealthy`
  - `ParityHook.t.sol::test_registryPauseBlocksSwaps`
  - `ParityHook.t.sol::test_multiplierJumpArbBoundedAndStoppedByPause`, which asserts the profit is at most
    `Δ·size − fees` and that a pause stops it

### S5. Delta accounting must net to zero — severity: Critical if wrong

- **Sketch:** the PoolManager reverts `CurrencyNotSettled` on any non-zero delta, so a mis-signed delta shows up as a
  DoS (every fill reverts). The dangerous class is balanced but wrong: for example, burning `grossOut` instead of
  `amountOut` while also adding `feeAmount` to `feesAccrued` double-counts fees. `inventory()` then underflows later
  and blocks every swap, or `sweepFees` takes the LP's claims. Exact-out with the specified/unspecified legs swapped
  passes the PoolManager but pays the wrong amount.
- **Tests:**
  - `ParityHook.t.sol::testFuzz_fillDeltasExact` asserts the swapper's delta equals `(−amountIn, +amountOut)` in both
    modes and both orderings, and that `TransientStateLibrary.getNonzeroDeltaCount(manager) == 0` after the call.
  - `ParityHookInvariant.t.sol::invariant_poolManagerDeltasSettled`
  - `ParityHookInvariant.t.sol::invariant_claimsEqualInventoryPlusFees`
  - `DarkCrossHook.t.sol::testFuzz_escrowConservation`, which requires that `Σ(available+locked)` per token equals
    `token.balanceOf(dark)` after every settle, including residuals.

### S6. DarkCross commit griefing — severity: Medium (liveness)

- **Sketches:**
  - (a) 64 sybils (free under demoMode, or 64 attested accounts) each commit a 1-wei lock every batch. Real traders
    get `BatchFull`. Unrevealed forfeit is `floor(1·10/1e4) = 0`, so the attack is free.
  - (b) An option attack: a sybil set commits both sides and reveals selectively after seeing others' reveals. It
    costs 10 bps on each unrevealed lock.
  - (c) Commit spam to raise the gas cost of `settle`, which is O(participants) with an O(n) unlock loop. This is
    bounded by 64.
- **Mitigation:** `MIN_LOCK` (implementation constant; erratum E11), e.g. `≥ 10_000` raw units, which makes the
  forfeit ≥ 10. The 10 bps forfeit covers (b) economically. `MAX_PARTICIPANTS` bounds (c).
- **Tests:**
  - `DarkCrossHook.t.sol::test_commitBelowMinLockReverts`
  - `DarkCrossHook.t.sol::test_batchFullAt64`
  - `DarkCrossHook.t.sol::test_unrevealedForfeitToTreasuryNonZero`
  - `DarkCrossHook.t.sol::test_settleGasBoundedAt64Participants`

### S7. Oracle manipulation at reveal — severity: Medium (production) / Low (demo, where the mid equals adapter parity)

- **Sketch:** reveals are public during REVEAL, and `settle` reads `getMid` at settle time. A pusher, or anyone who
  controls adapter ratios, which the crank derives the mid from, can push a mid at the edge of one side's limit after
  seeing the reveals. `settle` is permissionless and valid at any later block, so a participant can choose **which**
  mid (among pushes within 900 s) applies.
- **Mitigations:**
  - Limits bound every trader's worst price.
  - `OracleStale` bounds staleness.
  - Proposed (erratum E16): reject a mid off adapter parity by more than `PEG_GUARD_BPS`.
  - Pusher is a single crank key (§7). This is a trust assumption.
- **Tests:**
  - `DarkCrossHook.t.sol::test_settleRevertsOracleStale`
  - `DarkCrossHook.t.sol::test_midMovedAfterRevealRespectsLimits`
  - `MockPriceOracle.t.sol::test_setMidOnlyPusher`
  - `MockPriceOracle.t.sol::test_inverseMidFloor`
  - Only if E16 is adopted: `DarkCrossHook.t.sol::test_settleRejectsMidOffParity`

### S8. demoMode left on — severity: High for any production use; accepted on anvil and Sepolia per the settled decision

- **Sketch:** a deployment ships with `demoMode=true`, so every account (including US persons) passes both hooks.
  Alternatively, a compromised eligibility owner flips it silently.
- **Mitigations:**
  - `Deploy.s.sol` reads `DEMO_MODE` explicitly with no hidden default on non-anvil chains; it must be set.
  - The manifest's `demoMode` is read back from `eligibility.demoMode()`, not a literal (today it is hardcoded at
    `Deploy.s.sol:187`).
  - `DemoModeSet` is indexed. `/health` exposes it.
  - Owner-only with `NotOwner`.
- **Tests:**
  - `EASEligibility.t.sol::test_setDemoModeOnlyOwner`
  - `EASEligibility.t.sol::test_setDemoModeEmits`
  - `EASEligibility.t.sol::test_demoModeOffRejectsUS`
  - `ParityHook.t.sol::test_demoModeOffBlocksIneligibleSwap`
  - `Deploy.t.sol::test_manifestDemoModeReadFromChain`

### S9. hookData spoofing from non-allowlisted routers — severity: High (the design as frozen has a gap; erratum E1)

- **Sketches:**
  - (a) A non-allowlisted contract calls `PoolManager.swap` with hookData naming an attested address.
    `resolveSwapper` returns `sender`, so the attacker contract is checked and denied. This is correct.
  - (b) **The allowlisted routers are permissionless.** Anyone can call `PoolSwapTest.swap` or the Universal Router
    with hookData `swapper = <any attested non-US address>`. The claim is honoured, so the eligibility gate is bypassed
    whenever demoMode is off.
  - (c) Malformed hookData (length 64/95/97, version 2, dirty version word) must revert `InvalidHookData` and must not
    silently fall back to `sender`.
  - (d) Empty hookData through a router means the router is the swapper, so every legitimate user is denied. Web and
    API must always send v1 (§5).
- **Tests:**
  - `ParityHook.t.sol::test_untrustedSenderClaimIgnored`
  - `ParityHook.t.sol::test_invalidHookDataReverts`, fuzzing length and version
  - `ParityHook.t.sol::test_trustedRouterClaimHonoured`
  - `ParityHook.t.sol::test_publicRouterCannotLaunderSwapper`. This one depends on the E1 fix. Until E1 is resolved it
    is written as `test_publicRouterClaimIsUnauthenticated_KNOWN`, which asserts the bypass exists so the risk stays
    visible.
  - `EASEligibility.t.sol::testFuzz_resolveSwapper`

### S10 (additional). Pool-init front-run on Unichain Sepolia — severity: Medium

- **Sketch:** the PoolKey is predictable once the hook is deployed. An attacker initialises it first at an off-parity
  `sqrtPriceX96`. `Deploy.s.sol`'s initialize then reverts `PoolAlreadyInitialized`, and every fall-through trips the
  peg guard until someone moves the price. Fills still work.
- **Mitigation:** D5, i.e. `beforeInitialize` rejects an off-parity price. Also deploy the hook and initialise the pool
  in consecutive transactions.
- **Test:** `ParityHook.t.sol::test_beforeInitializeRejectsOffParityPrice`

### S11 (additional). Unauthenticated `EligibilityDenied` spam — severity: Info

- **Sketch:** anyone can call `enforce` to emit denials.
- **Mitigation:** §1.4 already says the indexer only consumes denials where `caller` is a deployment hook.
- **Test:** `EASEligibility.t.sol::test_enforceEmitsCallerAsMsgSender`

---

## 3. Deploy script: `contracts/script/Deploy.s.sol` → `deployments/<network>.json`

Current state:

- `Deploy.s.sol:52-104` targets chain 8453/1301 through `Addresses.forChain` and reverts on 31337.
- It deploys `CanonicalStock` (`:66`), two vault/issuer pools with `tickSpacing 60` (`:89-90`, `:126`) and a USDC
  lit pool (`:91`, `:96`).
- It initialises pools through the PositionManager (`:92-96`) with an imprecise `_sqrtFor` (`:131-134`).
- It writes a legacy JSON shape (`:162-208`) to `deployments/local.json` / `unichain-sepolia.json` (`:207`).

Required rewrite (M-L):

1. **Network and externals.**
   - `NETWORK` env is `anvil` or `unichain-sepolia`. Assert `anvil ⇔ chainid 31337` and `unichain-sepolia ⇔ 1301`, else
     revert.
   - Drop `import "./Addresses.sol"` (`:4`). Read externals from env with `vm.envOr` defaults:
     `POOL_MANAGER`, `POSITION_MANAGER`, `STATE_VIEW`, `V4_QUOTER`, `UNIVERSAL_ROUTER`, `PERMIT2`, `EAS`,
     `EAS_INDEXER`, `EAS_SCHEMA_UID`, `EAS_TRUSTED_ATTESTER`.
   - Unichain Sepolia defaults are the §4 placeholder values, which match `Addresses.sol:30-34`. The trusted attester
     defaults to `0x357458739F90461b99789350868CD7CF330Dd7EE`.
   - **Verify `EAS_SCHEMA_UID`.** `Deploy.s.sol:39` hardcodes `0xf8b05c79…0de9`, which I believe is Coinbase's
     *Verified Account* schema, not *Verified Country*. The value must come from env and be checked on Uniscan
     before the demoMode-off test.
   - On anvil every nullable external is `null`. **Deploy locally:** `new PoolManager(deployer)`,
     `new V4Quoter(pm)` (periphery `src/lens/V4Quoter.sol`, pragma `^0.8.0`, compiles under 0.8.26),
     `new PoolSwapTest(pm)`, `new PoolModifyLiquidityTest(pm)`.
   - On Unichain Sepolia deploy `PoolSwapTest` and `PoolModifyLiquidityTest` against the canonical PoolManager.
2. **Accounts.**
   - `DEMO_MNEMONIC` via `vm.deriveKey(mnemonic, i)` for i = 0..4. Default is the anvil test mnemonic, but only when
     chainid is 31337.
   - `DEPLOYER_PK` may override index 0. `mnemonicSource` is `anvil-default` or `env:DEMO_MNEMONIC`.
   - The deployer (index 0) is owner, keeper and treasury. The crank is index 4.
   - Never write keys. Today `Seed.s.sol:95-110` writes burner private keys into `local.json`; that pattern must not
     carry over.
3. **Order**, chosen so `startBlock` (the registry block) precedes every indexed contract:
   - (anvil only) poolManager, quoter, swapRouter, modifyLiquidityRouter;
   - registry;
   - calendar;
   - `EASEligibility(owner, eas, indexer, schema, attester, "US")`;
   - `MockPriceOracle(owner)`;
   - mcbAAPL `MockIssuerToken("Mock Coinbase Apple","mcbAAPL",6,1.0125e18)`;
   - mAAPLx `MockIssuerToken("Mock Apple xStock","mAAPLx",18,1e18)`;
   - `B20MultiplierAdapter(mcbAAPL,"AAPL")`, `XStocksMultiplierAdapter(mAAPLx,"AAPL")`;
   - `registry.add` ×2;
   - ParityHook: mined `0x20C8` via `CREATE2_PROXY`. Assert `CREATE2_PROXY.code.length > 0`, which anvil predeploys.
     Keep `_hook` at `:112-119`.
   - `DarkCrossHook(pm, parity, oracle, eligibility, mcbAAPL, mAAPLx, key, treasury)` with plain CREATE;
   - `eligibility.setTrustedRouter` for swapRouter, darkCrossHook and quoter (E2), plus universalRouter on Sepolia;
   - `oracle.setPusher(crank, true)`;
   - `eligibility.setDemoMode(vm.envBool("DEMO_MODE"))`, defaulting to `true` only on anvil;
   - `poolManager.initialize(key, initSqrt)` **directly**, with no PositionManager.
4. **PoolKey.** `currency0/1` = the sorted issuer tokens, `fee = 8388608`, `tickSpacing = 10`,
   `hooks = parityHook`. Replace `_key` (`:121-129`).
   - `initSqrtPriceX96 = Math.sqrt(FullMath.mulDiv(spt0·10^dec1, 2^192, spt1·10^dec0))`, which is exactly §10's
     `isqrt(floor(num·2^192/den))`. Replace `_sqrtFor` (`:131-134`).
   - Assert it equals the §10 constant for the realised ordering.
5. **Manifest writer.** Replace `_manifest` (`:162-208`), `_token` (`:136-140`) and `_pool` (`:142-160`). Write raw
   JSON with literal `null` for nullable externals, decimal-string `UInt`s and `vm.toString(address)` (EIP-55) to
   `deployments/${NETWORK}.json`. `fs_permissions` already allows `./deployments`.
   - `schemaVersion: 1`, `network`, `chainId`.
   - `deployCommit` from env `DEPLOY_COMMIT`. It must be 40 lowercase hex characters; revert otherwise. `vm.ffi` is
     unavailable because `foundry.toml` has no `ffi` and is not contracts-lane-owned.
   - `deployedAt` from env `DEPLOYED_AT`, falling back to formatting `block.timestamp` as ISO-8601 UTC with a
     civil-from-days helper.
   - `deployer`, `demoMode` (read from chain), `mockOracle: true`.
   - `contracts`: all 16 keys.
   - `tokens`: the two `DeploymentToken`s. `sharesPerTokenX18` is read from the adapter. `darkRole` is base/quote.
   - `pool {id, key, initSqrtPriceX96}`.
   - `hooks.parityHook {address, flags: "0x20c8", permissions: [4 names]}`. Assert `uint160(addr) & 0x3fff == 0x20c8`.
   - `hooks.darkCrossHook {…, "0x0000", []}`.
   - `dark {baseToken, quoteToken, batchOrigin: dark.batchOrigin(), 20, 12, 6}`.
   - `demoAccounts`.
   - `blocks` and `startBlock`: step 6.
   - No `verification` key; the deployment lane adds it.
6. **Blocks (D9 / E5).**
   - Forge simulates every broadcast transaction at a single block number, so `block.number` at write time is wrong
     for every contract.
   - Add `function manifest() external`, a second invocation without `--broadcast`. It re-reads the addresses from the
     just-written JSON and, for each created contract, binary-searches the first block with code using
     `vm.rpc("eth_getCode", [addr, hex(n)])` over `[DEPLOY_FROM_BLOCK, head]`. That is about 10-20 calls per
     contract.
   - `DEPLOY_FROM_BLOCK` is the head before deploy, passed by the caller.
   - It fills `blocks`, `startBlock = blocks.registry` and `blocks.poolInitialized`. For the latter, search
     `StateLibrary.getSlot0` for a non-zero `sqrtPrice` through `vm.rpc("eth_call", …, n)`.
   - `batchOrigin` is read from the contract itself.
   - Fallback if the Sepolia RPC prunes state: file a CR for `fs_permissions` read access to `./broadcast` and parse
     `run-latest.json` receipts.
7. **Delete** the `IDeployRegistry/IDeployDark/IDeployPosition/IDeployFeed` shims (`:17-32`), `LIVE_AAPL` (`:38`),
   the mock-B20 fork logic (`:56`, `:59`), the USDC/MockOracle branch (`:68-71`), `configurePool` (`:97`) and the
   legacy logs (`:100-103`).
8. **No seeding in Deploy.** Balances, inventory, LP and escrow funding belong to integration's `SeedDemo.s.sol`
   (§8), so that §10's starting state is exact.

---

## 4. Tests

### 4.1 Existing test files and functions

`contracts/test/ParityVault.t.sol`: the whole file is superseded by `ParityHook.t.sol` and the others below. The
`setUp` at `:53-97` is REWRITTEN because it depends on `CanonicalStock`, `StaticAdapter(1e18)` and the vault pool.

| Function (line) | Fate | Why / new home |
|---|---|---|
| `testForkDeployedBasePoolManagerParityFill` (:108) | DELETE | Base mainnet (8453) is outside the `Network` enum. |
| `testEightDecimalHookExactInOutAndGuard` (:117) | REWRITE | Becomes `ParityHook.t.sol::test_sixEighteenDecimalExactInOut` (mcbAAPL is 6 decimals). |
| `testEightDecimalIssuer` (:161) | DELETE | Vault mint/redeem. |
| `testProviderCannotImpairBacking` (:170) | DELETE | Vault `pullInventory`. |
| `testMintRedeemBothAndFee` (:176) | DELETE | Vault. |
| `testFuzzBacking` (:186) | DELETE | Replaced by `invariant_inventorySharesNonDecreasing`. |
| `testPaused` (:197) | REWRITE | `ParityHook.t.sol::test_registryPauseBlocksSwaps` |
| `testShortInventory` (:203) | REWRITE | `ParityHook.t.sol::test_insufficientInventoryFallsThroughReason1` |
| `testMultiplierReprices` (:210) | REWRITE | `ParityHook.t.sol::test_multiplierRepricesQuote` |
| `testExactInputBothDirections` (:219) | REWRITE | `ParityHook.t.sol::test_exactInBothDirections`, run under both orderings |
| `testExactOutputBothDirections` (:230) | REWRITE | `ParityHook.t.sol::test_exactOutBothDirections`, both orderings |
| `testFeeSweepClaims` (:239) | REWRITE | `ParityHook.t.sol::test_sweepFeesReturnsAndEmits` |
| `testSkewMonotonicAndHours` (:250) | REWRITE | `ParityHook.t.sol::test_feeBreakdownPipsFormula` and `test_closedFeeAdds1000` |
| `testFallbackCurveAndFeeOverride` (:262) | REWRITE | `ParityHook.t.sol::test_fallThroughChargesOverrideFee` (keeps the `lpFee == 0` stored assertion) |
| `testGuardOffParity` (:273) | REWRITE | `ParityHook.t.sol::test_pegGuardRevertsInAfterSwap`, expecting a `WrappedError` around `PegGuardTripped` |
| `testRejectStaticPool` (:281) | REWRITE | `ParityHook.t.sol::test_beforeInitializeDynamicFeeRequired` |
| `testCallbackProtected` (:287) | KEEP (adapted) | `ParityHook.t.sol::test_callbacksOnlyManager` (`NotPoolManager`) |
| `testCalendar` (:292) | KEEP | Moves to `NyseCalendar.t.sol::test_calendarKnownDates` |
| `testDstBoundary` (:303) | KEEP | Moves to `NyseCalendar.t.sol::test_dstBoundary` |
| helpers `TestIssuer`, `TestIssuer8` (:23-35) | DELETE | Use `MockIssuerToken`. |

`contracts/test/DarkCrossHook.t.sol` is REWRITTEN in place. `setUp` (`:97-124`), `_deploy` (`:126-155`),
`_fund`, `_commit`, `_reveal` and `_assertEscrow` are rewritten for the issuer pair and a ParityHook pool.

| Function (line) | Fate | New test |
|---|---|---|
| helpers `DarkToken`, `DarkOracle`, `DarkCalendar`, `DarkEAS` (:18-77) | DELETE | `MockIssuerToken`, `MockPriceOracle`, `test/mocks/MockEAS.sol` |
| `testThreeWalletCrossAndResidualSameTx` (:195) | REWRITE | `test_crossAndResidualIntoParityPoolSameTx` |
| `testSellResidual` (:220) | REWRITE | `test_quoteSellerResidualRouted` |
| `testLimitExclusion` (:231) | REWRITE | `test_limitExclusionBothSides` |
| `testForfeit` (:244) | REWRITE | `test_unrevealedForfeitToTreasuryNonZero` (to the treasury, not revealers) |
| `testExternalSwapSettleReverts` (:256) | DELETE | DarkCross no longer gates pool swaps. |
| `testWeekendTwap` (:267) | DELETE | No TWAP. |
| `testStaleTwap` (:277) | DELETE | Replaced by `test_settleRevertsOracleStale`. |
| `testTwapMissingHistoryReverts` (:286) | DELETE | No TWAP. |
| `testDroppedUnderfundedNoForfeit` (:293) | REWRITE | `test_revealRejectedReasonsNoForfeit`, covering reasons 1-4 |
| `testCommitRevealPhaseAndReplay` (:306) | REWRITE | `test_commitRevealPhasesAndErrors` and `test_commitHashBindsChainAndContract` |
| `testWithdrawAvailableOnly` (:320) | REWRITE | `test_withdrawInsufficientEscrow` |
| `testFuzzEscrowProRata` (:330) | REWRITE | `testFuzz_cumulativeFloorAllocationConserves` |
| `testGateRejectsUnattested` (:349) | REWRITE | `test_commitDeniedReturnsFalseNoState`. EAS reason cases move to `EASEligibility.t.sol`. |
| `testLiquidityGateRejectsWrongRecipientExpiredAndRevoked` (:386) | DELETE | No liquidity gate. Reasons 4/5/6 go to `EASEligibility.t.sol::test_reasons`. |
| `testTwapObservesRealSwapsAndRejectsEvictedHistory` (:427) | DELETE | No TWAP. |
| `testFuzzRoutedEscrow` (:449) | REWRITE | `testFuzz_escrowConservation` |

`contracts/test/GroundTruth.t.sol`, `testGroundTruth` (:17): **unaffected**. It is a standalone Base-mainnet fork probe
with no `src/` imports. It stays excluded from CI with `--no-match-test GroundTruth`. It is informational, since live
B20 is out of scope.

### 4.2 New test support (contracts/test/)

- `contracts/test/mocks/MockEAS.sol`: settable `Attestation`s.
- `contracts/test/mocks/MockAttestationIndexer.sol`.
- `contracts/test/utils/Fixture.sol`: an abstract base that deploys PM, routers, registry, calendar, eligibility,
  oracle, tokens, adapters, ParityHook via `deployCodeTo` at `…20C8`, and DarkCross. It is parameterised by
  `bool mcbIsCurrency0`, forced by `deployCodeTo` token addresses (`0x1000…`/`0x2000…` swapped).
- `contracts/test/utils/SwapRouterMulti.sol`: a test router that performs N swaps in one unlock, for S3(e).

### 4.3 New tests required

`CanonicalShares.t.sol`:
- `test_section19Vectors`
- `testFuzz_downLeUp`
- `testFuzz_roundTripNeverGainsShares`
- `testFuzz_feeOnGrossCeil`
- `testFuzz_grossForNetInverse`
- `testFuzz_skewPipsCeilAndCap`
- `testFuzz_poolPriceX18MatchesReference` (512-bit reference in test)
- `testFuzz_deviationBpsCeil`
- `test_totalFeeCappedAt2500`

`ParityHook.t.sol`. There are two concrete suites, `ParityHook_McbC0Test` and `ParityHook_MaaplxC0Test`, over an
abstract base, so every test below runs in **both orderings**:
- Initialisation: `test_beforeInitializeDynamicFeeRequired`, `test_beforeInitializeUnsupportedPool_differentUnderlying`,
  `test_beforeInitializeUnsupportedPool_inactive`, `test_beforeInitializeRejectsOffParityPrice`,
  `test_beforeInitializeRejectsTickSpacing`, `test_poolRegisteredEvent`, `test_callbacksOnlyManager`.
- Hook permissions: `test_hookFlags0x20C8`.
- Keeper and fees: `test_setKeeperOnlyOwner`, `test_depositWithdrawKeeperOnlyAndEvents`,
  `test_withdrawCannotTouchFees`, `test_sweepFeesReturnsAndEmits`, `test_inventorySharesView`.
- Swaps and fills: `test_exactInBothDirections`, `test_exactOutBothDirections`, `test_sixEighteenDecimalExactInOut`,
  `test_quoteMatchesExecution` (fuzz across modes and sizes), `test_eventsOrderFill`.
- Fall-through: `test_insufficientInventoryFallsThroughReason1`, `testFuzz_dustFallsThroughReason2`,
  `test_fallThroughChargesOverrideFee`, `test_fallThroughEventDeltas`, `test_pegGuardRevertsInAfterSwap`,
  `test_pegGuardAllowsCorrectiveSwap`.
- Fees: `test_feeBreakdownPipsFormula`, `test_closedFeeAdds1000`, `test_feeOverrideCappedAtMax`.
- Peg status: `test_checkPegEmitsOnlyOnChange`, `test_pegStatusBothOrderings`.
- Ratios and health: `test_multiplierRepricesQuote`, `test_beforeSwapRevertsAdapterUnhealthy`,
  `test_registryPauseBlocksSwaps`, `test_multiplierJumpArbBoundedAndStoppedByPause`.
- Eligibility and hookData: `test_demoModeOffBlocksIneligibleSwap`, `test_untrustedSenderClaimIgnored`,
  `test_invalidHookDataReverts`, `test_trustedRouterClaimHonoured`, `test_publicRouterCannotLaunderSwapper` (or the
  `_KNOWN` variant; S9).
- Callbacks and transient state: `test_unlockCallbackRejectsNonManager`, `test_depositInsideForeignUnlockReverts`,
  `test_transientStateClearedBetweenSwapsInOneUnlock`.
- Donation: `test_donatedClaimsCountAsInventory`, `testFuzz_donationCannotReduceFeeProfitably`.
- Fuzz: `testFuzz_exactInRoundsForHook`, `testFuzz_exactOutRoundsForHook`, `testFuzz_fillDeltasExact`.

`contracts/test/invariant/ParityHookInvariant.t.sol`, with handler `ParityHandler`. Actions: swap exact-in/out in
either direction through PoolSwapTest, deposit, withdraw, sweep, LP add/remove, warp across the open/closed boundary.
It runs under both orderings.
- `invariant_inventorySharesNonDecreasing`: the ghost value `Σ_i inventory_i·spt_i/10^dec_i`, compared as exact
  rationals by cross-multiplying, with ratios fixed, is non-decreasing net of `deposits − withdrawals`.
- `invariant_noExtractionBeyondFee`: for each actor, share-valued wealth after fill-only actions is at most the
  starting wealth minus the Σ fees charged. Equivalently, no cycle yields a share-denominated gain.
- `invariant_poolManagerDeltasSettled`: `TransientStateLibrary.getNonzeroDeltaCount(manager) == 0` after every call,
  and no handler call has reverted `CurrencyNotSettled`.
- `invariant_claimsEqualInventoryPlusFees`: `manager.balanceOf(hook, id) == inventory(c) + feesAccrued(c)` for both
  currencies, and `token.balanceOf(manager) ≥ Σ claims + LP reserves` (ghost).
- `invariant_pegWithinBandAfterAnySuccessfulFallThrough`.

`contracts/test/fuzz/ParityDecimals.t.sol`:
- `testFuzz_bothOrderingsAndDecimals(uint8 decA, uint8 decB, uint256 sptA, uint256 sptB, bool aIsC0, int256 amt, bool exactIn)`,
  with `dec ∈ {6, 18}` (plus a 0-18 sweep in a second run), bounded `spt`, and addresses forced by `deployCodeTo`. It
  asserts rounding in the hook's favour, exact deltas and quote==execution.

`DarkCrossHook.t.sol` (rewritten):
- Crossing and residuals: `test_crossAndResidualIntoParityPoolSameTx`, `test_quoteSellerResidualRouted`,
  `test_residualSkippedOnPegGuard`, `test_residualSkippedOnMinOut`, `test_residualSkippedWhenTraderIneligible`,
  `test_limitExclusionBothSides`, `test_zeroSideNoDivision`.
- Commit/reveal: `test_revealRejectedReasonsNoForfeit`, `test_commitRevealPhasesAndErrors`,
  `test_commitHashBindsChainAndContract`, `test_commitDeniedReturnsFalseNoState`.
- Escrow and forfeits: `test_withdrawInsufficientEscrow`, `test_fundUnsupportedToken`,
  `test_unrevealedForfeitToTreasuryNonZero`, `test_commitBelowMinLockReverts`, `test_batchFullAt64`,
  `test_settleGasBoundedAt64Participants`.
- Settlement timing and oracle: `test_settleRevertsOracleStale`, `test_midMovedAfterRevealRespectsLimits`,
  `test_settlePhaseRules`, `test_batchResultStored`.
- Callbacks: `test_unlockCallbackOnlyDuringSettle`, `test_executeResidualOnlySelf`, `test_settleNonReentrant`.
- Fuzz: `testFuzz_cumulativeFloorAllocationConserves`, `testFuzz_escrowConservation`.

`IssuerRegistry.t.sol`:
- `test_addRemoveSetPausedEvents`, `test_addInvalidAdapter`, `test_alreadyRegistered`, `test_unknownIssuer`,
  `test_activeFalseOnRevertingAdapter`, `test_underlyingOf`.

`Adapters.t.sol`:
- `test_staticAdapter_interface`, `test_staticAdapter_zeroRatioReverts`, `test_staticAdapter_eventsAndHealth`,
  `test_multiplierAdapter_readsMultiplier`, `test_multiplierAdapter_pausedTokenUnhealthy`,
  `test_multiplierAdapter_outOfBoundsRatioUnhealthy`.

`NyseCalendar.t.sol`:
- `test_calendarKnownDates`, `test_dstBoundary`, `test_section10Timestamps` (1790692200 open; Sat 2026-09-26 closed;
  `nextTransition = 1790602200`), `test_setEarlyCloseEventsAndErrors`, `test_nextTransitionErrorSelector`.

`EASEligibility.t.sol`:
- `test_reasons` (0-7, with each first-failure ordering), `test_indexerLookupWhenUidZero`, `test_nullEasReturnsNoAttestation`,
  `test_setDemoModeOnlyOwner`, `test_setDemoModeEmits`, `test_demoModeOffRejectsUS`,
  `test_enforceEmitsCallerAsMsgSender`, `testFuzz_resolveSwapper`, `test_setTrustedRouterEmits`.

`MockPriceOracle.t.sol`:
- `test_setMidOnlyPusher`, `test_zeroMidReverts`, `test_inverseMidFloor`, `test_noPrice`.

`MockIssuerToken.t.sol`:
- `test_pausedTransfersRevertTokenPaused`, `test_setMultiplierEventsAndZero`, `test_mintOnlyOwner`.

`DemoNarrative.t.sol`, **reproducing both INTERFACES.md §10 variants**, with every `wrapswap:demo` constant hardcoded
and asserted:
- `test_section10_anvil_mcbC0` / `test_section10_anvil_maaplxC0`: warp to `1790692200`, then Step 1 (460 pips,
  fee `46575000000000000`, out `101203425000000000000`) and Step 2 (cross, residual 447 pips). End state: demo
  400 / 601.203425, A escrow `60720161625000000000`, B escrow `49975000`, hook fees `51100875000000000`. `skewX18`
  sign flips with ordering.
- `test_section10_unichainSepolia_mcbC0` / `test_section10_unichainSepolia_maaplxC0`: warp to Sat `1790424000`, closed.
  1460 / 1447 pips. End state per §10: `60710036625000000000`, `162475875000000000`.

`Deploy.t.sol` (runs `Deploy.run()` against an in-process chain with `NETWORK=anvil`):
- `test_manifestSchemaFields`, `test_manifestParityFlags`, `test_manifestPoolKeyMatchesChain`,
  `test_manifestInitSqrtMatchesSection10`, `test_manifestDemoModeReadFromChain`, `test_trustedRoutersConfigured`,
  `test_crankIsPusher`.

---

## 5. Downstream impact summary (informational)

**Indexer / API**
- Legacy topics disappear:
  - `Converted`, `MidSelected`, `RoutedToLit` (`api/src/indexer/index.ts:9,43,53`);
  - `Minted`, `Redeemed`, `BackingSnapshot`;
  - the old `Committed(id, trader, hash)`, `Crossed` and `BatchSettled` signatures.
- The indexer should consume the §2 table from `@wrapswap/types` instead.
- **Fill vs PoolManager `Swap` event.** On an inventory fill the PoolManager emits `Swap` with amount0 = amount1 = 0
  (because `amountToSwap` is 0) and `fee = totalPips`. Fill volume must come from `InventoryFill`, never from `Swap`.
  On fall-through, `Swap` and `FallThrough` carry the same deltas.
- **Revert decoding.** A hook revert arrives as
  `CustomRevert.WrappedError(hook, selector, reason, HookCallFailed)`. Through `V4Quoter` it is additionally wrapped
  in `UnexpectedRevertBytes(bytes)`. `/route` must unwrap both layers to detect `PegGuardTripped`, `NotEligible` and
  `AdapterUnhealthy`. `ResidualSkipped.reason` holds the same nested bytes.
- **`/route` simulation.** It must pass hookData v1 naming `swapper`, and the quoter must be a trusted router (E2).
  Otherwise, with demoMode off, the simulated swapper is the quoter and every route becomes `BLOCKED-ELIGIBILITY`.
- `/quote` is `ParityHook.quote` verbatim. It reverts `AdapterUnhealthy`, `UnsupportedPool` or `ZeroAmount`; map
  those to 4xx or 503 (E9).
- `deployments/${NETWORK}.json` replaces `local.json`. The ParityHook address changes on every code change because of
  mining.

**Crank**
- Oracle push `mid = floor(sptBase·1e18/sptQuote)`, i.e. mcbAAPL base, from the two adapters. Settle look-back.
- `checkPeg` on divergence. `settle` may now revert `OracleStale` or `BatchNotSettleable`, which should be treated as
  retry.
- It must be the pusher (Deploy sets `setPusher(index 4)`).
- On anvil, batches only advance when blocks are mined. The demo script (not the crank, which never warps) must
  `anvil_mine`.

**Web Convert flow**
- Remove vault mint/redeem (`web/src/main.tsx:381-398`) and any uAAPL balance display.
- **Anvil path** (no Permit2 or Universal Router): `ERC20.approve(swapRouter, amount)`, then `PoolSwapTest.swap(key,
  {zeroForOne, amountSpecified: ±amt, sqrtPriceLimitX96: MIN+1/MAX−1}, {false,false}, encodeParityHookData({swapper:
  user, attestationUid}))`. The current code passes `"0x"` at `web/src/main.tsx:417`, which makes the router the
  swapper.
- **Unichain Sepolia path:** `ERC20.approve(PERMIT2, max)` once, then `Permit2.approve(token, UR, amt, expiry)` (or a
  signed `PERMIT2_PERMIT` command), then UR `execute(V4_SWAP: SWAP_EXACT_IN_SINGLE|SWAP_EXACT_OUT_SINGLE with hookData
  v1, SETTLE_ALL, TAKE_ALL)`, with min-out/max-in from `/route`.
- The quote source is `/route`, which wraps `/quote`. Exact-out is now supported.
- Route badge states: `PARITY` | `FALL-THROUGH` | `DARK` | `BLOCKED-PEG` | `BLOCKED-ELIGIBILITY`, plus a
  "closed market +10 bps" chip from `FeeBreakdown.closedPips`.
- The dark flow uses the issuer pair: `fund(token, amt)`, `commitHashOf`, `commit(hash, lockToken, lock, uid)` (which
  returns bool), `reveal`. There is no USDC anywhere.

**Seeding (integration's `SeedDemo.s.sol`)**
- Mint the §10 balances (index 0 owns the mocks).
- Keeper deposits 8,000,000,000 raw mcbAAPL and 12,150e18 mAAPLx.
- LP through `modifyLiquidityRouter` at ticks chosen by the realised ordering (`[276320, 276570]` or
  `[−276570, −276320]`), with L computed from the max amounts.
- A and B fund escrow before committing.
- The anvil warp to `1790692200` happens before Step 1.
- `Seed.s.sol`, `scripts/seed.sh` and the `Makefile` `fork` target (Base fork, port 8545, chainId 8453) are legacy.
  Anvil must now be plain chainId 31337 on `ANVIL_PORT`.

---

## 6. Contracts task list (ordered)

Sizes: S ≈ <½ day, M ≈ ½–1½ days, L ≈ 2+ days. Each task ends with `forge build` green. Tests land with their task.

| # | Task | Files (file:line) | Size |
|---|---|---|---|
| T1 | Add the `CanonicalShares` library, including the exact `poolPriceX18` and `CanonicalShares.t.sol` | NEW `contracts/src/libraries/CanonicalShares.sol` | S |
| T2 | Delete `CanonicalStock`. Grep gate: no `vault`/`uAAPL` left in src/script. | `contracts/src/CanonicalStock.sol:1-112` | S |
| T3 | Mocks: `MockIssuerToken`, which absorbs `MockB20`; `MockPriceOracle`; delete `MockOracle`. Tests. | `contracts/src/mocks/MockIssuerToken.sol:7-28`, `contracts/src/mocks/MockB20.sol:1-31`, `contracts/src/mocks/MockOracle.sol:1-29`, NEW `contracts/src/mocks/MockPriceOracle.sol` | S |
| T4 | Adapters: `StaticAdapter` on `IWrapperAdapter`; `B20Adapter` becomes `B20MultiplierAdapter`; NEW `XStocksMultiplierAdapter` and `MultiplierAdapterBase`; delete `IIssuerAdapter` and `MockAdapter`. `Adapters.t.sol`. | `contracts/src/adapters/StaticAdapter.sol:6-31`, `contracts/src/adapters/B20Adapter.sol:5-27`, `contracts/src/adapters/IIssuerAdapter.sol:1-9` | S |
| T5 | `IssuerRegistry` on `IIssuerRegistry` (`underlyingOf`, `setPaused(token,bool)`, `remove(token)`, errors, indexed events, try/catch `active`). `IssuerRegistry.t.sol`. | `contracts/src/IssuerRegistry.sol:4-55` | S |
| T6 | `NyseCalendar` on `INyseCalendar` (event/errors, `setEarlyClose` clear). `NyseCalendar.t.sol` (moves `ParityVault.t.sol:292-313`). | `contracts/src/NyseCalendar.sol:6,9,39-42,64` | S |
| T7 | NEW `EASEligibility` plus test mocks `MockEAS` and `MockAttestationIndexer`. `EASEligibility.t.sol`. | NEW `contracts/src/EASEligibility.sol`, `contracts/test/mocks/*`; the struct migrates from `contracts/src/DarkCrossHook.sol:29-43` | M |
| T8 | ParityHook rewrite (§1.1): constructor/state; keeper and inventory functions; `beforeInitialize` with D5; `_quote`/`quote`; `beforeSwap` (hookData, eligibility, health, fee, fill/fall-through, events, override); `afterSwap` peg guard and `FallThrough`; `pegStatus`/`checkPeg`; namespaced transient storage. Fixture plus `ParityHook.t.sol` in both orderings. | `contracts/src/ParityHook.sol:19-220` (whole file) | L |
| T9 | DarkCrossHook rewrite (§1.2): strip hook, TWAP and USDC; new order/escrow model; `commitHashOf`; `commit` via `enforce`; `reveal` validity; `settle` math, residual routing into `parityPoolKey` with hookData v1, forfeits to the treasury, `BatchResult`; `MIN_LOCK`. `DarkCrossHook.t.sol` rewrite. | `contracts/src/DarkCrossHook.sol:1-547` (whole file); `contracts/test/DarkCrossHook.t.sol:1-461` | L |
| T10 | Invariant and fuzz suites: `ParityHookInvariant.t.sol` and `ParityDecimals.t.sol` | NEW `contracts/test/invariant/*`, `contracts/test/fuzz/*` | M |
| T11 | Delete `ParityVault.t.sol` once T8's replacements pass | `contracts/test/ParityVault.t.sol:1-313` | S |
| T12 | `Deploy.s.sol` rewrite (§3): env externals, anvil v4 infra, order, mining, trusted routers, pusher, demoMode, direct initialize with exact sqrt, JSON writer, `manifest()` block resolver. `Deploy.t.sol`. | `contracts/script/Deploy.s.sol:1-209` (whole file) | M |
| T13 | `DemoNarrative.t.sol`: both §10 variants × both orderings | NEW `contracts/test/DemoNarrative.t.sol` | M |
| T14 | Record D1-D9 and the chosen resolutions of E1/E3/E11/E12/E16 in `decisions/contracts.md`. File the CRs listed in §7 to `interface-change-requests/contracts.md`. | `decisions/contracts.md`, `interface-change-requests/contracts.md` | S |

Dependencies: T1 → T8, T9. T3, T4 → T5 → T8. T6, T7 → T8. T8 → T9 → T10, T13. T12 needs T3-T9.

### File coverage (every file under contracts/src, contracts/script, contracts/test)

| File | Status | Task / reason |
|---|---|---|
| `contracts/src/ParityHook.sol` | affected | T8 |
| `contracts/src/DarkCrossHook.sol` | affected | T9 |
| `contracts/src/CanonicalStock.sol` | affected (delete) | T2 |
| `contracts/src/IssuerRegistry.sol` | affected | T5 |
| `contracts/src/NyseCalendar.sol` | affected | T6 |
| `contracts/src/adapters/B20Adapter.sol` | affected | T4 |
| `contracts/src/adapters/StaticAdapter.sol` | affected | T4 |
| `contracts/src/adapters/IIssuerAdapter.sol` | affected (delete) | T4 |
| `contracts/src/mocks/MockIssuerToken.sol` | affected | T3 |
| `contracts/src/mocks/MockB20.sol` | affected (delete) | T3 |
| `contracts/src/mocks/MockOracle.sol` | affected (delete) | T3 |
| `contracts/src/interfaces/IWrapperAdapter.sol` | unaffected | Frozen; verified identical to §1.1. |
| `contracts/src/interfaces/IIssuerRegistry.sol` | unaffected | Frozen; verified identical to §1.2. |
| `contracts/src/interfaces/INyseCalendar.sol` | unaffected | Frozen; verified identical to §1.3. |
| `contracts/src/interfaces/IEligibility.sol` | unaffected | Frozen; verified identical to §1.4. |
| `contracts/src/interfaces/IPriceOracle.sol` | unaffected | Frozen; verified identical to §1.5. |
| `contracts/src/interfaces/IMockIssuerToken.sol` | unaffected | Frozen; verified identical to §1.6. |
| `contracts/src/interfaces/IParityHook.sol` | unaffected | Frozen; verified identical to §1.7. |
| `contracts/src/interfaces/IDarkCrossHook.sol` | unaffected | Frozen; verified identical to §1.8. |
| `contracts/script/Deploy.s.sol` | affected | T12 |
| `contracts/script/Addresses.sol` | affected (orphaned) | T12 stops importing it. It compiles standalone but its 8453 data is out of scope. It is in no lane's §8 write set, so deletion needs an owner (E5). |
| `contracts/script/Seed.s.sol` | affected (integration-owned) | Legacy vault/USDC/Base-fork flow (§11). Integration replaces it with `SeedDemo.s.sol`. It compiles standalone because it uses local interfaces, so there is no contracts-lane action. |
| `contracts/test/ParityVault.t.sol` | affected (delete after port) | T8, T11 |
| `contracts/test/DarkCrossHook.t.sol` | affected (rewrite) | T9 |
| `contracts/test/GroundTruth.t.sol` | unaffected | Standalone Base-mainnet fork probe with no `src/` imports, excluded from offline CI. |

---

## 7. INTERFACES errata (proposed fixes only; `INTERFACES.md` not edited)

- **E1. Trusted routers make the claimed swapper unauthenticated (High; §3, §1.4 `resolveSwapper`).**
  - Problem: `PoolSwapTest` and the Universal Router are trusted, but anyone can call them with arbitrary hookData.
    With demoMode off, any user can name an attested non-US address and bypass the gate.
  - Fix, either of:
    - (a) Honour the claimed swapper only for routers that authenticate it: `darkCrossHook` (the trader committed with
      `enforce`), and a thin `WrapSwapRouter` that sets `swapper = msg.sender`. Or honour it for public routers only
      when `claimedSwapper == tx.origin`.
    - (b) Add `bool authenticated` to `setTrustedRouter`.
  - Until resolved, the contracts lane implements §3 literally and ships `test_publicRouterClaimIsUnauthenticated_KNOWN`.
- **E2. `V4Quoter` is missing from the trusted routers (§3 "Trusted routers at deploy", §5 `/route` step 4).**
  - Problem: the simulation's `sender` is the quoter, so the named swapper is ignored and every route with demoMode off
    reports `BLOCKED-ELIGIBILITY`.
  - Fix: add `quoter` to the deploy-time trusted list. This is safe because V4Quoter always reverts its simulated swap.
- **E3. The registry pause has no effect on swaps (§1.7 `beforeSwap`).**
  - Problem: only adapter health is checked, so `IIssuerRegistry.setPaused`/`IssuerPaused` would only affect
    `beforeInitialize`.
  - Fix: `beforeSwap` requires `registry.active(token)` for both tokens, reverting `AdapterUnhealthy(token)`. This is
    adopted as D4.
- **E4. `startBlock` example contradicts its rule (§4).**
  - Problem: the rule says `startBlock` is the registry deploy block. The anvil example has `"startBlock": "1"` but
    `blocks.registry = "5"`.
  - Fix: change the example to `"5"`, or change the rule to "first block of the deployment".
- **E5. The deployment JSON cannot be fully produced by a single `forge script` run, and ownership has gaps (§4, §8).**
  - Problem: simulated `block.number` is constant, so `blocks`, `startBlock` and `poolInitialized` are wrong.
    `deployCommit` needs `ffi` (off in `foundry.toml`). `foundry.toml` and `contracts/script/Addresses.sol` are in no
    lane's write set.
  - Fix: allow a two-phase Deploy (`run()` then `manifest()`, D9); specify `DEPLOY_COMMIT`/`DEPLOYED_AT` env; assign
    `foundry.toml` (read access to `./broadcast`) and `Addresses.sol` to the contracts lane.
- **E6. The §10 Unichain-Sepolia variant is reproducible only under unstated preconditions.**
  - The numbers are arithmetically correct. I recomputed all of them, and the contracts produce them.
  - They hold only (a) while `isOpen` is false: now through Mon 2026-09-28 13:30 UTC, about 49 h from today, or any
    later closed window, which gives identical numbers because the fee depends only on `open`; (b) on a fresh
    deployment with no third-party swaps, deposits or commits before or between the steps, since the pool is
    permissionless under demoMode; and (c) with scripted, not human, dark steps, because Unichain Sepolia has 2 s blocks.
    COMMIT is 24 s, **REVEAL is 12 s**, and the whole batch is 40 s.
  - Also: the machine-readable `skewX18` values assume mcbAAPL is currency0, but the realised Sepolia ordering is
    unknown until deploy, and the JSON has no ordering flag.
  - Fix: state (a)-(c) in §10; add `"mcbAAPLIsCurrency0": true` to `skewX18` (or give both signs); consider longer
    batches for Sepolia as a constructor param (it is a constant in the interface today).
- **E7. Manifest nits (§4).**
  - (a) The example `parityHook` address `0x1f5a0e3B5D6c1D1d7a4D2d0a3C1b9E8F7a6B20C8` is not valid EIP-55. The
    correct casing is `0x1f5A0e3B5d6C1D1d7A4d2d0a3c1B9E8f7A6b20C8`.
  - (b) `darkCrossHook.flags = "0x0000"` is a declared value and does not equal `address & 0x3fff`. Say so
    explicitly, so validators don't apply the parityHook rule to it.
- **E8. Adapter `Health.updatedAt` and `RatioUpdated` are undefined for multiplier adapters (§1.1).**
  - Problem: the mock token exposes no multiplier timestamp, and a view adapter can't emit.
  - Fix: specify `updatedAt = block.timestamp` for multiplier adapters (freshness is inherent); `RatioUpdated` is
    static-adapter only, and multiplier changes surface as `MultiplierUpdated`. Also specify when `InvalidRatio` is
    thrown: `sharesPerToken()` when the source is 0 or above 1e24; `ratio()` never reverts.
- **E9. `quote()` failure modes are unspecified (§1.7).**
  - Fix: `amountSpecified == 0` reverts `ZeroAmount`; an unsupported key reverts `UnsupportedPool`; an unhealthy or
    inactive token reverts `AdapterUnhealthy`. Map these in the §5 `/quote` error table.
- **E10. "To treasury" is ambiguous for cross fees and forfeits (§1.8 table, steps 4 and 6; §10 "Treasury: …").**
  - Fix: specify a credit to the treasury's escrow `available`, withdrawn with `withdraw` (D8). An in-`settle` ERC20
    transfer would be the alternative.
- **E11. There is no minimum lock, so commits are free griefing (§1.8).**
  - Problem: with `FORFEIT_BPS` using floor, a 1-wei commit forfeits 0, and 64 of them fill a batch.
  - Fix: add `MIN_LOCK` (e.g. 10,000 raw units), reverting `InvalidCommit`. Or make the forfeit
    `max(1, floor(...))`.
- **E12. `beforeInitialize` accepts any price and any tickSpacing (§1.7).**
  - Problem: this allows the init front-run in S10 and extra pools that share inventory.
  - Fix: add "initial price within `PEG_GUARD_BPS` of parity, else `PegGuardTripped`" and "`tickSpacing == 10`, else
    `UnsupportedPool`" (D5).
- **E13. `setEarlyClose` can't clear an early close (§1.3).** Fix: specify that `0` clears; otherwise require
  `34200 < s ≤ 57600`.
- **E14. hookData dirty version bits (§3).**
  - Problem: `abi.decode` of `uint8` with dirty high bits panics rather than reverting `InvalidHookData`.
  - Fix: specify "any decode failure ⇒ `InvalidHookData()`". The implementation reads words manually.
- **E15. `FallThrough.feePips` excludes the protocol fee (§1.7).** Fix: document it as the LP fee only; the effective
  fee can be higher if the PoolManager protocol fee is non-zero on Unichain Sepolia.
- **E16. The settle-time mid is chosen by whoever settles (§1.8).** Fix, optional: `settle` reverts (a new error, or
  reuse `OracleStale`) if `|mid − parity(adapters)| > PEG_GUARD_BPS`. This bounds oracle abuse to the peg band.
- **E17. Revert-shape clarity (§5 `/route` step 4).** Fix: say that `PegGuardTripped` arrives wrapped, as
  `UnexpectedRevertBytes(WrappedError(hook, afterSwap.selector, PegGuardTripped(...), HookCallFailed))`, and that
  "insufficient liquidity" is `NotEnoughLiquidity(poolId)` from V4Quoter or the peg-guard trip on an empty range.
- **E18. §1.7 says "afterSwap (fall-through only)".** v4 invokes `afterSwap` on every swap, so the text should read
  "afterSwap returns immediately after an inventory fill".

§10 numbers the contracts **cannot** produce: none, provided E6's preconditions hold. Every value was independently
recomputed:

- sqrtPriceX96 for both orderings;
- ticks 276448 / −276449 and the LP ticks;
- shares 101.25e18;
- skew −0.2 / −0.19 / −0.189 and pips 260 / 247;
- fees 460 / 447 / 1460 / 1447 and their amounts;
- crossing 50,000,000 / 50.625e18 and cross fees;
- `minOut` 10.1e18;
- end balances and treasury/hook fees;
- `isOpen(1790692200)=true` and `nextTransition(Sat)=1790602200` under the current `NyseCalendar` logic.
