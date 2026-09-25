#!/usr/bin/env bash
set -euo pipefail
source scripts/local-env.sh
scripts/assert-local.sh
address=$(python3 - <<'PY'
import json,os,subprocess
r=subprocess.check_output(['cast','wallet','address','--private-key',os.environ['DEPLOYER_PK']],text=True);print(r.strip())
PY
)
cast rpc anvil_setBalance "$address" 0x3635c9adc5dea00000 --rpc-url "$LOCAL_RPC" >/dev/null
