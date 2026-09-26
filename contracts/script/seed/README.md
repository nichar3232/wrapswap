Seed data is the frozen `DEMO` export in `packages/types`, generated from INTERFACES.md §10.
`SeedDemo.s.sol` uses exactly those raw constants; the Playwright assertions import DEMO directly.

| Index | Role | Deterministic reveal salt |
|---|---|---|
| 0 | deployer, keeper, treasury, LP | n/a |
| 1 | demo wallet | n/a |
| 2 | counterparty A | bytes32(uint256(2)) |
| 3 | counterparty B | bytes32(uint256(3)) |
| 4 | crank/oracle pusher | n/a |

LP salt: `keccak256("wrapswap.section10.lp.v1")`. Existing liquidity at that salt
marks completed inventory/wallet seeding. Each current-batch order is checked before
commit/reveal. The orchestration marker additionally ties completed seeding to a
canonical block hash, preventing a later invocation from opening another batch.
Markers and snapshots live under ignored `logs/integration/`; preserve them on Sepolia.
On a missing marker, the orchestrator scans Committed logs in 2,000-block windows.
A completed pair exits cleanly; a partial/ambiguous pair fails closed without duplicating orders.
Never delete that marker to force a live reseed. Local reset uses the snapshot.

`SEED_VARIANT=ANVIL|FALL-THROUGH|BLOCKED-PEG|NYSE-CLOSED|BLOCKED-ELIGIBILITY`.
BLOCKED-PEG pauses the base mock issuer (the adapter-health branch of §5 routing).
FALL-THROUGH drains quote inventory; use 1 mcbAAPL for a fill within the LP's peg guard.
NYSE-CLOSED advances to the following Saturday, preserving forward-only local time.
