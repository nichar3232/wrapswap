#!/usr/bin/env bash
set -euo pipefail
source scripts/local-env.sh
address=$(cast wallet address --private-key "$DEPLOYER_PK")
balance=$(cast balance "$address" --rpc-url "$UNICHAIN_SEPOLIA_RPC")
if [[ "$balance" == 0 ]]; then echo "FUND ME: $address (Unichain Sepolia)"; echo 'Testnet deployment blocked: deployer has zero Sepolia ETH.' >&2; exit 1; fi
export FORK_DEMO=false
forge script contracts/script/Deploy.s.sol:Deploy --rpc-url "$UNICHAIN_SEPOLIA_RPC" --broadcast --slow
python3 scripts/print-receipts.py Deploy.s.sol 1301
scripts/export-abis.sh
# Verification requires an explorer API key and actual constructor arguments from broadcast artifacts.
python3 scripts/verify-testnet.py

python3 scripts/update-testnet-readme.py
