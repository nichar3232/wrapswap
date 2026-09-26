# Contracts lane decisions

Implementation choices for the reframe that are not already in `DECISIONS.md`. Scoping decisions D1-D9 come from
`SCOPING.md` and are restated here as adopted. Errata references (E*) are to `SCOPING.md` §7.

## Adopted from SCOPING.md

- 2026-09-26 **D1**: `CanonicalStock.sol` is deleted. Share accounting lives only in `contracts/src/libraries/CanonicalShares.sol`, and no ERC-20 is inherited in `src/` outside `mocks/`.
- 2026-09-26 **D2**: a single `MockIssuerToken` implements `IMockIssuerToken`. `MockB20.sol` and `MockOracle.sol` are deleted, and `MockPriceOracle` replaces the latter.
- 2026-09-26 **D3**: the adapters are `StaticAdapter`, `B20MultiplierAdapter` and `XStocksMultiplierAdapter`, with shared code in `MultiplierAdapterBase`. `IIssuerAdapter.sol` and `B20Adapter.sol` are deleted.
- 2026-09-26 **D4 / E3**: `ParityHook.beforeSwap` and `quote` require `registry.active(token)` for both tokens, and revert `AdapterUnhealthy(token)` otherwise. A registry pause therefore stops swaps.
- 2026-09-26 **D5 / E12**: `beforeInitialize` rejects `tickSpacing != 10` with `UnsupportedPool`. It also rejects an initial price more than `PEG_GUARD_BPS` off parity with `PegGuardTripped(poolId, deviationBps)`, which closes the Sepolia init front-run.
- 2026-09-26 **D6**: `DarkCrossHook` has no owner. The parity key, tokens, treasury and oracle are fixed in the constructor, which reverts `InvalidConfig()` if hooks != parityHook, the currencies don't match, the fee is not DYNAMIC_FEE_FLAG, base == quote, or any address is zero.
- 2026-09-26 **D7 (amended)**: `Deploy.s.sol` no longer imports `Addresses.sol`. The lane brief says "never hardcoded", so unichain-sepolia externals have **no** defaults. `POOL_MANAGER`, `V4_QUOTER`, `EAS`, `EAS_SCHEMA_UID`, `EAS_TRUSTED_ATTESTER`, `DEMO_MODE` and `DEMO_MNEMONIC` are all required on chain 1301. `Addresses.sol` stays in the tree because no lane owns it (E5), and nothing imports it.
- 2026-09-26 **D8 / E10**: DarkCross cross fees and forfeits are credited to the treasury's escrow `available` balance, which the treasury withdraws with `withdraw`. Deploy sets the treasury to the deployer (index 0).
- 2026-09-26 **D9 / E5**: deployment runs in two phases. `run()` broadcasts and writes a schema-valid manifest. That manifest has `startBlock` = the pre-deploy head, which is a safe lower bound, empty `blocks`, and the simulated `batchOrigin`. `manifest()` is read-only: it rebuilds the manifest from chain state, finds each created contract's first block with code by bisecting `eth_getCode`, and finds `poolInitialized` by bisecting `extsload(slot0)`. It sets `startBlock = blocks.registry` and reads `batchOrigin` from the contract.

## Errata resolutions

