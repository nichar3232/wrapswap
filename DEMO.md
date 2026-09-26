# WrapSwap demo runbook

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

After a contract redeploy, run `scripts/dev/live-down --reset && scripts/dev/live-up`. The indexer rebuilds from the
manifest's `startBlock` and takes each hook's events only from its own deploy block (`blocks.parityHook` / `darkCrossHook`).
It covers every asset's tokens and adapters (`assets[].wrappers`) and the faucet.

- `NETWORK` defaults to `unichain-sepolia`, with `USE_MOCKS=false`, `deployments/unichain-sepolia.json` and the public externals in `scripts/dev/unichain-sepolia.env`.
- Secrets come from `~/wrapswap-run/env/onchain.env` (`DEMO_MNEMONIC`, `CRANK_PRIVATE_KEY`, `UNICHAIN_SEPOLIA_RPC_URL`). Override the path with `LIVE_ENV=...`.
- Web is the **production build** (`dist/web`, rebuilt by `live-up`) served by `scripts/dev/serve-web.mjs`, never the Vite dev server. On the single port 13010 it serves `/` (landing) and `/app`, and proxies `/api` → 18010, `/crank` → 18110 and `/rpc` → `RPC_URL`, so RPC keys stay server-side.
- `/api`, `/crank` and `/rpc` are rate-limited to 600 requests/min per client IP (`RATE_LIMIT_PER_MIN`); over the limit returns 429. Behind Funnel the client IP comes from `X-Forwarded-For`. One open `/app` tab uses about 100/min.
- Processes run in the tmux session `wrapswap-live` with one window each for indexer, api, crank and web (`tmux attach -t wrapswap-live`). Logs go to `logs/live-{indexer,api,crank,web}.log`.

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

Live figures below are from the 1301 pools **at time of writing** (block 63581560, Sat 2026-09-26 14:46 UTC). NYSE is
closed until Mon 2026-09-28 13:30 UTC. Every live swap moves the skew, so read the numbers off the screen.
Fee model: 2 bps base + skew fee + off-hours premium of 15 bps × |post-trade skew|. The premium applies only to trades
that increase skew while NYSE is closed. The total is capped at 25 bps.

### 4.1 Convert: PARITY fill (Convert tab)

- The header shows `unichain-sepolia · Chain 1301 · NYSE CLOSED`, crank healthy and an indexer lag of about 2 blocks. The asset picker (from `/api/assets`) lists AAPL, NVDA and TSLA, each with Coinbase and xStocks wrappers.
- Convert 100 mcbAAPL to mAAPLx and the **PARITY** badge appears. The quote shows ratio 1.0125 and 101.25 shares.
- At time of writing this trade reduces inventory skew (|skew| 0.089), so the fee is 2.00 base + 1.16 skew + 0 off-hours = **3.16 bps**, output **101.218005 mAAPLx**.
- Flip the direction (100 mAAPLx → mcbAAPL): it deepens the skew, so off-hours adds 1.49 bps = **4.65 bps**, output 98.719506 mcbAAPL.
- Talking point: the hook fills the swap from its own inventory inside `beforeSwap` at the share ratio, with no USDC leg. Off-hours it charges only trades that deepen inventory skew (rebalancing lag), instead of refusing to trade.
- Executed Converts through `WrapSwapRouter.swapExactIn` on the current ParityHook:
  - Production `/app` UI, demo account 1, via `e2e/live/sepolia-convert.spec.ts`: 100 mcbAAPL → 101.21668875 mAAPLx, exactly the quote (3.29 bps): [0x41022b52…3dbb](https://sepolia.uniscan.xyz/tx/0x41022b52ea7908bb631818a97562ee6ee5124768314fcddaf2586b9fcc9b3dbb) (block 63581542)
  - Deployer, skew-increasing: 100 mAAPLx → 98.71674 mcbAAPL at 4.93 bps (1.64 off-hours): [0x8fb8d9c3…ac12](https://sepolia.uniscan.xyz/tx/0x8fb8d9c3c90cb31c830ec331197e62b10f3fa9b0f50c5689b5e78dc6ecc5ac12) (block 63580053)
- Test funds: `TestShareFaucet.claim()` sends 1,000 of each of the 6 wrappers once per 24 h. Proof claim: [0x5fd33936…13ca](https://sepolia.uniscan.xyz/tx/0x5fd33936c421b2046415fbae6197ba09fee575d4f95755b4ad31ee19017913ca). Claims show in `/api/stats`.

### 4.2 Pool skew (Pool tab)

- Inventory is held as ERC-6909 claims in the PoolManager. At time of writing, the AAPL pool's skew is 0.089, shown as about 8.9%.
- Talking point: the skew fee prices the inventory imbalance. When inventory can't cover a swap, it falls through to the same pool's liquidity, guarded to within 50 bps of parity.
- `/api/stats` gives the totals: conversions, share volume and inventory fees, per asset and per wallet.

### 4.3 Dark Cross settle (Dark Cross tab, AAPL)

- Batch 16 is settled on the current DarkCrossHook by the crank: [0x43cdac4b…b0e](https://sepolia.uniscan.xyz/tx/0x43cdac4b32a03c49b6f7dc937a094a4f94861b172df5380391cace646571bb0e) (block 63580007).
- It crossed 50 mcbAAPL ↔ 50.625 mAAPLx at mid 1.0125 and routed a 10 mcbAAPL residual through ParityHook in the same settlement tx. `/api/batches?settled=true` lists it.
- Dark Cross exists for AAPL only; NVDA and TSLA have ParityHook pools without a Dark Cross pair.
- On stage, show this settled batch and its tx. The full commit → reveal → settle sequence plays in the anvil backup.

### 4.4 Uniscan proof

All deployed contracts are verified; the full table is in `~/wrapswap-run/status/unichain.md`.

- ParityHook (flags `0x20c8`, one hook for all three pools): https://sepolia.uniscan.xyz/address/0x4142CA2E270A3f94cB8B56b1F6e1C74465a8a0c8#code
- DarkCrossHook: https://sepolia.uniscan.xyz/address/0xBfcdFf560AaEe80E9030be7574e2451a1296883A#code
- WrapSwapRouter: https://sepolia.uniscan.xyz/address/0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3#code
- TestShareFaucet: https://sepolia.uniscan.xyz/address/0xD25b4916eC55aA1F550052ff90d1EcD6B51AABdC#code
- The swap, settle and faucet txs are linked above.

### 4.5 §10 live variant

INTERFACES.md §10 `variants.unichain-sepolia` is generated, never hand-typed. It is labelled "Seed state at deploy
block 63580006, market closed". Regenerate it after any redeploy, then run `pnpm types` (verify-demo re-derives it):

```sh
NETWORK=unichain-sepolia RPC_URL=https://sepolia.unichain.org pnpm exec tsx scripts/dev/demo-variant.ts && pnpm types
```
