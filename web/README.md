# WrapSwap web

React, Vite and the existing CSS styling system. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit -p web/tsconfig.json
VITE_USE_MOCKS=true VITE_NETWORK=anvil pnpm exec vite build --config web/vite.config.ts
WEB_PORT=13005 VITE_USE_MOCKS=true VITE_NETWORK=anvil pnpm exec vite --config web/vite.config.ts
```

All browser configuration lives in `src/config.ts`. Vite public environment variables are build-time values: rebuild after changing them. Never put secrets in them.

| Variable | Meaning | Default |
| --- | --- | --- |
| `VITE_NETWORK` | `anvil` or `base-sepolia`; validates deployment network and drives chain switch | `anvil` |
| `VITE_USE_MOCKS` | Public USE_MOCKS flag; exactly `true` selects deterministic §10 fixtures | `false` |
| `VITE_API_URL` | API base URL, no trailing slash; `/deployment` must serve `deployments/${NETWORK}.json` | `/api` |
| `VITE_CRANK_URL` | Crank base URL, queried at `/status` (separate from API) | `/crank` |
| `VITE_RPC_URL` | Public JSON-RPC URL for transaction simulation and receipts | `/rpc` dev proxy |
| `WEB_PORT` | Vite dev port; strict binding | `13005` |
| `API_PORT` | Dev API proxy target | `18005` |
| `ANVIL_PORT` | Dev RPC proxy target | `18505` |
| `CRANK_HEALTH_PORT` | Dev crank proxy target | `18105` |

Set API server `NETWORK` to match `VITE_NETWORK`. `PG_PORT` is not used by this web app. No addresses are configured in components; live addresses and chain IDs come only from the validated deployment response. Types, schemas, demo constants and contract ABIs come from `@wrapswap/types`.

For Vercel, keep the repository as the project root, use install command `pnpm install --frozen-lockfile`, build command `pnpm exec tsc --noEmit -p web/tsconfig.json && pnpm exec vite build --config web/vite.config.ts`, output directory `dist/web`. Set the five `VITE_` variables above. Hosted live API/RPC/crank URLs must be HTTPS and allow the site origin through CORS; dev proxies are not included in the production bundle. No server or rewrite is required for this single-page app.

Mocks use `DEMO` constants and the illustrative §4 deployment (only in `src/mocks`). Anvil is open: 4.60 bps, 101.203425 output. Base Sepolia is closed: 14.60 bps, 101.102175 output, with “NYSE closed: +10 bps off-hours premium”. Transactions and dark phase advances in mock mode are explicitly simulated. The batch history includes the §10 matched and residual amounts. Canonical shares are accounting only.

```sh
pnpm exec vitest run web/src
WEB_PORT=13005 VITE_NETWORK=anvil pnpm exec playwright test --config web/playwright.config.ts
WEB_PORT=13005 VITE_NETWORK=base-sepolia pnpm exec playwright test --config web/playwright.config.ts
WEB_PORT=13005 VITE_USE_MOCKS=false VITE_NETWORK=anvil pnpm exec playwright test --config web/playwright.config.ts
```

The last suite intercepts HTTP with schema-valid responses and wallet connection with an injected test provider; it proves the real HTTP path uses environment configuration, including errors, empty data and eligibility/peg blocks. It does not prove on-chain settlement. Each command owns and stops its Vite server; run variants sequentially because this lane owns one web port.

Live dark-cross actions use shared ABIs with simulation, chain checks and confirmed receipts. The demo order sells 60 base tokens at a 1.01 limit, routing its residual through ParityHook. Its reveal secret is saved before funding, scoped to network/hook/account in browser storage. Retain that browser data until revealing; do not clear it or switch browsers mid-batch. A funded but uncommitted balance remains in dark escrow if a later step fails.

**Open integration blocker:** live Convert and Permit2 cannot safely submit using the frozen shared package: it has no router/Permit2 ABI or minimum-output-enforcing transaction specification. The live action is visibly disabled; quotes and all read APIs work with `VITE_USE_MOCKS=false` and valid endpoints. See `../interface-change-requests/web.md`. No live swap success is simulated or claimed.
