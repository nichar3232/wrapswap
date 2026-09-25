#!/usr/bin/env bash
set -euo pipefail
source scripts/local-env.sh
case "$LOCAL_RPC" in http://localhost:*|http://127.0.0.1:*) ;; *) echo 'Fork operations require a loopback RPC' >&2; exit 1;; esac
client=$(cast rpc web3_clientVersion --rpc-url "$LOCAL_RPC")
[[ "$client" == *anvil* ]] || { echo 'Fork operation requires Anvil' >&2; exit 1; }
[[ $(cast chain-id --rpc-url "$LOCAL_RPC") == 8453 ]] || { echo 'Expected Base fork chain ID' >&2; exit 1; }
