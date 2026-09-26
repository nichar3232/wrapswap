#!/usr/bin/env bash
# Fork-only setup: ETH via anvil_setBalance, oracle pusher role + wrapper mints via the impersonated deployer.
set -euo pipefail
cd "$(dirname "$0")/../../.."
source packages/sim/scripts/fork-env.sh
R=$FORK_RPC
rpc() { curl -sf -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" $R >/dev/null; }
ORACLE=$(python3 -c "import json;print(json.load(open('deployments/unichain-sepolia.resolved.json'))['contracts']['oracle'])")
for a in $DEPLOYER $CRANK_ADDR $RELAY_ADDR; do rpc anvil_setBalance "[\"$a\",\"0x56BC75E2D63100000\"]"; done
rpc anvil_impersonateAccount "[\"$DEPLOYER\"]"
cast send --unlocked --from $DEPLOYER $ORACLE "setPusher(address,bool)" $CRANK_ADDR true --rpc-url $R >/dev/null
# 10,000 whole tokens of every wrapper to the relay.
for t in $(python3 -c "
import json;d=json.load(open('deployments/unichain-sepolia.json'))
print(' '.join(w['token'] for a in d['assets'] for w in a['wrappers']))"); do
  dec=$(cast call $t "decimals()(uint8)" --rpc-url $R)
  cast send --unlocked --from $DEPLOYER $t "mint(address,uint256)" $RELAY_ADDR "$(python3 -c "print(10000*10**$dec)")" --rpc-url $R >/dev/null
done
echo "funded: crank pusher=$(cast call $ORACLE 'isPusher(address)(bool)' $CRANK_ADDR --rpc-url $R), relay minted"
