# WrapSwap demo runbook

All commands run on the Mac mini from `~/wrapswap` on `main`. Nothing is hosted: the demo runs from the mini
through an SSH tunnel to the presenting laptop.

| Stack | Web | API | Crank | Postgres | Started by |
|---|---|---|---|---|---|
| Base Sepolia (live, primary) | 13010 | 18010 | 18110 | 15410 (container `wrapswap-sepolia-pg`) | `scripts/dev/sepolia-up` |
| Local anvil (backup) | 13008 | 18008 | 18108 | 15408 (compose `wrapswap-integration`) | `scripts/dev/up` |

None of these ports conflict with 5173, 5174 or 5190.

## 1. Base Sepolia stack (primary)

```sh
cd ~/wrapswap
scripts/dev/sepolia-up        # prints "api/crank/web healthy"; the first start backfills the indexer for a few minutes
curl -s 127.0.0.1:18010/health | python3 -m json.tool | head -8   # "ok": true, lagBlocks ≈ 2
curl -s 127.0.0.1:18110/status | python3 -m json.tool | head -6   # "ok": true
```

- Secrets come from `~/wrapswap-run/env/lane6.env` (`DEMO_MNEMONIC`, `CRANK_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`). Override the path with `SEPOLIA_ENV=...`.
- Settings: `NETWORK=base-sepolia`, `USE_MOCKS=false`, `deployments/base-sepolia.json`, RPC `base-sepolia-rpc.publicnode.com`, and the crank signs as `0xa9c1…30cB`.
- Processes run in the tmux session `wrapswap-sepolia` with one window each for indexer, api, crank and web (`tmux attach -t wrapswap-sepolia`). Logs go to `logs/sepolia-{indexer,api,crank,web}.log`.
- Stop the stack with `scripts/dev/sepolia-down`. The Postgres data is kept, so the next start does not need to backfill.
- The crank's `lastError` sometimes shows `LimitExceededRpcError` from publicnode. It is a transient throttle, and the crank clears it on the next block.

## 2. Local anvil stack (backup)

```sh
cd ~/wrapswap
scripts/dev/up                # first time: deploy + seed + snapshot; afterwards it just resets
scripts/dev/record-ready      # before each take: revert to the seed snapshot, assert the seed, health-check
```

Full check: `scripts/dev/demo-check` (3 identical demo runs + 4 scenarios, exit 0). To stop: `scripts/dev/down`.

The backup video is at `~/wrapswap-run/demo.webm` (18 s, Convert → Pool → Dark Cross settled). To re-record it:

```sh
scripts/dev/record-ready && DEMO_RUN=video npx playwright test e2e/demo.spec.ts --config playwright.video.config.ts
cp test-results/video/*/video.webm ~/wrapswap-run/demo.webm
```

## 3. Laptop tunnel

Run this on the laptop, then open **http://localhost:13010** (Sepolia). The API is at http://localhost:18010/health.

```sh
ssh -N -L 13010:127.0.0.1:13010 -L 18010:127.0.0.1:18010 nichar@100.100.1.1
```

The web proxies `/api` and `/crank` itself, so the web port alone is enough for the UI. For the anvil backup, tunnel `13008` and `18008` the same way.

## 4. Run of show

Figures are from the live Sepolia stack on Sat 2026-09-26 (NYSE CLOSED until Mon 2026-09-28 13:30 UTC). The Sepolia
pool already holds one live swap (below), so the Sepolia skew figures differ from the §10 BASE-SEPOLIA variant.
The anvil backup still matches §10 ANVIL exactly.

### 4.1 Convert: PARITY fill (Convert tab)

- The header shows `base-sepolia · Chain 84532 · NYSE CLOSED`, crank healthy and an indexer lag of about 2 blocks.
- Convert 100 mcbAAPL to mAAPLx and the **PARITY** badge appears. The quote shows ratio 1.0125, 101.25 shares, fee 2 base + 2.46 skew + 10 closed = **14.46 bps**, and output **101.1035925 mAAPLx**.
- Talking point: the hook fills the swap from its own inventory inside `beforeSwap` at the share ratio, with no USDC leg. It prices off-hours risk instead of refusing to trade.
- Proof of an executed Convert through WrapSwapRouter: tx [0xf4de19cb…1de90](https://sepolia.basescan.org/tx/0xf4de19cb48bb7ea8a2e729c87b99b0cbd1be51a56f6e586d58195c184cf1de90). It converted 100 mcbAAPL into 101.10227625 mAAPLx at 14.59 bps and is indexed as a PARITY fill.
- Anvil backup (NYSE OPEN): 4.60 bps, 101.203425 mAAPLx, and "conversion confirmed" after Approve → Convert.

### 4.2 Pool skew (Pool tab)

- Inventory is held as ERC-6909 claims in the PoolManager. The skew badge reads about 19% (on anvil it goes from −20% to −19% after the fill; the sign depends on currency order).
- Talking point: the skew fee prices the inventory imbalance. When inventory can't cover a swap, it falls through to the same pool's liquidity, guarded to within 50 bps of parity.

### 4.3 Dark Cross settle (Dark Cross tab)

- Sepolia settled batch 16, settle tx [0x7f640d9a…6b9](https://sepolia.basescan.org/tx/0x7f640d9a4552de2a87bded2e5f819b26dbd5178019ee627c33cf93e43fbaa6b9). It produced two DARK-CROSS fills and one DARK-RESIDUAL fill (10 mcbAAPL → 10.110217500 mAAPLx through ParityHook), all under one settlement tx.
- On stage, show this settled batch and its tx; don't try to run a fresh one. Re-running `scripts/dev/seed` on Sepolia is a no-op by design, because the `logs/integration/seed-base-sepolia` marker blocks duplicate inventory. The live commit → reveal → settle sequence is shown in the anvil backup, where phases are 20 blocks.
- Anvil backup: batch 2 SETTLED. Crossed 50 mcbAAPL ↔ 50.625 mAAPLx; residual 10 mcbAAPL → 10.120474125 mAAPLx at 4.47 bps.

### 4.4 Basescan proof

- ParityHook (verified): https://sepolia.basescan.org/address/0x708AeC5CD2C504A8fB40615aC797C52BB2EB20c8#code (flags `0x20c8`)
- DarkCrossHook: https://sepolia.basescan.org/address/0x9E358e72018B776F22fEf71bd07cD9e8bC4b790e#code
- WrapSwapRouter: https://sepolia.basescan.org/address/0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3#code
- The live Convert and the settle tx are linked above. All 13 contracts are verified; the full table is in `~/wrapswap-run/status/finish.md`.
