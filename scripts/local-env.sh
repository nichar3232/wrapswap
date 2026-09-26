#!/usr/bin/env bash
# Source from repository root; never prints secrets.
set -euo pipefail
if [[ -f .env ]]; then set -a; source .env; set +a; fi
export LOCAL_RPC="${LOCAL_RPC:-http://127.0.0.1:8545}"
export BASE_RPC="${BASE_RPC:-https://mainnet.base.org}"
export UNICHAIN_SEPOLIA_RPC="${UNICHAIN_SEPOLIA_RPC:-https://sepolia.unichain.org}"
export DATABASE_URL="${DATABASE_URL:-postgresql://localhost/wrapswap}"
