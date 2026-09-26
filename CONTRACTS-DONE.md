# Contracts lane: done report

Branch `lane/contracts`. Solidity 0.8.26, via-IR, cancun. Pinned v4-core `46c6834`, v4-periphery `9969eec`, forge-std `ba4733c`.
Implementation choices are in `decisions/contracts.md`. Interface gaps are filed in `interface-change-requests/contracts.md`.

## Done conditions

| Condition | Status | Proof |
|---|---|---|
| `forge build && forge test` green, no skips | PASS: 219 passed, 0 failed, 0 skipped (22 suites) | `forge build && forge test` |
| Invariants at ≥256 runs, depth ≥50 | PASS: runs 256, depth 50 (12,800 calls), 0 reverts, fail-on-revert on, both orderings | `forge test --match-path contracts/test/invariant/ParityHookInvariant.t.sol -vv` |
| `forge coverage` ≥90% lines on both hooks | PASS: ParityHook 97.45% (191/196), DarkCrossHook 99.15% (232/234) | `forge coverage --ir-minimum --report summary` (via-IR needs `--ir-minimum`) |
| Deploy.s.sol on a fresh anvil writes `deployments/anvil.json` that validates against §4 | PASS: checked with `parseDeployment` from `packages/types` (schema plus cross-field rules) | see "Deploy on a fresh anvil" below |
| Both §10 variant tests pass | PASS: ANVIL and UNICHAIN-SEPOLIA × both orderings, with every `wrapswap:demo` constant asserted | `forge test --match-path contracts/test/DemoNarrative.t.sol` |
| Every SCOPING §2 item has a passing test | PASS: 41 named tests, 69 runs across both orderings, all passing (checklist below) | the `--match-test` command below |
| All work committed on `lane/contracts` | PASS | `git status` is clean |

### Deploy on a fresh anvil

```sh
anvil --port $ANVIL_PORT --chain-id 31337 &           # ANVIL_PORT=18503 in this lane
export DEPLOY_COMMIT=$(git rev-parse HEAD)
forge script contracts/script/Deploy.s.sol --rpc-url http://127.0.0.1:$ANVIL_PORT --broadcast
forge script contracts/script/Deploy.s.sol --sig 'manifest()' --rpc-url http://127.0.0.1:$ANVIL_PORT
tsx -e 'import {parseDeployment} from "./packages/types/src/deployment.ts"; import {readFileSync} from "node:fs";
        parseDeployment(JSON.parse(readFileSync("deployments/anvil.json","utf8"))); console.log("VALID")'
```

- **Automine anvil.** Every transaction lands in block 1, and `manifest()` resolves every block to 1, which matches the chain.
- **`--block-time 1` with `--slow`.** Output: `registry 10, calendar 11, eligibility 12, oracle 13, parityHook 20, darkCrossHook 21, poolInitialized 27`. `startBlock` is 10, and `batchOrigin` is 21, which equals the on-chain `batchOrigin()`.
- **Manifest contents.**
  - The ParityHook address satisfies `& 0x3fff == 0x20c8`.
  - `initSqrtPriceX96` is `79721800701433069633245772272326702`, because mcbAAPL sorts first on anvil.
  - `demoMode` is read back from chain.
  - The file contains no private keys.

### Gas snapshot (`contracts/gas-snapshot`)

Produced by `forge snapshot --match-path contracts/test/Gas.t.sol --snap contracts/gas-snapshot`. Each test body runs one operation, and each figure includes the router and test-call overhead.

| Operation | Gas |
|---|---|
| Parity fill (exact-in 100 mcbAAPL via PoolSwapTest) | 283,490 |
| Fall-through (1 mcbAAPL against concentrated liquidity, peg guard) | 289,366 |
| Dark commit | 183,008 |
| Dark reveal | 132,344 |
| Dark settle (§10 batch: two-sided cross plus one residual routed into the ParityHook pool) | 697,551 |
| Dark settle at 64 participants with residuals (bound test) | ~10.2M |

## SCOPING §2 security checklist

Run them all together:

