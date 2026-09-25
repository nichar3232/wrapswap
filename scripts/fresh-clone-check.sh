#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/local-env.sh
check_dir=$(mktemp -d /tmp/wrapswap-fresh.XXXXXX)
echo "Fresh clone: $check_dir"
git clone --no-local . "$check_dir"
cd "$check_dir"
check_db="wrapswap_fresh_$(date +%s)"
createdb "$check_db"
export BASE_RPC
export DATABASE_URL="postgresql://localhost/$check_db"
python3 scripts/ensure-env.py
make install
DEMO_CHECK=1 make demo
printf 'FRESH CLONE GREEN: %s\n' "$check_dir"
