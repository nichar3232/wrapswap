SHELL := /bin/bash
.PHONY: install types build test fork deploy-local seed demo testnet fresh-clone-check clean
install:
	./scripts/install-contracts.sh
	pnpm install --frozen-lockfile
	pnpm exec playwright install chromium
types:
	forge build
	pnpm --filter @wrapswap/types generate
	pnpm --filter @wrapswap/types build
	pnpm --filter @wrapswap/types verify
build:
	forge build
	pnpm --filter @wrapswap/types build
	./scripts/export-abis.sh
	pnpm build
test:
	forge test
	pnpm test
fork:
	@source scripts/local-env.sh; anvil --fork-url "$$BASE_RPC" --port 8545 --chain-id 8453 --block-time 2
deploy-local:
	./scripts/deploy-local.sh
seed:
	./scripts/seed.sh
demo:
	./scripts/demo.sh
testnet:
	./scripts/testnet.sh
fresh-clone-check:
	./scripts/fresh-clone-check.sh
clean:
	forge clean
	rm -rf dist/web
