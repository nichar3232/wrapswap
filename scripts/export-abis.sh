#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p deployments/abis
for name in CanonicalStock ParityHook DarkCrossHook NyseCalendar IssuerRegistry PoolSwapTest IIssuerAdapter StaticAdapter MockIssuerToken MockB20; do
  forge inspect "$name" abi --json > "deployments/abis/$name.json"
done
