# Verification record — 2026-09-25

The working submission is the Base-fork conversion and dark-crossing application. It is **not** a claim that the complete original specification shipped.

| Check | Result |
| --- | --- |
| `make test` on main | 36 Solidity tests + 11 application/database/runtime tests passed; no skipped tests |
| `forge test --fork-url https://mainnet.base.org --match-contract DarkCrossHookTest` on main | 16 passed against Base's deployed PoolManager, including crossing and residual escrow fuzzing |
| `pnpm build` | TypeScript and Vite production build passed |
| `make demo` | Actual vault mint, hook fill, drained-inventory fall-through, three commitments/reveals and crank settlement passed receipt assertions |
| `pnpm test:smoke` on main | Five passed: tab navigation, parity conversion, vault mint/redeem, escrow deposit/withdraw, commit/auto-reveal |
| `make fresh-clone-check` | Passed from `/tmp/wrapswap-fresh.fAJ8iB`, commit `61f3c9a`, fresh deployer and isolated Postgres database; all five browser tests passed in 44.3 seconds |
| Gas snapshot | Committed `.gas-snapshot`, including 1000-run fuzz configurations |
| Base Sepolia | Attempted; stopped before broadcast because deployer balance was zero. No deployment/verification addresses claimed |
| Intent bridge | Not shipped, honoring the requested §7-before-§5 gate |

Core tests cover 1000-run backing, cross/pro-rata escrow, and routed-escrow fuzz cases. Native B20 is explicitly mocked because generic Anvil cannot execute its native opcode; the PoolManager, PositionManager, StateView, V4Quoter, Permit2, native USDC and Chainlink feed are real Base contracts on the fork. Issuer 2 is also explicitly mocked.

[Structured demo receipts](../deployments/demo-receipts.json) preserve the local chain's action hashes, blocks, batch and Crossed/RoutedToLit counts. These hashes belong to an ephemeral fork, not public Base explorer transactions. The local manifest is regenerated on every demo. [UI capture](app-screenshot.png) shows live fork state.

The first sustained main run exposed Node24's upstream Undici/macOS socket QoS crash. A fixed lockfile-pinned dispatcher and a forced-failure regression test were added; subsequent main and clean-clone browser suites passed. See [FEEDBACK.md](../FEEDBACK.md).

Remaining work for one more day: fund and verify Sepolia; implement and test the optimistic bridge with rebasing-aware AAPLx escrow; harden production oracle normalization, TWAP availability and router-aware EAS identity.
