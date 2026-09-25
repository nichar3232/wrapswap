#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -d lib/v4-core || forge install Uniswap/v4-core@46c6834698c48bc4a463a86d8420f4eb1d7f3b75 --no-git
test -d lib/v4-periphery || forge install Uniswap/v4-periphery@9969eec44cfdf07e24b41de47f40276a58401976 --no-git
test -d lib/forge-std || forge install foundry-rs/forge-std@ba4733c33497dd0c0983dcc033d7645576cc46e5 --no-git
