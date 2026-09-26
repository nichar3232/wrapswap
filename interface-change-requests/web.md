# Web interface gaps

2026-09-26, lane/web. No frozen files changed.

- `@wrapswap/types` exports hook and issuer ABIs, but no PoolSwapTest/swap-router, Universal Router, or Permit2 ABI. The frozen API returns quotes, not transaction calldata. The documented PoolSwapTest call has no minimum-output argument. Please publish a shared router ABI and a minimum-output-enforcing execution contract/transaction specification before enabling live Convert. Inventing an ABI in web would violate the shared-ABI requirement; sending an unprotected swap would violate the displayed minimum output. Live quotes, eligibility, network selection, ERC-20 approval helper and dark-cross transactions are implemented. Convert approval/submission is disabled outside mocks with an explicit explanation, so funds are not approved to an unusable flow.
- Permit2 requires a supported router, shared ABIs, signing domain and ordered execution specification. Current UI selects direct ERC-20 approval in mocks and describes the unavailable live Permit2 path.
- Deployment responses do not include RPC URLs. VITE_RPC_URL is therefore required for hosted live transaction submission; the dev proxy uses ANVIL_PORT.

Implementation decisions: preserve React/Vite/CSS; use VITE_ public environment names; load deployment from the frozen `/deployment` API backed by `deployments/${NETWORK}.json`; poll health/eligibility for event-derived demoMode; use exact-in conversion with 50 bps min-out; keep deterministic mocks separate from wallet RPC. Demo Dark Cross uses the §10 counterparty-A order and simulated phase advances; live phase follows chain blocks. Secrets are persisted before funding/commit, scoped by chain, hook and wallet. No private keys are shipped.
