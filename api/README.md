# Unison API and indexer

Share-for-share conversion, no USDC leg. Fastify serves the frozen §5 schemas; viem reads the §1 interfaces from `@wrapswap/types`. No legacy ABI or deployment file is used.

Run from the repository root after `pnpm install` and after the deployment lane supplies `deployments/${NETWORK}.json`:

```sh
export NETWORK=anvil
export RPC_URL=http://127.0.0.1:18504
export DATABASE_URL=postgresql://postgres:backend@127.0.0.1:15404/wrapswap
export API_PORT=18004 CRANK_HEALTH_PORT=18104
pnpm exec tsx api/src/index.ts
```

The API migrates at startup and starts the live indexer. Separate commands:

```sh
pnpm exec tsx api/src/db/migrate.ts
pnpm exec tsx api/src/indexer/cli.ts          # confirmed backfill, then exit
pnpm exec tsx api/src/indexer/cli.ts --live   # backfill and poll
pnpm exec tsx api/src/db/migrate.ts --down    # deletes backend schema/data
```

Use an empty database for the frozen schema; legacy tables are not transformed. Migration is transactional and repeatable, guarded by an advisory lock. `schema.sql` is the exact §6 DDL, with the deployment-specific `v_dark_pair` created first. Rollback drops the tables and views; it does not drop the database. A database belongs to one deployment/pair because the frozen `v_dark_pair` is a one-row view. Use separate databases for networks. A deployment identity change clears that chain's indexed blocks and cascades events; API eligibility audit rows remain.

Environment (dotenv `.env` is loaded; explicit environment wins):

| Variable | Requirement / default |
| --- | --- |
| `NETWORK` | Optional, default `unichain-sepolia`; `anvil` for the local stack. Selects the validated deployment JSON. |
| `RPC_URL` | Required for API/crank; archive-capable JSON RPC for pinned reads and indexer backfill. Set explicitly for standalone indexer too. |
| `DATABASE_URL` | Required for API, migration, indexer, and integration tests; PostgreSQL connection URL. |
| `API_PORT` | Required API listening port; lane value `18004`. |
| `API_HOST` | Listening interface; default `127.0.0.1`. Set `0.0.0.0` for container hosting. |
| `CRANK_HEALTH_PORT` | Required for API `/status`; lane value `18104`. Crank is reached over loopback. |
| `CORS_ORIGIN` | Optional single allowed origin; default localhost/127.0.0.1 HTTP origins. |
| `INDEXER_CONFIRMATIONS` | Nonnegative integer, default `2`; confirmed head = head minus depth. Anvil demos may use `0`. |
| `INDEXER_POLL_MS` | Live-indexer polling interval, default `1000`. |
| `ANVIL_PORT` | RPC helper fallback port if RPC_URL is absent, default lane value `18504`; startup still requires explicit RPC_URL. |
| `PG_PORT` | External Postgres service port, lane value `15404`; include it in DATABASE_URL. API does not launch Postgres. |
| `WEB_PORT` | Frontend port, lane value `13004`; backend runtime transport test uses this port (or `13004`). |
| `ORACLE_MODE` | Crank-only `mock` / `external`; see crank README. |
| `CRANK_PK`, `DEMO_MNEMONIC` | Crank-only signer configuration; never needed or returned by API. |

Hosted Postgres SSL uses the connection string unchanged through `pg`, including its provider's SSL options. Prefer `?sslmode=verify-full` and the provider CA via `&sslrootcert=/absolute/path/ca.pem`; providers using a public CA need no custom root. `?sslmode=require` is supported by the driver. The backend never disables certificate verification or sets a competing `ssl` object. Percent-encode URL passwords/paths. Local non-SSL Postgres works with a plain URL. Tests also pass against a TLS-only Postgres 16 server with `verify-full`.

Routes: `/health`, `/deployment`, `/pool`, `/inventory`, `/inventory/changes`, `/fees`, `/quote`, `/route`, `/batches/current`, `/batches`, `/batches/:batchId`, `/orders/:address`, `/fills`, `/eligibility/:address`. Every request query and response uses the shared validators. `/status` additionally proxies crank health using `CrankStatusResponse`. `/health` retains the exact frozen schema and always returns HTTP 200, with failures in its fields.

Quotes read ParityHook at a pinned block and independently check amounts against adapter ratios and the shared exact integer arithmetic. Route selection checks eligibility, adapter health, inventory fill, then simulates V4Quoter. Only peg/liquidity failures permit dark fallback; RPC errors do not fabricate a route. Market time is always the chain timestamp. EAS decisions come from the deployed eligibility contract's `check` read; every route/eligibility request writes an audit row. History uses keyset pagination and the frozen views, which fold underlying parity events into dark residual fills.

The indexer validates RPC chain identity, filters event emitters/deployment start blocks, journals all 32 events, and inserts each projection in the same transaction as its blocks and cursor. Windows are at most 2,000 blocks. A hash mismatch searches at most 64 blocks for a common ancestor, cascades orphan rows, and rewinds the cursor atomically. A deeper reorg stops indexing for operator resync. Recognized malformed logs fail the window; removed logs are ignored. A session advisory lock serializes concurrent indexers. Errors retry on the next poll.

Verification (requires an isolated test database; the tests own `backend_test` and `backend_api_test` schemas):

```sh
DATABASE_URL=postgresql://postgres:backend@127.0.0.1:15404/wrapswap pnpm exec vitest run --config api/vitest.config.ts
pnpm exec tsc --noEmit -p api/tsconfig.json
```

Startup tests use fixture JSON RPC on `ANVIL_PORT`, separate API/crank processes on their assigned ports, and temporary deployment manifests outside the repository. They verify process wiring, not the other lanes' live contract implementations. No production deployment JSON was present in this worktree during implementation.
