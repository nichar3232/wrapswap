# WrapSwap crank

One long-lived viem/Fastify process uses the same validated `deployments/${NETWORK}.json` as the API. It pushes mock oracle ratios, settles eligible batches after the reveal phase, and checks the parity peg. It never commits or reveals on users' behalf. Batch phases advance with chain block number; no close/reveal transaction exists in the frozen interface.

From the repository root, after `pnpm install` and deployment:

```sh
export NETWORK=anvil RPC_URL=http://127.0.0.1:18504
export CRANK_HEALTH_PORT=18104 ORACLE_MODE=mock
pnpm exec tsx services/crank/index.ts
```

| Environment | Requirement / default |
| --- | --- |
| `NETWORK` | Required: `anvil` or `unichain-sepolia`. |
| `RPC_URL` | Required JSON RPC URL. Chain ID must match the manifest. |
| `CRANK_HEALTH_PORT` | Required health listener port; lane value `18104`. |
| `CRANK_HEALTH_HOST` | Default `127.0.0.1`; use `0.0.0.0` when needed for container hosting. |
| `CRANK_POLL_MS` | Default `1000`; actions run on new blocks, failed iterations retry with capped exponential jitter. |
| `ORACLE_MODE` | `mock` or `external`; default `mock` if deployment.mockOracle, otherwise `external`. Pushes require both mock mode and deployment.mockOracle. |
| `CRANK_PK` | Optional explicit hex private key; takes precedence over mnemonic on either network. Keep secret. |
| `DEMO_MNEMONIC` | Signer derives address index 4. Required on Unichain Sepolia unless CRANK_PK is set. Anvil defaults to the standard public test mnemonic. |
| `DATABASE_URL` | Not used by crank; the API/indexer need it, including hosted Postgres SSL settings documented in api/README.md. |
| `ANVIL_PORT` | External Anvil service port (`18504`); include in RPC_URL. Crank does not start Anvil. |
| `PG_PORT`, `API_PORT`, `WEB_PORT` | Other lane service ports (`15404`, `18004`, `13004`); not read by crank. |

Dotenv `.env` is loaded; explicit environment takes precedence. The signer needs native gas and oracle pusher authorization. No deployer-key fallback exists. Do not run two crank processes with the same signer.

`GET /status` and `GET /health` on CRANK_HEALTH_PORT return the shared `CrankStatusResponse`. API `/status` aggregates this response. A starting or failed worker reports `ok:false` and `lastError`; successful iterations clear it. Logs are JSON lines with `oracle_push`, `settled`, `peg_check`, or `error`.

Every iteration recomputes from chain state. Oracle mid is floor(base adapter ratio × 1e18 / quote ratio), pushed when missing, changed, 300 seconds old, or near expiry before settlement. Candidate batches are the previous 16 plus current only during SETTLE. Already-settled and empty batches are skipped; settlement is simulated before sending. Peg changes are checked every 10 blocks and on pool Swap blocks. All timestamps come from chain blocks.

Only one transaction is in flight: each send waits for a receipt. Startup and subsequent iterations fence pending nonces; after 60 seconds a stuck nonce is replaced by a zero-value self-transfer with a 20% gas-price increase. Receipt errors recover through the same fence before retrying. Each action's gas-price bump grows by 20% per failure, capped at five bumps. Iteration retry delay includes at most 1 second of jitter and never exceeds 30 seconds. No local state is needed after a crash; on-chain settled state prevents double settlement.

Tests are included in the backend suite:

```sh
DATABASE_URL=postgresql://postgres:backend@127.0.0.1:15404/wrapswap pnpm exec vitest run --config api/vitest.config.ts
pnpm exec tsc --noEmit -p api/tsconfig.json
```