```sh
forge test --match-test '^(testFuzz_downLeUp|testFuzz_roundTripNeverGainsShares|testFuzz_exactInRoundsForHook|testFuzz_exactOutRoundsForHook|testFuzz_dustFallsThroughReason2|test_donatedClaimsCountAsInventory|testFuzz_donationCannotReduceFeeProfitably|test_unlockCallbackRejectsNonManager|test_depositInsideForeignUnlockReverts|test_transientStateClearedBetweenSwapsInOneUnlock|test_unlockCallbackOnlyDuringSettle|test_executeResidualOnlySelf|test_settleNonReentrant|test_multiplierAdapter_pausedTokenUnhealthy|test_staticAdapter_zeroRatioReverts|test_multiplierAdapter_outOfBoundsRatioUnhealthy|test_beforeSwapRevertsAdapterUnhealthy|test_registryPauseBlocksSwaps|test_multiplierJumpArbBoundedAndStoppedByPause|testFuzz_fillDeltasExact|testFuzz_escrowConservation|test_commitBelowMinLockReverts|test_batchFullAt64|test_unrevealedForfeitToTreasuryNonZero|test_settleGasBoundedAt64Participants|test_settleRevertsOracleStale|test_midMovedAfterRevealRespectsLimits|test_setMidOnlyPusher|test_inverseMidFloor|test_setDemoModeOnlyOwner|test_setDemoModeEmits|test_demoModeOffRejectsUS|test_demoModeOffBlocksIneligibleSwap|test_manifestDemoModeReadFromChain|test_untrustedSenderClaimIgnored|test_invalidHookDataReverts|test_trustedRouterClaimHonoured|test_publicRouterClaimIsUnauthenticated_KNOWN|testFuzz_resolveSwapper|test_beforeInitializeRejectsOffParityPrice|test_enforceEmitsCallerAsMsgSender)\('
forge test --match-path contracts/test/invariant/ParityHookInvariant.t.sol
```

Result: 69 tests passed, 0 failed, 0 skipped, plus all 5 invariants passing under both orderings. Tests in `ParityHook.t.sol`, `DarkCrossHook.t.sol` and `ParityHookInvariant.t.sol` run in both currency orderings.

**S1. Rounding direction**
- [x] `CanonicalShares.t.sol::testFuzz_downLeUp`
- [x] `CanonicalShares.t.sol::testFuzz_roundTripNeverGainsShares`
- [x] `ParityHook.t.sol::testFuzz_exactInRoundsForHook`
- [x] `ParityHook.t.sol::testFuzz_exactOutRoundsForHook`
- [x] `ParityHook.t.sol::testFuzz_dustFallsThroughReason2`
- [x] `ParityHookInvariant.t.sol::invariant_noExtractionBeyondFee`
- [x] Also: `ParityDecimals.t.sol::testFuzz_bothOrderingsAndDecimals` and `testFuzz_decimalsSweep0to18`

**S2. Donation / inflation**
- [x] `ParityHook.t.sol::test_donatedClaimsCountAsInventory`
- [x] `ParityHook.t.sol::testFuzz_donationCannotReduceFeeProfitably`
- [x] `ParityHookInvariant.t.sol::invariant_claimsEqualInventoryPlusFees`

**S3. Reentrancy across unlock callbacks**
- [x] `ParityHook.t.sol::test_unlockCallbackRejectsNonManager`
- [x] `ParityHook.t.sol::test_depositInsideForeignUnlockReverts`
- [x] `ParityHook.t.sol::test_transientStateClearedBetweenSwapsInOneUnlock`, using `SwapRouterMulti` to run a fill then a fall-through in one unlock (the guard fires)
- [x] `DarkCrossHook.t.sol::test_unlockCallbackOnlyDuringSettle`
- [x] `DarkCrossHook.t.sol::test_executeResidualOnlySelf`
- [x] `DarkCrossHook.t.sol::test_settleNonReentrant`

**S4. Adapter staleness and malicious ratio**
- [x] `Adapters.t.sol::test_multiplierAdapter_pausedTokenUnhealthy`
- [x] `Adapters.t.sol::test_staticAdapter_zeroRatioReverts`
- [x] `Adapters.t.sol::test_multiplierAdapter_outOfBoundsRatioUnhealthy`
- [x] `ParityHook.t.sol::test_beforeSwapRevertsAdapterUnhealthy`
- [x] `ParityHook.t.sol::test_registryPauseBlocksSwaps`
- [x] `ParityHook.t.sol::test_multiplierJumpArbBoundedAndStoppedByPause`

