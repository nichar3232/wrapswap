# Unison integration

**Current result: blocked at the contracts deployment boundary.** On this branch,
`scripts/dev/up` starts healthy Anvil (31337) and Postgres, then the unchanged
`contracts/script/Deploy.s.sol` reverts `Unsupported chain`. There is no generated
`deployments/anvil.json`. End-to-end acceptance, deterministic transaction comparison,
and the <60-second reset/readiness target have **not passed**. No component logic was
changed to conceal this result.

## Runbook

From the repository root, `scripts/dev/up` installs the pinned Foundry dependencies,
starts the lane's Anvil and Postgres, calls Deploy, validates its manifest, seeds,
snapshots, migrates, starts indexer/API/crank/web, and waits for the indexer to reach
head. It stops on the first failure. It never rewrites a legacy manifest as a new one.

```sh
scripts/dev/up
scripts/dev/record-ready       # owner command before recording Part A
scripts/dev/down              # preserves the database volume
```

Ports default to this lane's allocated block: 18508 RPC, 15408 Postgres, 18008 API,
13008 web, 18108 crank. All are overrideable through ANVIL_PORT, PG_PORT, API_PORT,
WEB_PORT and CRANK_HEALTH_PORT. Compose project defaults to `wrapswap-integration`.
No other lane's containers are touched. Services use NETWORK=anvil, USE_MOCKS=false.
The public local mnemonic is the standard Anvil test mnemonic. Never fund it on mainnet.

The web URL is `http://127.0.0.1:13008/app?tab=move`; `/api` proxies to the API and `/rpc`
to Anvil. API and crank currently bind loopback; a small TCP bridge publishes their
ports on the shared container network namespace. Health checks address the actual
component endpoints, not synthetic success responses.

The literal requested acceptance command is:

```sh
scripts/dev/demo-check && npx playwright test e2e/scenarios
```

For this literal host command, Node with Corepack and Chromium are required in addition
to Docker and Foundry. `scripts/dev/bootstrap` installs the JS workspace and Chromium.
The “only Docker and Foundry” prerequisite and the literal `npx` command are inconsistent;
this remains open in `interface-change-requests/integration.md`. Application services
run in Docker, but this revision's browser harness runs on the host.

`demo-check` executes up, resets before each of three Part A runs, and diffs complete
captured API responses, including tx hashes, block numbers and timestamps. No volatile
fields are removed to hide differences. A failed run never produces a success result.
`reset` stops all chain writers/indexers, reverts and renews the seed snapshot, truncates
all public DB tables with identity reset/cascade, restarts services, and waits for head.
`record-ready` additionally checks exact seed wallet balances, inventory, eligibility,
fee and timestamp, checks all service health, and opens Convert with the OS browser.
Runtime markers/artifacts are under ignored `logs/integration/`.

ANVIL starts with a fixed 2-second interval, which up disables before deployment.
Replay uses automining with fixed timestamp increments, explicit phase advancement,
and a snapshot after seeding. Oracle updates are fresh at the seed timestamp. This
avoids host-clock-dependent transaction ordering. The crank alone settles batches.
Counterparty reveals are sent by the harness, never by the crank.

## Seed and scenarios

`SeedDemo.s.sol` imports only the frozen interfaces from project source; dependencies
supply v4 types/math and Forge scripting. It checks the deployment's issuer decimals,
adapter ratios, pool fee/tick spacing, and parity initialization. Deploy owns token,
adapter, pool and router creation. Seed owns funding, inventory, LP, eligibility,
oracle setup, and the two counterparties' commits. Seed data and salts are described
in `contracts/script/seed/README.md`; expected demo amounts come from `DEMO`.

Existing LP liquidity at the deterministic salt marks completed bootstrap. Wallet and
inventory top-ups avoid duplication on a partial bootstrap retry. A completed seed
marker is checked against its canonical block hash. Without a marker, Committed logs
are scanned in 2,000-block windows; an existing complete pair is a clean no-op and an
ambiguous partial pair fails without opening another batch. Partial live seed recovery
requires inspection; it is deliberately not allowed to duplicate orders.

