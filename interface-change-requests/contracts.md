# Interface change requests: contracts lane

## CR-1: Authenticate the claimed swapper on public trusted routers (SCOPING E1)

- **Problem.** §3 honours `hookData.swapper` whenever `sender` is a trusted router. `PoolSwapTest` and the Universal Router are permissionless, so with `demoMode` off anyone can name an attested non-US address and pass the ParityHook gate. `ParityHook.t.sol::test_publicRouterClaimIsUnauthenticated_KNOWN` demonstrates this.
- **Proposed change.** Either (a) `setTrustedRouter(address router, bool trusted, bool authenticated)`, where the claim is honoured only for routers that authenticate it (DarkCrossHook, whose traders passed `enforce` at commit, and a thin `WrapSwapRouter` that sets `swapper = msg.sender`), or (b) honour claims from public routers only when `claimedSwapper == tx.origin`.
- **Affected sections.** §1.4 (`IEligibility.resolveSwapper`, `setTrustedRouter`), §3, §5 `/route`.
- **Blocking.** No. The contracts implement §3 literally until this is resolved.

## CR-2: Bound the settle-time mid to adapter parity (SCOPING E16)

- **Problem.** `settle` uses whatever mid is current, and whoever settles picks the block. A pusher who has seen the reveals can move the mid to the edge of a limit.
- **Proposed change.** Add `error MidOffParity(uint256 midX18, uint256 parityX18)` to `IDarkCrossHook`, and have `settle` revert when `|mid − parity(adapters)| > 50 bps`.
- **Affected sections.** §1.8, §5 dark routes, §7 crank retry rules.
- **Blocking.** No. Not implemented, because the frozen interface has no suitable error.

## CR-3: Expose `MIN_LOCK` and the DarkCross implementation errors in `IDarkCrossHook` (SCOPING E11)

- **Problem.** Commits below `MIN_LOCK = 10_000` raw units revert `InvalidCommit`, but the constant isn't in the interface ABI, so the UI and API can't validate before sending.
- **Proposed change.** Add `MIN_LOCK()` to the interface. Also add the implementation errors: `ResidualBelowMinOut(uint256,uint256)`, `TransferAmountMismatch(uint256,uint256)`, `Reentrancy()` and `InvalidConfig()`. `@wrapswap/types` can then decode `ResidualSkipped.reason` when it is `ResidualBelowMinOut`.
- **Affected sections.** §1.8, §2 (`ResidualSkipped` decoding), §5.
- **Blocking.** No.

## CR-4: Two-phase deploy and its env contract (SCOPING E5)

- **Problem.** A single `forge script` run can't know real block numbers, because broadcasts are simulated at one block. That affects `blocks`, `startBlock` and `dark.batchOrigin`.
- **Proposed change.** Document the sequence below in §4. Also give the contracts lane ownership of `contracts/script/Addresses.sol` so it can be deleted; it is orphaned and unused.
  1. `forge script contracts/script/Deploy.s.sol --broadcast`
  2. `forge script contracts/script/Deploy.s.sol --sig 'manifest()'`

  Both phases take the same env: `DEPLOY_COMMIT` (required), `DEPLOYED_AT`, `DEMO_MNEMONIC`, `DEPLOYER_PK`, `DEMO_MODE`, `POOL_MANAGER`, `V4_QUOTER`, `EAS`, `EAS_INDEXER`, `EAS_SCHEMA_UID`, `EAS_TRUSTED_ATTESTER`, `POSITION_MANAGER`, `STATE_VIEW`, `PERMIT2`, `UNIVERSAL_ROUTER`, `DEPLOY_FROM_BLOCK`.

  Phase 1 already writes a schema-valid file with `startBlock` = the pre-deploy head. Consumers must run phase 2 before relying on `blocks` or `batchOrigin`.
- **Affected sections.** §4 field rules, §8 ownership map.
- **Blocking.** No.

## CR-5: Currency-ordering flag for §10 skew values on Sepolia (SCOPING E6)

- **Problem.** The `skewX18` constants in the `wrapswap:demo` JSON assume mcbAAPL is currency0. On anvil it happens to be (0x2279… < 0x8A79…), but the Sepolia ordering depends on deploy addresses.
- **Proposed change.** Add `"mcbAAPLIsCurrency0": true` next to `skewX18`, or give both signs. Also state the E6 preconditions: calendar closed, a fresh deployment with no third-party flow, and scripted dark steps.
- **Affected sections.** §10.
- **Blocking.** No. `DemoNarrative.t.sol` asserts both signs.

## CR-6: Documentation clarifications implemented as chosen

- **Problem.** The following points are unspecified or ambiguous in §1. The contracts implement the choices recorded in `decisions/contracts.md`.
  - §4 `startBlock` example "1" versus registry block "5" (E4). The implementation uses `startBlock = blocks.registry`.
  - E8: multiplier adapters report `updatedAt = block.timestamp`, `stale = false`, and `ratio()` never reverts.
  - E9: `quote()` failure modes.
  - E13: `setEarlyClose(day, 0)` clears.
  - E14: any hookData decode failure, including dirty address bits, reverts `InvalidHookData`.
  - E15: `FallThrough.feePips` is the LP fee only.
  - E17: nested revert shapes.
  - E18: `afterSwap` returns immediately after a fill.
- **Proposed change.** Fold these into §1.1, §1.3, §1.7, §3 and §4 at the next freeze.
- **Blocking.** No.
