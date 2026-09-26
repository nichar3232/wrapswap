# Unison

Unison converts one tokenized stock between issuer wrappers, share for share, with no cash leg. Different platforms
issue the same Apple share as different tokens: here, a Coinbase-style wrapper and an xStocks-style wrapper. Neither
issuer redeems the other's token. Unison prices both in canonical shares (1e18 = one share, via each issuer's
multiplier) and fills conversions at parity from inventory held by the hook in a Uniswap v4 pool.

**Live:** https://nichars-mac-mini.tail43cacc.ts.net/app
- Landing page at `/`, contract list at `/developers`.
- Networks: Unichain Sepolia (chain 1301) and Sui testnet.
- Assets: AAPL, NVDA, TSLA.

The issuer wrappers are testnet mocks with real multipliers. No issuer is represented as having endorsed this project.

App navigation: **Portfolio · Move · Send · Liquidity**. Move holds Convert and Dark Cross.

## Products

| Product | What it does | Where it settles |
| --- | --- | --- |
| **Convert** | Swaps one issuer's wrapper for another's at share parity. The quote shows shares in, base fee, skew fee and shares out. | ParityHook on Unichain Sepolia, reached through WrapSwapRouter. One hook serves a pool for each asset. |
| **Dark Cross** | You commit a sealed order (side, size, limit), reveal it, and it crosses against the other side at the oracle midpoint. Residuals fill from the ParityHook pool in the same settlement transaction. | One DarkCrossHook per asset. Batches last 20 blocks (12 commit, 6 reveal, 2 settle), and a permissionless crank settles them. |
| **Send** | Pays someone in shares confidentially. You deposit a wrapper into the ShareVault and send a Seal-encrypted payment on Sui. The recipient withdraws into whichever issuer's wrapper they use. | ShareVault on Unichain Sepolia, plus the Unison Pay pool on Sui testnet (Seal + Walrus). |

## Fees

| Flow | Fee | Goes to |
| --- | --- | --- |
| Convert | 2 bps base (owner-settable), plus a skew fee of min(15 bps × \|post-trade skew\|, 50 bps). The skew fee applies only when the trade increases the pool's inventory imbalance. | The LP (the fee stays in hook inventory). The protocol takes 0. |
| Dark Cross, crossed volume | 1 bp of each side's crossed amount | Protocol fee recipient |
| Dark Cross, residual | The Convert fee (base + skew), filled from the ParityHook pool | LP |
| Dark Cross, unfilled | Refunded to the committer | None |
| Dark Cross, unrevealed commit | The locked amount is forfeited | Protocol fee recipient |
| Send | Sui gas only. A withdrawal into the other issuer's wrapper converts through ParityHook and pays the Convert fee on that leg. | LP |

A trade that reduces the imbalance pays only the base fee. Sizes and fees are in shares throughout; neither the app
nor the contracts show USD prices.

## Agents (MCP)

The Unison MCP server gives an agent the same surface as the app:
- **Read:** `list_assets`, `get_pool`, `quote_convert`, `get_batch`.
- **Execute:** `convert` and `commit_dark_order`. They go through the demo relay and are capped at 100 shares per action.

The server holds no keys and no addresses.

```sh
claude mcp add --transport http unison https://nichars-mac-mini.tail43cacc.ts.net/mcp   # remote, Streamable HTTP
pnpm --dir packages/mcp start:stdio                                                       # local, stdio
```

Details and the Claude Desktop config: [packages/mcp/README.md](packages/mcp/README.md).

## Market simulation

