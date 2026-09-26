SHELL := /bin/bash
.PHONY: install types build test clean
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
	pnpm build
test:
	forge test
	pnpm test
clean:
	forge clean
	rm -rf dist/web
