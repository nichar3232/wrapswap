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

The figures below are from the live 1301 pool **at time of writing** (block 63577136, Sat 2026-09-26 13:32 UTC).
NYSE is closed until Mon 2026-09-28 13:30 UTC. Every live swap moves the skew, so read the numbers off the screen.

### 4.1 Convert: PARITY fill (Convert tab)

- The header shows `unichain-sepolia · Chain 1301 · NYSE CLOSED`, crank healthy and an indexer lag of about 2 blocks.
- Convert 100 mcbAAPL to mAAPLx and the **PARITY** badge appears. The quote shows ratio 1.0125 and 101.25 shares.
- Fee 2.00 base + 2.09 skew + 10.00 closed = **14.09 bps**; fee 0.14266125 mAAPLx; output **101.10733875 mAAPLx** (at time of writing).
- Talking point: the hook fills the swap from its own inventory inside `beforeSwap` at the share ratio, with no USDC leg. It prices off-hours risk instead of refusing to trade.
- Executed Converts through `WrapSwapRouter.swapExactIn` (100 mcbAAPL each):
  - Deployer, 101.10227625 mAAPLx out: [0x9b989f6b…ef30](https://sepolia.uniscan.xyz/tx/0x9b989f6b2494ad76114315fd5f9a0c1cac8bb59d5de820759eee9b14dfc2ef30)
  - Owner MetaMask wallet, 101.1035925 mAAPLx out: [0xd1bfee59…1ff1](https://sepolia.uniscan.xyz/tx/0xd1bfee595d7521ca50eb2d95de3012090632982994be5365877ac669e9841ff1)
  - Production `/app` UI, demo account 1, via `e2e/live/sepolia-convert.spec.ts`: 101.1060225 mAAPLx out, exactly the quote (14.22 bps): [0x992435f8…4dce](https://sepolia.uniscan.xyz/tx/0x992435f8914807eb93e290c497f717e45561f0667cdea906c022b6facfca4dce)

### 4.2 Pool skew (Pool tab)

- Inventory is held as ERC-6909 claims in the PoolManager. At time of writing, skew is 0.160, shown as about 16.0%.
- Talking point: the skew fee prices the inventory imbalance. When inventory can't cover a swap, it falls through to the same pool's liquidity, guarded to within 50 bps of parity.

### 4.3 Dark Cross settle (Dark Cross tab)

- Batch 16 is settled on 1301 by the crank: [0xc26aecb4…2e95d](https://sepolia.uniscan.xyz/tx/0xc26aecb443fcac9689b059f9c789d665c8a072cd5d4cae5fee5cb2a76ef2e95d) (block 63573070).
- Mid was 1.0125. It crossed 50 mcbAAPL ↔ 50.625 mAAPLx and sent a 10 mcbAAPL residual into the ParityHook pool, all in the same settlement tx.
- On stage, show this settled batch and its tx. Re-running `scripts/dev/seed` on 1301 is a no-op by design, because its marker blocks duplicate inventory.
- The full commit → reveal → settle sequence plays in the anvil backup.

### 4.4 Uniscan proof

All 13 contracts are verified; the full table is in `~/wrapswap-run/status/unichain.md`.

- ParityHook (flags `0x20c8`): https://sepolia.uniscan.xyz/address/0x1D2C9335813B8d3fFDCCC9d43aAf73d7871b20c8#code
- DarkCrossHook: https://sepolia.uniscan.xyz/address/0x9E358e72018B776F22fEf71bd07cD9e8bC4b790e#code
- WrapSwapRouter: https://sepolia.uniscan.xyz/address/0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3#code
- The swap and settle txs are linked above.
