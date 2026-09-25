#!/usr/bin/env bash
set -euo pipefail
source scripts/local-env.sh
scripts/assert-local.sh
export FORK_DEMO=true
read -r usdc owner < <(python3 - <<'PY'
import json
x=json.load(open('deployments/local.json'));print(x['tokens']['USDC']['address'],x['deployer'])
PY
)
# Impersonation exists only on the loopback fork, never on Base.
holder=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
cast rpc anvil_impersonateAccount "$holder" --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc anvil_setBalance "$holder" 0x56bc75e2d63100000 --rpc-url "$LOCAL_RPC" >/dev/null
cast send "$usdc" 'transfer(address,uint256)(bool)' "$owner" 2000000000000 --from "$holder" --unlocked --rpc-url "$LOCAL_RPC"
cast rpc anvil_stopImpersonatingAccount "$holder" --rpc-url "$LOCAL_RPC" >/dev/null
forge script contracts/script/Seed.s.sol:Seed --rpc-url "$LOCAL_RPC" --broadcast --slow
python3 scripts/print-receipts.py Seed.s.sol 8453
