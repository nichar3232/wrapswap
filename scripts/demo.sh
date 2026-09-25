#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/ensure-env.py
source scripts/local-env.sh
if [[ ! -d node_modules || ! -d lib/v4-core ]]; then make install; fi
psql "$DATABASE_URL" -c "select 1" >/dev/null
mkdir -p logs
if lsof -nP -iTCP:8545 -sTCP:LISTEN >/dev/null 2>&1; then echo 'Port 8545 is occupied. Stop the existing fork before make demo.' >&2; exit 1; fi
fork_pid=;apps_pid=
cleanup(){ [[ -z "$apps_pid" ]] || kill -- -"$apps_pid" 2>/dev/null || kill "$apps_pid" 2>/dev/null || true; [[ -z "$fork_pid" ]] || kill "$fork_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
anvil --fork-url "$BASE_RPC" --port 8545 --chain-id 8453 --block-time 2 >logs/fork.log 2>&1 & fork_pid=$!
for i in {1..60}; do if cast chain-id --rpc-url "$LOCAL_RPC" >/dev/null 2>&1; then break; fi; sleep 1; done
scripts/assert-local.sh
make deploy-local 2>&1 | tee logs/deploy.log
make seed 2>&1 | tee logs/seed.log
pnpm db:migrate
# Start crank before the scripted settlement, with API and web in the same process supervisor.
pnpm exec concurrently --kill-others --names api,crank,web 'pnpm dev:api > logs/api.log 2>&1' 'pnpm dev:crank > logs/crank.log 2>&1' 'pnpm dev:web > logs/web.log 2>&1' >logs/services.log 2>&1 & apps_pid=$!
for i in {1..60}; do if curl -fsS http://127.0.0.1:4001/status >/dev/null; then break; fi; sleep 1; done
pnpm exec tsx scripts/demo-flow.ts | tee logs/demo-flow.log
for i in {1..60}; do if curl -fsS http://127.0.0.1:4000/health >/dev/null && curl -fsS http://127.0.0.1:5173 >/dev/null; then break; fi; sleep 1; done
printf '\nhttp://localhost:5173\n'
if [[ "${DEMO_CHECK:-0}" == 1 ]]; then pnpm test:smoke; echo 'DEMO_CHECK GREEN'; else wait "$apps_pid"; fi