**S5. Delta accounting nets to zero**
- [x] `ParityHook.t.sol::testFuzz_fillDeltasExact`
- [x] `ParityHookInvariant.t.sol::invariant_poolManagerDeltasSettled`
- [x] `ParityHookInvariant.t.sol::invariant_claimsEqualInventoryPlusFees`
- [x] `DarkCrossHook.t.sol::testFuzz_escrowConservation`

**S6. DarkCross commit griefing**
- [x] `DarkCrossHook.t.sol::test_commitBelowMinLockReverts` (`MIN_LOCK = 10_000`)
- [x] `DarkCrossHook.t.sol::test_batchFullAt64`
- [x] `DarkCrossHook.t.sol::test_unrevealedForfeitToTreasuryNonZero`
- [x] `DarkCrossHook.t.sol::test_settleGasBoundedAt64Participants`

**S7. Oracle manipulation at reveal**
- [x] `DarkCrossHook.t.sol::test_settleRevertsOracleStale`
- [x] `DarkCrossHook.t.sol::test_midMovedAfterRevealRespectsLimits`
- [x] `MockPriceOracle.t.sol::test_setMidOnlyPusher`
- [x] `MockPriceOracle.t.sol::test_inverseMidFloor`
- [ ] `DarkCrossHook.t.sol::test_settleRejectsMidOffParity`: not applicable. SCOPING makes it conditional on E16, which is not adopted. See CR-2.

**S8. demoMode left on**
- [x] `EASEligibility.t.sol::test_setDemoModeOnlyOwner`
- [x] `EASEligibility.t.sol::test_setDemoModeEmits`
- [x] `EASEligibility.t.sol::test_demoModeOffRejectsUS`
- [x] `ParityHook.t.sol::test_demoModeOffBlocksIneligibleSwap`
- [x] `Deploy.t.sol::test_manifestDemoModeReadFromChain`

**S9. hookData spoofing**
- [x] `ParityHook.t.sol::test_untrustedSenderClaimIgnored`
- [x] `ParityHook.t.sol::test_invalidHookDataReverts`, fuzzing length, version and dirty address bits, plus `test_invalidHookDataFixedCases` for lengths 32/64/95/97 and version 2
- [x] `ParityHook.t.sol::test_trustedRouterClaimHonoured`
- [x] `ParityHook.t.sol::test_publicRouterClaimIsUnauthenticated_KNOWN`. This is the `_KNOWN` variant SCOPING prescribes while E1 is unresolved (CR-1).
- [x] `EASEligibility.t.sol::testFuzz_resolveSwapper`

**S10. Pool-init front-run**
- [x] `ParityHook.t.sol::test_beforeInitializeRejectsOffParityPrice`

**S11. Unauthenticated `EligibilityDenied` spam**
- [x] `EASEligibility.t.sol::test_enforceEmitsCallerAsMsgSender`

## Test inventory

| File | Tests |
|---|---|
| `DemoNarrative.t.sol` | 4 (§10 ANVIL and UNICHAIN-SEPOLIA × mcbAAPL-c0 / mAAPLx-c0) |
| `ParityHook.t.sol` | 47 × 2 orderings |
| `DarkCrossHook.t.sol` | 27 × 2 orderings |
| `invariant/ParityHookInvariant.t.sol` | 5 invariants × 2 orderings |
| `fuzz/ParityDecimals.t.sol` | 2 (6/18 matrix; 0-18 sweep) |
| `Deploy.t.sol` | 8 |
| `CanonicalShares.t.sol`, `Adapters.t.sol`, `IssuerRegistry.t.sol`, `NyseCalendar.t.sol`, `EASEligibility.t.sol`, `MockPriceOracle.t.sol`, `MockIssuerToken.t.sol` | 12, 6, 6, 7, 10, 5, 4 |
| `Gas.t.sol` | 5 (snapshot) |

## Open items

- **E1 (CR-1).** Public trusted routers honour any claimed swapper. This is pinned by the `_KNOWN` test and needs an interface change.
- **E16 (CR-2).** There is no settle-time bound between the mid and parity.
- **`contracts/script/Seed.s.sol`.** It is legacy and owned by integration. It still mentions vault/uAAPL, so it is the only hit for the SCOPING grep gate. It compiles, and the contracts lane must not edit it.
- **`contracts/script/Addresses.sol`.** Nothing imports it and no lane owns it (CR-4).
- **Unichain Sepolia deploy.** Not run from this lane (no key or RPC here). `Deploy.s.sol` requires every Sepolia external from env.