- 2026-09-26 **E1** (unauthenticated claimed swapper through public trusted routers) is implemented exactly as §3 specifies. `test_publicRouterClaimIsUnauthenticated_KNOWN` pins the gap, and CR-1 asks for a fix.
- 2026-09-26 **E2**: Deploy trusts `quoter` alongside `swapRouter`, `darkCrossHook` and, when set, `UNIVERSAL_ROUTER`.
- 2026-09-26 **E8**: multiplier adapters report `stale = false` and `updatedAt = block.timestamp`. `sharesPerToken()` reverts `InvalidRatio` outside (0, 1e24], while `ratio()` and `health()` never revert. A token whose `multiplier()` reverts yields `(0, false)`, and a token without `transfersPaused()` is treated as paused. `RatioUpdated` is emitted only by `StaticAdapter`.
- 2026-09-26 **E9**: `quote()` reverts `ZeroAmount` for 0, `UnsupportedPool` for a foreign key (wrong hook, unregistered token, or differing or zero underlying) and `AdapterUnhealthy` for an inactive token.
- 2026-09-26 **E11**: `DarkCrossHook.MIN_LOCK = 10_000` raw units, a public implementation constant. A smaller lock or a zero hash reverts `InvalidCommit`, so every unrevealed forfeit is at least 10 raw units. The griefing cost is still small in 18-decimal terms. `MAX_PARTICIPANTS` bounds settle gas, which measured about 10.2M for 64 participants with residuals (`test_settleGasBoundedAt64Participants`).
- 2026-09-26 **E13**: `setEarlyClose(day, 0)` clears an early close. Any other value must satisfy `34200 < s <= 57600`, else `InvalidEarlyClose(s)`.
- 2026-09-26 **E14**: hookData words are read manually. The data is rejected with `InvalidHookData()` if the version word != 1, the address word has dirty high bits, or the length is anything other than 0 or 96.
- 2026-09-26 **E16** (reject a settle-time mid that is off adapter parity) is **not adopted**. It needs an error the frozen interface lacks, and the crank pushes parity anyway. Trader limits bound the exposure. CR-2 raises it.
- 2026-09-26 **E18**: `afterSwap` returns immediately after an inventory fill, and applies the peg guard and emits `FallThrough` only on fall-through.

## ParityHook

- 2026-09-26 Check order in `beforeSwap` follows INTERFACES §1.7, not SCOPING §1.1.1: pool validation (`UnsupportedPool`), then hookData and eligibility (`InvalidHookData`, `NotEligible`), then adapter/registry health (`AdapterUnhealthy`). The frozen interface is normative, and either order changes no state.
- 2026-09-26 Transient swap context is one packed word at `keccak256("wrapswap.parity.swap")`. `afterSwap` always clears it, so a fill flag can't leak into the next swap of the same unlock (S3e). The callback guard sits at `keccak256("wrapswap.parity.callback")` and only `depositInventory`, `withdrawInventory` and `sweepFees` set it. Without it, `unlockCallback` reverts `NotPoolManager()` even when called by the PoolManager.
- 2026-09-26 Fall-through reason is 2 (DUST) when the quote's `amountIn` or `amountOut` is 0, otherwise 1 (INSUFFICIENT_INVENTORY).
- 2026-09-26 Deposits reject fee-on-transfer tokens with the implementation error `TransferAmountMismatch(expected, received)`, checked through `PoolManager.settle()`'s return value.
- 2026-09-26 `feeBreakdown` and `pegStatus` revert `UnsupportedPool` for keys this hook can't price. `inventoryShares` reverts `IIssuerRegistry.UnknownIssuer` for unregistered currencies.
- 2026-09-26 Ownership uses OZ `Ownable`: the constructor takes the owner, and the owner is also made a keeper with `KeeperSet` emitted.

## DarkCrossHook

- 2026-09-26 `Order.residualIn` records the planned residual, `amountIn - crossedIn`, for every valid order, including those whose limit excluded them from the cross. `BatchResult.residualBaseIn` and `residualQuoteIn` sum the input actually consumed by **successful** routes. Skipped residuals stay in escrow and are unlocked to `available`.
- 2026-09-26 The residual `minOut` (§1.8 step 5) is enforced inside `executeResidual` with the implementation error `ResidualBelowMinOut(amountOut, minOut)`. The outer `try` turns that into `ResidualSkipped(reason)`.
- 2026-09-26 `settle` opens a PoolManager unlock only when at least one valid order has `routeResidual && residualIn > 0`.
- 2026-09-26 `Crossed` is emitted only for orders with a non-zero `crossedIn` or gross. `Forfeited` is emitted for every unrevealed commit, and its amount is always greater than 0 because of `MIN_LOCK`.
- 2026-09-26 An oracle `updatedAt` later than `block.timestamp` (clock skew) is treated as fresh, not as an underflow.
- 2026-09-26 Reentrancy is blocked by a transient-storage lock on `fund`, `withdraw`, `commit`, `reveal` and `settle`, which reverts with the implementation error `Reentrancy()`. `executeResidual` and `unlockCallback` are guarded by a transient "settling" flag and the self-only / PoolManager-only checks.
- 2026-09-26 `fund` checks the received balance delta and reverts `TransferAmountMismatch` on fee-on-transfer.