[`/sim.html`](https://nichars-mac-mini.tail43cacc.ts.net/sim.html) replays 1,500 simulated trades (arbitrageurs,
regular users, whales and Claude agents over MCP) against the real contracts on a local Unichain Sepolia fork, with
synthetic external prices. Results and the harness: [DEMO.md](DEMO.md#48-market-simulation-simulated-not-live),
[packages/sim](packages/sim).

## Contracts

<!-- testnet:start -->
Unichain Sepolia (chain 1301), deploy block 63586346. Manifest: [`deployments/unichain-sepolia.json`](deployments/unichain-sepolia.json). Convert fee = 2 bps base (owner-settable) + min(15 bps × |post-trade skew|, 50 bps) only on imbalance-increasing trades, 100% to the LP; Dark Cross: 1 bp on crossed volume to the protocol fee recipient `0xFD42fC43855C9332051e9e2F05a75C8914073F9e`, residual at base + skew.

| Contract | Address | Uniscan (source) |
| --- | --- | --- |
| ParityHook | `0x484bc6aa8f6D472AD67F3ce8dD86f1f8A166e0c8` | [verified](https://sepolia.uniscan.xyz/address/0x484bc6aa8f6D472AD67F3ce8dD86f1f8A166e0c8#code) |
| WrapSwapRouter | `0x49d7eA31c619E80785Fa31CBc5bE052ED4EC40Cb` | [verified](https://sepolia.uniscan.xyz/address/0x49d7eA31c619E80785Fa31CBc5bE052ED4EC40Cb#code) |
| TestShareFaucet (1,000 of each wrapper / 24 h) | `0x108fb6DdBCAc39cC49ACB075a04714e17B49d30A` | [verified](https://sepolia.uniscan.xyz/address/0x108fb6DdBCAc39cC49ACB075a04714e17B49d30A#code) |
| DarkCrossHook (AAPL) | `0xBac8C71CfbB1101221cb4699533d79Df188C4898` | [verified](https://sepolia.uniscan.xyz/address/0xBac8C71CfbB1101221cb4699533d79Df188C4898#code) |
| Mock Coinbase AAPL wrapper (multiplier 1.0125) | `0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c` | [verified](https://sepolia.uniscan.xyz/address/0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c#code) |
| B20MultiplierAdapter (AAPL, Coinbase) | `0xc3bE8635F1CB05aBCd5DF001157aAb9349184828` | [verified](https://sepolia.uniscan.xyz/address/0xc3bE8635F1CB05aBCd5DF001157aAb9349184828#code) |
| Mock xStocks AAPL wrapper (multiplier 1) | `0x433DAfF77AD96b9319957D83d9d422E70c996C45` | [verified](https://sepolia.uniscan.xyz/address/0x433DAfF77AD96b9319957D83d9d422E70c996C45#code) |
| XStocksMultiplierAdapter (AAPL, xStocks) | `0x577C983f0c3cf3868d543C1c4cbb2807B65ddA78` | [verified](https://sepolia.uniscan.xyz/address/0x577C983f0c3cf3868d543C1c4cbb2807B65ddA78#code) |
| DarkCrossHook (NVDA) | `0xadf79997624aFeCE9d3E9391d7B51F59a8fB691a` | [verified](https://sepolia.uniscan.xyz/address/0xadf79997624aFeCE9d3E9391d7B51F59a8fB691a#code) |
| Mock Coinbase NVDA wrapper (multiplier 1.02) | `0x9b1dc2Cb4cF7b3e514555944E5cE07A54265A2D2` | [verified](https://sepolia.uniscan.xyz/address/0x9b1dc2Cb4cF7b3e514555944E5cE07A54265A2D2#code) |
| B20MultiplierAdapter (NVDA, Coinbase) | `0xF76aC3064b5b8a458a46e281acf047069F2eD762` | [verified](https://sepolia.uniscan.xyz/address/0xF76aC3064b5b8a458a46e281acf047069F2eD762#code) |
| Mock xStocks NVDA wrapper (multiplier 1.005) | `0xEdcD509ab5404529ed5169379EeE14A755E3027c` | [verified](https://sepolia.uniscan.xyz/address/0xEdcD509ab5404529ed5169379EeE14A755E3027c#code) |
| XStocksMultiplierAdapter (NVDA, xStocks) | `0x612b15a552D49616A60aa4B740A84D3e2E306211` | [verified](https://sepolia.uniscan.xyz/address/0x612b15a552D49616A60aa4B740A84D3e2E306211#code) |
| DarkCrossHook (TSLA) | `0x223a9d724F5bbF4e76830edDf4858fdD838c3a3c` | [verified](https://sepolia.uniscan.xyz/address/0x223a9d724F5bbF4e76830edDf4858fdD838c3a3c#code) |
| Mock Coinbase TSLA wrapper (multiplier 0.99) | `0x0757eEe1292046c7303f5C603001e0a9069a6B80` | [verified](https://sepolia.uniscan.xyz/address/0x0757eEe1292046c7303f5C603001e0a9069a6B80#code) |
| B20MultiplierAdapter (TSLA, Coinbase) | `0x2De6944b9c3C00c9Fe2f407C91DF28c7283c8Ef6` | [verified](https://sepolia.uniscan.xyz/address/0x2De6944b9c3C00c9Fe2f407C91DF28c7283c8Ef6#code) |
| Mock xStocks TSLA wrapper (multiplier 1.01) | `0x752746b311B256170f1a3156B34465D5A4363153` | [verified](https://sepolia.uniscan.xyz/address/0x752746b311B256170f1a3156B34465D5A4363153#code) |
| XStocksMultiplierAdapter (TSLA, xStocks) | `0x81e70214de47206a58c03179291e7DD8e2C168a5` | [verified](https://sepolia.uniscan.xyz/address/0x81e70214de47206a58c03179291e7DD8e2C168a5#code) |
| ShareVault (Send custody) | `0x76B1661dB3858b5455Ae4371291c954fa248Bd5d` | [verified](https://sepolia.uniscan.xyz/address/0x76B1661dB3858b5455Ae4371291c954fa248Bd5d#code) |
| IssuerRegistry | `0xA5d433FA4E90D21859B325Be34F0B8845F8E9070` | [verified](https://sepolia.uniscan.xyz/address/0xA5d433FA4E90D21859B325Be34F0B8845F8E9070#code) |
| EASEligibility (demoMode on) | `0x85ABBc06C69D9426907352034a5A7C3D30EB5C5A` | [verified](https://sepolia.uniscan.xyz/address/0x85ABBc06C69D9426907352034a5A7C3D30EB5C5A#code) |
| MockPriceOracle | `0xBe2fb3259454F35bC5999f345873c870b5DE3dB1` | [verified](https://sepolia.uniscan.xyz/address/0xBe2fb3259454F35bC5999f345873c870b5DE3dB1#code) |

Pools (one ParityHook, dynamic fee, tick spacing 10):

- AAPL: pool id `0xb1d8e1c86674b92a25e277b2ccb23b9765cd308e0d99da6918b1da6fb6cba9f9`, DarkCrossHook `0xBac8C71CfbB1101221cb4699533d79Df188C4898`
- NVDA: pool id `0xf57d09b59f5199789b91a05ac7947004b8cff5335649b43dcaaef06c7c72b0c2`, DarkCrossHook `0xadf79997624aFeCE9d3E9391d7B51F59a8fB691a`
- TSLA: pool id `0xb8dec9123afbb275c89e030753d1932aefec010f6d2f32c54b8bd094e1bd2d5e`, DarkCrossHook `0x223a9d724F5bbF4e76830edDf4858fdD838c3a3c`

Proof transactions:

- Convert through WrapSwapRouter, imbalance-increasing: 100 mAAPLx -> 98.714666 mcbAAPL at 5.14 bps (2.00 base + 3.14 skew): [`0x53058b66852381de1aab326442304d553ab204d248215fc7c00a18d36cf06967`](https://sepolia.uniscan.xyz/tx/0x53058b66852381de1aab326442304d553ab204d248215fc7c00a18d36cf06967)
- AAPL Dark Cross batch 17 settled: 50 mcbAAPL crossed at mid 1.0125 (1 bp to protocol), 10 mcbAAPL residual filled by ParityHook at 2 bps base: [`0x5bfcf5a59ac2fe5ca48d431c2114c6d6f79706d1622902a9554b819be2273295`](https://sepolia.uniscan.xyz/tx/0x5bfcf5a59ac2fe5ca48d431c2114c6d6f79706d1622902a9554b819be2273295)

Test funds: `TestShareFaucet.claim()` sends 1,000 of every mock wrapper (once per address per 24 h; reverts with the seconds remaining). Unichain Sepolia ETH faucets (from Unichain's docs): [Superchain Faucet](https://app.optimism.io/faucet), [QuickNode](https://faucet.quicknode.com/unichain/sepolia), [thirdweb](https://thirdweb.com/unichain-sepolia-testnet).
<!-- testnet:end -->

Sui testnet ([deployments/sui-testnet.json](deployments/sui-testnet.json)):

| Object | ID |
| --- | --- |
| Package `unison_pay` | [`0x2f18fa6d…f452c`](https://suiscan.xyz/testnet/object/0x2f18fa6d27e46235a4dcb9c0de62adbf612e3f60700ffeeac4e13d50ea4f452c) |
| Pool (90 s batch window) | [`0xf414bbcc…12fe1`](https://suiscan.xyz/testnet/object/0xf414bbcc050bb2c0407d76f482bc830323a6dd93195ef1b5fae855e939a12fe1) |
| Operator / keeper | [`0xb07be57e…741c7`](https://suiscan.xyz/testnet/account/0xb07be57ee7e7d5ca43f681c6938cc8698fd892b42d1b33f613909ae585c741c7) |

Solvency invariant: Sui `total_shares` ≤ shares held by the ShareVault. `pnpm preflight` checks it on every run, and
the API serves it at `/api/pay/reserves`.

## Uniswap v4 integration

- **ParityHook** ([contracts/src/ParityHook.sol](contracts/src/ParityHook.sol)):
  - `beforeSwapReturnDelta` fills at share parity from ERC-6909 inventory claims held by the hook.
  - Pools use dynamic fees, with `OVERRIDE_FEE_FLAG` carrying the base + skew fee.
  - `afterSwap` applies a 50 bps peg guard when a swap falls through to pool liquidity.
  - `beforeInitialize` checks each pool.
- **DarkCrossHook** ([contracts/src/DarkCrossHook.sol](contracts/src/DarkCrossHook.sol)) settles each batch inside a
  `PoolManager.unlock` callback and routes residuals exact-input into the ParityHook pool.
- **WrapSwapRouter** ([contracts/src/WrapSwapRouter.sol](contracts/src/WrapSwapRouter.sol)) makes exact-input swaps
  with a recipient in `hookData`. The app, the demo relay, the MCP server and the ShareVault all use it.
- Hook addresses are mined with HookMiner and deployed through the CREATE2 proxy
  ([contracts/script/DeployFinal.s.sol](contracts/script/DeployFinal.s.sol)).

## Run it

```sh
make install
scripts/dev/live-up      # Unichain Sepolia stack: indexer, API, crank, Sui keeper, relay, MCP, web (port 13010)
pnpm preflight           # PASS/FAIL per check: balances, approvals, keepers, routes per asset, batch phase, solvency, /mcp
scripts/dev/up           # offline backup: local anvil stack with public test keys
```

Tests:
- `forge test`
- `pnpm test` (the API tests need `DATABASE_URL`)
- `pnpm build`
- the Playwright suites in `e2e/`

[DEMO.md](DEMO.md) is the runbook. [INTERFACES.md](INTERFACES.md) has the interfaces, the API schemas and the canonical
demo figures.

## Disclosures

- Testnet only. The issuer wrappers, the price oracle and the faucet are mocks. The Uniswap v4 contracts are the real
  Unichain Sepolia deployments.
- Send is confidential, not anonymous: the keeper that applies each Sui batch can see amounts.
- The demo relay signs with a funded testnet key so visitors without a wallet can act. It is rate-limited and capped.
- The tax treatment of converting between wrappers depends on jurisdiction. The protocol does not determine it.

## Submission

[ETHGlobal submission](submission/ethglobal.md) · [Sui submission](submission/sui.md) · [Developer feedback](FEEDBACK.md) · [Demo script](submission/demo-script.md)

## License

[MIT](LICENSE) for Unison code. Dependencies keep their own licenses.