Local seed variants: `SEED_VARIANT=ANVIL`, `FALL-THROUGH` (quote inventory drained),
`BLOCKED-PEG` (issuer paused/adapter unhealthy), `NYSE-CLOSED` (following Saturday),
`BLOCKED-ELIGIBILITY` (demoMode false). Set before a fresh up/seed; do not reuse a
completed seed marker to mutate a live seed. Scenario tests reset the snapshot and
apply the same mutations directly through shared ABIs. The fall-through test uses
1 mcbAAPL to remain inside the LP peg guard.

For Unichain Sepolia, first obtain the deployment owner's conforming manifest and build
the app image (`source scripts/dev/env; docker compose build api`). Then:

```sh
NETWORK=unichain-sepolia RPC_URL="$UNICHAIN_SEPOLIA_RPC" \
  DEMO_MNEMONIC="$PRIVATE_DEMO_MNEMONIC" DEPLOYER_PK="$PRIVATE_DEPLOYER_PK" \
  scripts/dev/seed
```

The deployer must be mnemonic index 0, with enough gas to fund indices 1–4 to 0.01 ETH.
The script uses the real clock, waits for a usable commit phase, commits and reveals
as indices 2/3, and leaves settlement to the live crank. It never writes the committed
Unichain Sepolia manifest. It has **not been broadcast on Sepolia**. Exact §10 live residual
numbers require the conversion to precede settlement; see CR-1.

## Video timeline (ANVIL)

| Video time | Action | Expected §10 evidence |
|---|---|---|
| 00:00 | Run record-ready; show Convert | NYSE OPEN, chain timestamp 1790692200; wallet 500/500 |
| 00:10 | Enter 100 mcbAAPL | PARITY; 1.0125 ratio; 460 pips / 4.60 bps |
| 00:25 | Approve and convert | Receive 101.203425 mAAPLx; fee 0.046575 |
| 00:40 | Open Pool | Inventory 8,100 mcbAAPL / 12,048.75 mAAPLx; skew −0.19 in base/quote order |
| 00:55 | Reveal A/B; advance to SETTLE | A sells 60 mcbAAPL; B sells 50.625 mAAPLx |
| 01:10 | Crank settles | Cross 50 mcbAAPL / 50.625 mAAPLx; 500-pip cross fee |
| 01:20 | Inspect residual | 10 mcbAAPL through ParityHook; 447 pips; output 10.120474125 mAAPLx |
| 01:35 | Show final balances | Demo 400 / 601.203425; A escrow 60.720161625 mAAPLx; B escrow 49.975 mcbAAPL |
| 01:45 | Show fees | Hook fees accrue to the LP; live figures in DEMO.md §4 |

Pool-order skew reverses sign when the base token is currency1; the assertions account
for this. Live CLOSED outputs are 101.102175 and 10.110349125 mAAPLx, conditional on the
same action ordering. No USDC leg or user-facing canonical share token is part of this flow.

## Boundary report

Run `scripts/dev/boundaries` for source evidence, or `forge build && node
scripts/dev/abi-boundaries.mjs` for exact missing functions, errors and indexed events.
These audits intentionally exit nonzero while the frozen interfaces are unimplemented.
The table maps ownership using INTERFACES.md §8. Static mismatches below are independently
confirmed; runtime symptoms after the first deployment failure remain untested.

