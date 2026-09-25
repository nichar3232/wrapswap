#!/usr/bin/env bash
set -euo pipefail
source scripts/local-env.sh
scripts/fund-local.sh
export FORK_DEMO=true
forge script contracts/script/Deploy.s.sol:Deploy --rpc-url "$LOCAL_RPC" --broadcast --slow
scripts/export-abis.sh
python3 scripts/print-receipts.py Deploy.s.sol 8453
