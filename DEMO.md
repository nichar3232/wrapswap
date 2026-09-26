# Unison demo runbook

All commands run on the Mac mini from `~/wrapswap` on `main`. Nothing is hosted: the demo runs from the mini
through an SSH tunnel to the presenting laptop. The only live network is **Unichain Sepolia (chain 1301)**, and
its explorer is [Uniscan](https://sepolia.uniscan.xyz).

| Stack | Web | API | Crank | Postgres | Started by |
|---|---|---|---|---|---|
| Unichain Sepolia (live, primary) | 13010 | 18010 | 18110 | 15410 (container `wrapswap-live-pg`) | `scripts/dev/live-up` |
| Local anvil (offline backup) | 13008 | 18008 | 18108 | 15408 (compose `wrapswap-integration`) | `scripts/dev/up` |

None of these ports conflict with 5173, 5174 or 5190.

## 1. Live stack: Unichain Sepolia (primary)

```sh
cd ~/wrapswap
scripts/dev/live-up           # prints "api/crank/web healthy"; a fresh database backfills from the start block first
curl -s 127.0.0.1:18010/health | python3 -m json.tool | head -8   # "ok": true, "chainId": 1301, lagBlocks ≈ 2
curl -s 127.0.0.1:18110/status | python3 -m json.tool | head -6   # "ok": true
scripts/dev/live-down         # stop (keeps the Postgres data); `live-down --reset` drops it
```

`deployments/unichain-sepolia.json` is the minimal deploy output: `chainId`, `deployBlock`, `router`, `faucet`,
`protocolFeeRecipient`, and `assets[]` with each asset's wrappers, pool id, `parityHook` and `darkCross` hook. `live-up`
first runs `scripts/dev/resolve-deployment.ts`, which reads everything else from the chain, starting from those
addresses only. It writes `deployments/unichain-sepolia.resolved.json`, which the API, indexer, crank and web load.

After a contract redeploy, run `scripts/dev/live-down --reset && scripts/dev/live-up`. The indexer rebuilds from
`deployBlock`. It covers the shared ParityHook (all three pools), every asset's DarkCrossHook, the wrappers, the adapters
and the faucet. The crank runs one worker per DarkCrossHook: it pushes the oracle mid, settles batches and checks the peg.

Live checks:

```sh
set -a; source ~/wrapswap-run/env/onchain.env; set +a; export NETWORK=unichain-sepolia RPC_URL=https://sepolia.unichain.org WEB_PORT=13010 API_PORT=18010
npx playwright test e2e/live/sepolia-convert.spec.ts   # Convert through the production /app (AAPL)
npx playwright test e2e/live/router-assets.spec.ts     # Convert on every asset through WrapSwapRouter, indexed per asset
scripts/dev/dark-batch-live NVDA                       # one Dark Cross batch (AAPL | NVDA | TSLA), settled by the crank
```

Before going on stage, run `pnpm preflight` (`scripts/dev/preflight`). It prints one PASS/FAIL line per check and exits 1 on any failure:
- stack health: API, crank, local web, relay, and the Sui keeper (live PID and fresh state file)
- Funnel on every public ingress IP: `/`, `/app`, `/api/health`, `/api/assets`, `/api/pay/reserves`, plus `/mcp` initialize and tools/list, and one external fetch
- API routes per asset (AAPL, NVDA, TSLA): `/pool`, `/batches`, `/quote`, and the current Dark Cross phase (not stalled, oracle fresh)
- `CROSS_FEE_PIPS = 100` on every DarkCrossHook
- ETH balances: crank, deployer, demo relay, and the wallets in `deployments/preflight-wallets.json`
- demo relay: each wrapper's balance covers a 100-share action and is approved to the router and to its DarkCrossHook
- SUI balances: the keeper/operator and the relay's two Sui identities
- Sui solvency, read from both chains: Sui pool `total_shares` ≤ ShareVault shares held; the pool is not paused
- the MCP relay budget token is configured

**Demo relay** (`services/relay`, started by `live-up` in tmux window `relay`, port 18210, served as `/api/demo/*`; its public address is in the manifest under `demo.relay`):
- It signs with a dedicated, freshly generated demo key `0x8f2e78AbD6E234D7B1CA7047F7502c374C81dA6C`. That key is neither the deployer nor the crank key and is not mnemonic-derived.
- The Sui path uses two relay Sui identities: A `0xa25a…1a53` pays, and B `0xf755…d44d` receives and withdraws.
- Keys live only in `~/wrapswap-run/env/demo-relay.env` and `demo-relay-sui.env`, and are never logged or bundled.
- Budgets:
  - browsers: 3 actions per 10 minutes per client IP
  - the MCP server: its own 20 per 10 minutes, identified by the `x-unison-relay-client` token in `~/wrapswap-run/env/relay-internal.env`
  - 100 shares per action
- A 429 carries `Retry-After` and `retryAfter`.
- `POST /api/demo/send` `{asset: AAPL, from, to, amount, recipient}`: **the Sui confidential path.**
  1. Deposit the source wrapper into ShareVault `0x76B1661dB3858b5455Ae4371291c954fa248Bd5d` on Unichain.
  2. Once the keeper credits A, A sends a sealed private `pay` to B on Sui.
  3. B submits a sealed `withdraw` into the **other** issuer's wrapper for `recipient`, and the keeper settles it on Unichain.
  4. The POST returns the real deposit tx. `GET /api/demo/send/<id>` follows the Sui and settlement hashes (a few minutes; one send at a time, 409 while busy).
- `POST /api/demo/send-unichain` `{asset, from, to, amount, recipient}`: a Unichain-only router swap delivered to `recipient`.
- `POST /api/demo/convert` `{asset, from, to, amount}` and `POST /api/demo/dark-commit` `{asset, from, amount}`. The relay reveals commits itself and the crank settles them.
- Each returns the real tx hash. `GET /api/demo/status` shows balances, Sui identities, pending reveals and recent hashes.

- `NETWORK` defaults to `unichain-sepolia`, with `USE_MOCKS=false`, `deployments/unichain-sepolia.json` and the public externals in `scripts/dev/unichain-sepolia.env`.
- Secrets come from `~/wrapswap-run/env/onchain.env` (`DEMO_MNEMONIC`, `CRANK_PRIVATE_KEY`, `UNICHAIN_SEPOLIA_RPC_URL`). Override the path with `LIVE_ENV=...`.
- Web is the **production build** (`dist/web`, rebuilt by `live-up`) served by `scripts/dev/serve-web.mjs`, never the Vite dev server. On the single port 13010 it serves `/` (landing) and `/app`, and proxies `/api` → 18010, `/crank` → 18110 and `/rpc` → `RPC_URL`, so RPC keys stay server-side.
- `/api`, `/crank` and `/rpc` are rate-limited to 600 requests/min per client IP (`RATE_LIMIT_PER_MIN`); over the limit returns 429. Behind Funnel the client IP comes from `X-Forwarded-For`. One open `/app` tab uses about 100/min.
- Processes run in the tmux session `wrapswap-live`, with one window each for indexer, api, crank, sui-keeper, web, relay and mcp (`tmux attach -t wrapswap-live`). Logs go to `logs/live-<window>.log`.

## 2. Local anvil stack (offline backup)

```sh
cd ~/wrapswap
scripts/dev/up                # first time: deploy + seed + snapshot; afterwards it just resets
scripts/dev/record-ready      # before each take: revert to the seed snapshot, assert the seed, health-check
```

Full check: `scripts/dev/demo-check` (3 identical demo runs + 4 scenarios, exit 0). To stop: `scripts/dev/down`.

The backup video is at `~/wrapswap-run/demo.webm` (anvil, 18 s, Convert → Pool → Dark Cross settled). To re-record it:

```sh
scripts/dev/record-ready && DEMO_RUN=video npx playwright test e2e/demo.spec.ts --config playwright.video.config.ts
cp test-results/video/*/video.webm ~/wrapswap-run/demo.webm
```

## 3. Public URL (Tailscale Funnel) and laptop tunnel

The live app is public at **https://nichars-mac-mini.tail43cacc.ts.net/app** (landing at `/`, API at `/api/health`),
served from the mini through Tailscale Funnel on port 13010.

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 13010   # start; persists until reset
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status        # check
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel reset        # stop: tailscale funnel reset
```

`tailscale` is not on the mini's PATH, so the commands above use the app binary. `tailscale funnel reset` removes all
Funnel/serve config and takes the public URL offline.

From the mini itself the hostname resolves to the tailnet IP and skips Funnel. To test the public path, pin curl to
the public ingress: `curl --resolve nichars-mac-mini.tail43cacc.ts.net:443:$(dig +short @1.1.1.1 nichars-mac-mini.tail43cacc.ts.net | head -1) https://nichars-mac-mini.tail43cacc.ts.net/api/health`.

Private fallback without Funnel: run this on the laptop, then open **http://localhost:13010/app**.

```sh
ssh -N -L 13010:127.0.0.1:13010 -L 18010:127.0.0.1:18010 mini
```

For the anvil backup, tunnel `13008` and `18008` the same way.

## 4. Run of show (Unichain Sepolia)

Live figures below are from the 1301 pools **at time of writing** (block 63589883, Sat 2026-09-26 17:05 UTC). Every live
swap moves the skew, so read the numbers off the screen. Fee model: `baseFeePips` (2 bps, owner-settable) + a skew fee
of min(15 bps × |post-trade skew|, 50 bps), charged only on trades that increase the imbalance. The whole fee stays in
the hook's inventory (100% to the LP), and there's no market-hours input. Dark Cross takes 1 bp on crossed volume to
`protocolFeeRecipient`, and residuals fill through ParityHook at base + skew.

### 4.1 Convert (every asset)

- The header shows `unichain-sepolia · Chain 1301`, crank healthy and an indexer lag of about 2 blocks. Assets come from `/api/assets`: AAPL, NVDA and TSLA, each with Coinbase and xStocks wrappers.
- AAPL (|skew| 0.188, long mAAPLx): 100 mcbAAPL → mAAPLx rebalances, so it's **2.00 bps** base only, output **101.22975 mAAPLx**, youKeep 0.999800. The reverse (100 mAAPLx → mcbAAPL) deepens the skew and costs **4.97 bps** = 2.00 + 2.97 skew, output 98.716345 mcbAAPL.
- NVDA (skew −9.79%) and TSLA (−9.80%): Coinbase → xStocks rebalances at 2.00 bps. The reverse costs 3.63 bps (2.00 + 1.63 skew).
- Talking point: a same-share swap has no price risk, so the base fee is 2 bps. Only a trade that deepens the hook's inventory imbalance pays a skew fee, and all of it goes to the LP.
- Executed Converts through WrapSwapRouter `0x49d7eA31c619E80785Fa31CBc5bE052ED4EC40Cb` on ParityHook `0x484bc6…e0c8`:
  - Production `/app` UI, demo account 1 (`e2e/live/sepolia-convert.spec.ts`): 100 mcbAAPL → 101.22975 mAAPLx, exactly the quote (2.00 bps): [0x2a6df379…7b47](https://sepolia.uniscan.xyz/tx/0x2a6df3791b7df11a6be6a7768499ad45dae0faef5f8ce7f1653f84c6caa27b47)
  - Every asset through the router (`e2e/live/router-assets.spec.ts`, 10 Coinbase → xStocks each, indexed per asset): AAPL [0x440626c6…0c85](https://sepolia.uniscan.xyz/tx/0x440626c6d800c496c281d563c5b7ed86ddef1bb66b6a76b1a01e6c04373e0c85), NVDA [0x2e2c140e…b444](https://sepolia.uniscan.xyz/tx/0x2e2c140ef7720c5f8ffe563cf60e0bcbbcd9e18b27289062322fd4c38432b444), TSLA [0x462b791e…f7b9](https://sepolia.uniscan.xyz/tx/0x462b791e11b58aa1ac371274742cb9a521b15074625bc147c5c971c8dbf5f7b9)
  - Deployer, imbalance-increasing, at deploy time: 100 mAAPLx → 98.714666 mcbAAPL at 5.14 bps: [0x53058b66…6967](https://sepolia.uniscan.xyz/tx/0x53058b66852381de1aab326442304d553ab204d248215fc7c00a18d36cf06967)
- Test funds: `TestShareFaucet.claim()` (`0x108fb6DdBCAc39cC49ACB075a04714e17B49d30A`) sends 1,000 of each of the 6 wrappers once per 24 h. `/api/faucet/<address>` shows the next claim time per token.

### 4.2 Liquidity (per asset)

- `/api/pool/<asset>` gives inventory per wrapper, skew %, the fee in each direction, the cheap direction, and LP fees split into base and skew (from `Converted` events).
- Talking point: the skew fee prices the inventory imbalance. When inventory can't cover a swap, it falls through to the same pool's liquidity, guarded to within 50 bps of parity.

### 4.3 Dark Cross (one DarkCrossHook per asset)

Each batch below was settled by the crank. Crossed volume pays 1 bp per side to the protocol, and each residual filled through ParityHook in the same settlement tx:

| Asset | Batch | Matched shares | Protocol fee (shares) | Residual | Settle tx |
|---|---|---|---|---|---|
| AAPL | 17 | 50.625 | 0.010125 | 10 mcbAAPL filled (base fee 0.002025 shares) | [0x5bfcf5a5…3295](https://sepolia.uniscan.xyz/tx/0x5bfcf5a59ac2fe5ca48d431c2114c6d6f79706d1622902a9554b819be2273295) |
| NVDA | 140 | 51 | 0.0102 | 10 mcbNVDA filled (0.00204 shares) | [0xa3ab2779…6d52](https://sepolia.uniscan.xyz/tx/0xa3ab2779cd8845c6c813167cbc176df20a4fcdfd934d96cfd30c85f8e59e6d52) |
| TSLA | 148 | 49.5 | 0.0099 | 10 mcbTSLA filled (0.00198 shares) | [0x091dd5c8…59cf](https://sepolia.uniscan.xyz/tx/0x091dd5c855260b09d9ac48f360570c91eecea733213868f321e763ab44ad59cf) |

`/api/batches?asset=<A>&settled=true` lists them with midpoint, crossed shares, protocol fee, residual fills and unfilled refunds. `/api/batches/current?asset=<A>` gives the phase and seconds remaining. To run another batch: `scripts/dev/dark-batch-live <ASSET>`.

### 4.4 Uniscan proof

All deployed contracts are verified. The full table, generated from the Uniscan API, is under Contracts in [README.md](README.md).

- ParityHook (flags `0x20c8`, one hook for all three pools): https://sepolia.uniscan.xyz/address/0x484bc6aa8f6D472AD67F3ce8dD86f1f8A166e0c8#code
- DarkCrossHooks: AAPL https://sepolia.uniscan.xyz/address/0xBac8C71CfbB1101221cb4699533d79Df188C4898#code · NVDA https://sepolia.uniscan.xyz/address/0xadf79997624aFeCE9d3E9391d7B51F59a8fB691a#code · TSLA https://sepolia.uniscan.xyz/address/0x223a9d724F5bbF4e76830edDf4858fdD838c3a3c#code
- WrapSwapRouter: https://sepolia.uniscan.xyz/address/0x49d7eA31c619E80785Fa31CBc5bE052ED4EC40Cb#code
- TestShareFaucet: https://sepolia.uniscan.xyz/address/0x108fb6DdBCAc39cC49ACB075a04714e17B49d30A#code

### 4.5 §10 live variant

INTERFACES.md §10 `variants.unichain-sepolia` is generated, never hand-typed. It is labelled "Seed state at deploy
block 63586745" and carries its on-chain `seedInventory` of 7,901.234568 mcbAAPL / 12,000 mAAPLx. Regenerate it after
any redeploy, then run `pnpm types` (verify-demo re-derives it):

```sh
NETWORK=unichain-sepolia RPC_URL=https://sepolia.unichain.org pnpm exec tsx scripts/dev/demo-variant.ts && pnpm types
```

### 4.6 Send (Unison Pay: Unichain + Sui)

- In the app: **Send**. With a wallet, the panel walks Deposit (Unichain ShareVault) → Send (a Seal-encrypted payment on Sui, applied when the pool's 90 s window closes) → the recipient withdraws into either issuer's wrapper. Without a wallet it calls the relay's `POST /api/demo/send` (the Sui confidential path above) and lists every Unichain and Sui tx with explorer links.
- Reserves: `/api/pay/reserves` reads both chains. `invariant` means Sui total = vault shares, and `solvent` means Sui total ≤ vault shares held.
- Talking point: sending costs Sui gas only. A withdrawal into the other issuer's wrapper converts through ParityHook and pays the normal Convert fee. The claim is confidential, not anonymous: the keeper sees amounts.
- Verified live runs and their hashes: [submission/sui-details.md](submission/sui-details.md). Design as shipped: [docs/sui-payments-plan.md](docs/sui-payments-plan.md).

### 4.7 Agents (MCP)

- Remote endpoint: `https://nichars-mac-mini.tail43cacc.ts.net/mcp` (Streamable HTTP). Run `claude mcp add --transport http unison <url>`, then ask for a quote or a convert.
- Tools: `list_assets`, `get_pool`, `quote_convert`, `get_batch`, `convert`, `commit_dark_order`. Execution goes through the relay with the MCP budget (20 actions per 10 minutes, 100 shares per action). See [packages/mcp/README.md](packages/mcp/README.md).

### 4.8 Market simulation (simulated, not live)

**Simulated.** External prices are synthetic; the contracts are the real deployment on a local Unichain Sepolia fork
(blocks 63604933–63606682), never the live pools. 1,500 trades over 380 ticks
(arb 404, regular 1074, whale 18, Claude agents via MCP 4), with a 40 bps outside
gap opened at the start and again mid-run. Figures below are copied by script from `web/public/sim/run.json`.

| Asset | Outside gap, bps (start → end) | Ticks to < 15 bps (start / 2nd shock) | Max \|skew\| | Max skew fee (bps) | LP fees (shares) | Protocol fees (shares) | Peg deviation, steady state, bps (mean / p95) |
|---|---|---|---|---|---|---|---|
| AAPL | +40.0 → -0.3 | 4 / 3 | 0.992 | 15.00 | 24.047 | 1.724 | 11.0 / 22.8 |
| NVDA | -40.0 → -5.0 | 6 / 3 | 0.826 | 12.54 | 26.483 | 1.572 | 7.4 / 18.8 |
| TSLA | +40.0 → +0.2 | 2 / 11 | 0.999 | 15.00 | 18.186 | 2.023 | 11.6 / 25.4 |

Replay: `/sim.html`. Finding from the exploratory run: a persistent one-sided gap larger
than the skew fee at full skew (15 bps) plus the 2 bps base plus the arb threshold drains the short side of the
inventory (seen at 10k shares per side). Mitigations: deeper inventory, a steeper skew curve or higher cap, or keeper rebalancing.
Details: `~/wrapswap-run/status/sim.md`, harness in `packages/sim`.