## EASEligibility

- 2026-09-26 Undecodable Verified Country data maps to reason 2 (WRONG_SCHEMA). Decoding happens in `try this.decodeCountry(data)`, an external pure helper. The country comparison is case-sensitive (`"us"` is not restricted).
- 2026-09-26 A missing EAS or indexer (`code.length == 0`, as on anvil) or any revert on the read path maps to reason 1 (NO_ATTESTATION). It never reverts.
- 2026-09-26 `enforce` emits `EligibilityDenied` with the uid actually evaluated, which is the indexer's answer when the argument is 0.
- 2026-09-26 Ownership is custom (`NotOwner(caller)`), with `transferOwnership` and an `OwnershipTransferred` event. The frozen interface only requires `owner()`.

## Registry, adapters, calendar

- 2026-09-26 `IssuerRegistry.add` also rejects adapters whose `tokenDecimals() > 18` with `InvalidAdapter`, because `CanonicalShares.poolPriceX18` is exact only for dec <= 18. Adapters without code, or whose `token()` reverts, are also rejected with `InvalidAdapter`.
- 2026-09-26 `NyseCalendar` adds the 13:00 ET early closes 2026-11-27, 2026-12-24 and 2027-11-26, emits `HolidaySet` and `EarlyCloseSet` for its constructor defaults, and computes DST in closed form using Hinnant's civil-from-days. This replaces the year loop from 1970, and the worst-case `nextTransition` gas falls from about 43M to about 15M.

## Deploy script

- 2026-09-26 Network is derived from `block.chainid` (31337 anvil, 1301 unichain-sepolia). `NETWORK`, if set, must agree. Any other chain reverts.
- 2026-09-26 `DEPLOY_COMMIT` is required (40 lowercase hex). `DEPLOYED_AT` defaults to `block.timestamp` formatted ISO-8601 UTC. `DEMO_MODE` defaults to true only on anvil. `DEMO_MNEMONIC` defaults to the anvil mnemonic only on 31337. `DEPLOYER_PK` overrides index 0.
- 2026-09-26 ParityHook is deployed by an explicit call to the CREATE2 deployer proxy with a salt from the pinned periphery `HookMiner`. The script asserts the proxy has code and that `address & 0x3fff == 0x20c8`. It also asserts that the initial sqrtPriceX96 equals the §10 constant for the realised ordering.
- 2026-09-26 On anvil, the PoolManager is created with the deployer as owner and no protocol fee.

## Tests

- 2026-09-26 `GroundTruth.t.sol` (a Base-mainnet fork probe) and `ParityVault.t.sol` are deleted. The done condition is a plain `forge test` with no skips, which can't depend on a mainnet RPC, and live B20 is out of scope for the `Network` enum.
- 2026-09-26 Invariant parameters (runs 256, depth 50, fail-on-revert true) are set with contract-level `forge-config` comments, because `foundry.toml` isn't in the contracts write set.
- 2026-09-26 Tests force both currency orderings by placing the mock tokens with `deployCodeTo` at `0x1000…` and `0x2000…`. ParityHook is placed with `deployCodeTo` at `0x4444…20C8`.
- 2026-09-26 The gas snapshot is `contracts/gas-snapshot`, produced by `forge snapshot --match-path contracts/test/Gas.t.sol --snap contracts/gas-snapshot`, with one operation per test body.