| ID | Owning path / lane | Mismatch and repro command |
|---|---|---|
| C01 | contracts/script/Deploy.s.sol, Addresses.sol / contracts | Rejects 31337; legacy vault/USDC pools, tick spacing 60, local.json schema. `scripts/dev/up` → `Deploy::run(): Unsupported chain`. |
| C02 | contracts/src/ParityHook.sol / contracts | Legacy vault pair, fee formula/events; lacks quote, feeBreakdown, eligibility, checkPeg and frozen ABI. `forge build && node scripts/dev/abi-boundaries.mjs` |
| C03 | contracts/src/DarkCrossHook.sol / contracts | uAAPL/USDC, Chainlink/TWAP and separate lit pool, incompatible commit/reveal/settle. `node scripts/dev/abi-boundaries.mjs` |
| C04 | contracts/src/CanonicalStock.sol / contracts | User-facing canonical ERC20 still deployed. `rg -n 'CanonicalStock|vault' contracts/script/Deploy.s.sol` |
| C05 | contracts/src/IssuerRegistry.sol, adapters/ / contracts | Legacy adapter/registry ABI, missing underlying/health/ratio; event mismatches. `node scripts/dev/abi-boundaries.mjs` |
| C06 | contracts/src/NyseCalendar.sol / contracts | Missing EarlyCloseSet/custom errors; HolidaySet.day not indexed. `node scripts/dev/abi-boundaries.mjs` |
| C07 | contracts/src/mocks/ / contracts | MockB20 uses 8 decimals; issuer multiplier ABI incompatible; oracle is AggregatorV3. `node scripts/dev/abi-boundaries.mjs` |
| C08 | contracts/src/ / contracts | No EAS eligibility implementation/artifact. `node scripts/dev/abi-boundaries.mjs` |
| B01 | api/src/chain/client.ts / backend | Legacy deployment and local RPC/ABI loading. `scripts/dev/boundaries` (B01) |
| B02 | api/src/routes/index.ts, api/src/index.ts / backend | Legacy routes and string errors instead of §5. `scripts/dev/boundaries` (B02) |
| B03 | api/src/db/schema.sql, api/src/indexer/ / backend | Legacy projections/tables instead of §6 cursor/provenance and issuer fill tables. `scripts/dev/boundaries` (B03); new indexer health SQL requires indexer_cursor.last_block. |
| B04 | api/src/index.ts / backend | API starts another indexer unconditionally; needs independent lifecycle/disable switch for the specified separate service. `rg -n 'startIndexer' api/src/index.ts` |
| B05 | services/crank/index.ts / backend | Legacy health fields, CRANK_PORT/deployer fallback, only previous-batch lookback, no oracle push or peg checks. `scripts/dev/boundaries` (B05) |
| W01 | web/src/main.tsx / web | Legacy vault conversion, Backing/USDC flow; no required Pool view or frozen issuer route. `scripts/dev/boundaries` (W01) |
| W02 | web/tests/smoke.spec.ts / web | Legacy smoke expectations. `rg -n 'Backing|backing|USDC|vault|uAAPL' web/tests/smoke.spec.ts` |

Legacy `contracts/script/Seed.s.sol`, scripts/{seed.sh,demo-flow.ts,deploy-local.sh,
export-abis.sh,fresh-clone-check.sh}, Makefile fork/demo targets and deployments/local.json
remain outside the new entrypoint. Repro: `rg -n '8545|local.json|USDC|uAAPL|vault'
Makefile scripts/*.sh scripts/*.ts deployments/local.json`. They were not edited because
this assignment restricts writes to the new wiring/seed/harness. README/submission's
legacy narrative belongs to submission (`rg -n 'USDC|uAAPL' README.md submission`).

## Verification and remaining limits

Passed: both NETWORK builds of SeedDemo, full forge build, image build, Compose config,
Anvil/Postgres health, shell syntax, integration TypeScript checking, discovery of five
Playwright cases. Commands: `NETWORK=anvil forge build contracts/script/SeedDemo.s.sol`;
`NETWORK=unichain-sepolia forge build contracts/script/SeedDemo.s.sol`; `forge build`;
`source scripts/dev/env; docker compose build; docker compose config --quiet`;
`pnpm exec tsc -p e2e/tsconfig.json`; `npx playwright test e2e --list`.

Executed and failed: up/demo-check at C01; demo.spec at absent anvil manifest; each
scenario/reset/record-ready at absent seed snapshot. No tests are marked skipped to
make acceptance green. Successful broadcasts, browser selectors against the future UI,
full API/chain agreement, identical replay hashes and reset speed remain unverified.
The seed/harness compiles, but this does not establish “zero harness failures” at runtime.
The missing deployment must be supplied by the contracts lane before those claims can
be tested. Host-only Playwright prerequisites and live sequencing are additional open
limitations, explicitly recorded rather than labeled component bugs.
