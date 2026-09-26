#!/usr/bin/env bash
# Full stack against the anvil fork (8555), live-up's shape with every port +1000, env/RPC only (no source edits):
# Postgres wrapswap-sim-pg:16410, indexer, API 19010, crank 19110, relay 19210, web (dist) 14010. tmux session sim-stack.
set -euo pipefail
cd "$(dirname "$0")/../../.."
source packages/sim/scripts/fork-env.sh
PG=wrapswap-sim-pg
docker start $PG >/dev/null 2>&1 || docker run -d --name $PG -e POSTGRES_USER=wrapswap -e POSTGRES_PASSWORD=wrapswap \
  -e POSTGRES_DB=wrapswap -p 127.0.0.1:$PG_PORT:5432 postgres:16 >/dev/null
until docker exec $PG pg_isready -U wrapswap -d wrapswap >/dev/null 2>&1; do sleep 1; done
sleep 2
pnpm db:migrate
[[ ${SKIP_BUILD:-} ]] || pnpm exec vite build --config web/vite.config.ts
mkdir -p logs
S=sim-stack
tmux kill-session -t $S 2>/dev/null || true
envfile=$(mktemp); chmod 600 "$envfile"; export -p > "$envfile"
start() { tmux new-window -d -t $S -n "$1" "source '$envfile'; cd '$PWD'; $2 2>&1 | tee -a logs/sim-$1.log"; }
tmux new-session -d -s $S -n shell
start indexer 'pnpm exec tsx scripts/dev/indexer.mjs'
sleep 5
start api 'pnpm dev:api'
start crank 'pnpm dev:crank'
start web 'node scripts/dev/serve-web.mjs'
start relay 'pnpm exec tsx services/relay/index.ts'
sleep 3; rm -f "$envfile"
for i in $(seq 60); do curl -sf 127.0.0.1:$RELAY_PORT/demo/status >/dev/null && break; sleep 2; done
curl -sf 127.0.0.1:$RELAY_PORT/demo/status >/dev/null && echo "relay healthy" || echo "relay NOT healthy"
for kind in api crank web; do
  for i in $(seq 90); do node scripts/dev/health.mjs $kind >/dev/null 2>&1 && break; sleep 2; done
  node scripts/dev/health.mjs $kind >/dev/null 2>&1 && echo "$kind healthy" || echo "$kind NOT healthy"
done
