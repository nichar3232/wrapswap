# WrapSwap

WrapSwap is the neutral conversion layer between issuers of the same tokenized stock. Coinbase's tokenized AAPL on Base (B20 standard) and Backed's AAPLx (xStocks) are separate SPV claims on the same Apple share; no issuer redeems the other's token, so one stock trades in siloed pools. WrapSwap moves a position issuer-to-issuer, share-for-share, with no USDC leg: a canonical `uAAPL` minted 1:1 per underlying share from any registered issuer, a Uniswap v4 **ParityHook** that fills swaps between wrappers at exact share-parity from hook-owned inventory (custom accounting), and a Uniswap v4 **DarkCrossHook** that batches sealed orders, crosses them at the oracle midpoint, and routes any residual to the lit pool in the same transaction. A UniswapX-pattern **intent bridge** lets an Ethereum AAPLx holder land in Base uAAPL from one signed order. ParityHook is generic: any wrapper pair on one underlying (WBTC/cbBTC, every future stock issuer). Tax treatment of wrapper conversion is jurisdiction-specific and not determined by the protocol.

The fork application is verified: **36 Solidity tests, 11 application tests, five browser transaction tests, and a clean-clone demo passed**. [Verification record](submission/verification.md) · [Demo receipts](deployments/demo-receipts.json). The product paragraph above includes the unshipped intent bridge. Sepolia deployment is blocked by zero deployer ETH; the bridge remains deferred under the requested build order. Native B20 and issuer 2 are explicit mocks; Uniswap and the Base oracle/USDC are real fork contracts.

## Uniswap stack integration

<!-- integrations:start -->
| Integration | File | Lines | What it does |
| --- | --- | --- | --- |
| beforeSwapReturnDelta parity fill | [contracts/src/ParityHook.sol](contracts/src/ParityHook.sol#L129-L191) | 129–191 | Cancels the core swap with specified/unspecified deltas; charges the parity fee from output. |
| ZERO_DELTA fall-through + peg guard | [contracts/src/ParityHook.sol](contracts/src/ParityHook.sol#L175-L191) | 175–191 | Reads the pool price and rejects deviations above 50 bps before falling through. |
| DYNAMIC_FEE_FLAG + OVERRIDE_FEE_FLAG | [contracts/src/ParityHook.sol](contracts/src/ParityHook.sol#L102-L191) | 102–191 | Requires dynamic pools and returns a fee override in millionths (bps × 100). |
| ERC-6909 claims inventory | [contracts/src/ParityHook.sol](contracts/src/ParityHook.sol#L67-L101) | 67–101 | Deposits settle ERC-20 and mint claims; withdrawals burn claims and take ERC-20. |
| afterSwap TWAP oracle | [contracts/src/DarkCrossHook.sol](contracts/src/DarkCrossHook.sol#L291-L342) | 291–342 | Records a 64-observation tick accumulator and computes a 30-minute midpoint fallback. |
| unlock/unlockCallback/swap residual routing | [contracts/src/DarkCrossHook.sol](contracts/src/DarkCrossHook.sol#L464-L547) | 464–547 | Settles residual swaps against escrow within the batch settlement transaction. |
| Phase-gated beforeSwap | [contracts/src/DarkCrossHook.sol](contracts/src/DarkCrossHook.sol#L279-L290) | 279–290 | Rejects external lit swaps during Settle; hook routing uses the internal path. |
| beforeInitialize pool validation | [contracts/src/ParityHook.sol](contracts/src/ParityHook.sol#L102-L115) | 102–115 | Checks the dynamic fee flag, canonical side, and registered active issuer. |
| HookMiner + CREATE2 deploy | [contracts/script/Deploy.s.sol](contracts/script/Deploy.s.sol#L112-L120) | 112–120 | Mines permission bits using the CREATE2 proxy as deployer. |
| PositionManager pool init + liquidity | [contracts/script/Seed.s.sol](contracts/script/Seed.s.sol#L143-L168) | 143–168 | Adds actual concentrated positions with MINT_POSITION and SETTLE_PAIR; Deploy initializes pools through PositionManager. |
| V4Quoter/StateView in API | [api/src/routes/index.ts](api/src/routes/index.ts#L31-L181) | 31–181 | Reads state and simulates quotes against deployed contracts. |
| PoolSwapTest in frontend | [web/src/main.tsx](web/src/main.tsx#L406-L420) | 406–420 | Executes parity swaps through the deployed v4 test router on the local fork. |
<!-- integrations:end -->

Regenerate references after source edits with `python3 docs/update-references.py --check`. PoolManager, PositionManager, StateView, V4Quoter and Permit2 come from the official Base deployments; the PoolManager is not mocked.

## Architecture

```mermaid
flowchart LR
  UI[React wallet / public fork burners] --> API[Fastify / viem]
  API --> PG[(Local Postgres event projections)]
  UI --> V[CanonicalStock uAAPL]
  R[IssuerRegistry + share adapters] --> V
  R --> P[ParityHook]
  V --> P
  P --> PM[Uniswap v4 PoolManager]
  PM --> I[ERC-6909 inventory claims]
  UI --> D[DarkCrossHook escrow / sealed batches]
  C[Permissionless crank] --> D
  D --> PM
  O[Chainlink / 30-minute pool TWAP] --> D
  N[NYSE calendar] --> P
  N --> D
  PM --> API
```

Issuer amounts use each token's decimals. Canonical shares and USD/share prices use 18 decimals, while USDC uses 6. Minting has no fee; redemption retains 5 bps. Parity fees are 2 bps plus inventory skew and an off-hours component. The vault enforces backing after its mutations. Arbitrary downward issuer repricing can reduce existing backing, so a changing multiplier remains an issuer trust assumption.

DarkCross commits hide order parameters until Reveal, while the selected escrow currency and lock amount remain public. Each 20-block batch has 12 Commit, 6 Reveal and 2 Settle blocks. Matching uses one midpoint, charges 5 bps per side, and attempts selected residuals in the same transaction. An unavailable or failing residual is unlocked rather than blocking all participants. The 64-participant cap bounds settlement work. The demo disables the EAS gate explicitly.

## Deployments

| Network | Status / manifest |
| --- | --- |
| Unichain Sepolia, chain 1301 | **Live.** Deployed, verified on Uniscan and seeded; `deployments/unichain-sepolia.json` (the default `NETWORK`) |
| Local anvil stack | Offline backup: `scripts/dev/up` generates `deployments/anvil.json` with public anvil keys |
| Ethereum fork | Intent bridge not shipped; no Ethereum manifest |

<!-- testnet:start -->
Unichain Sepolia (chain 1301). Manifest: [`deployments/unichain-sepolia.json`](deployments/unichain-sepolia.json), deploy commit `22ef482`, start block 63572662, pool id `0x402eaf025f43466fcd7d1a145802a0b837428e799fc01ba61a77a09af0d68c20`. Eligibility runs with `demoMode` on (testnet).

| Contract | Address | Uniscan (source) |
| --- | --- | --- |
| ParityHook | `0x1D2C9335813B8d3fFDCCC9d43aAf73d7871b20c8` | [verified](https://sepolia.uniscan.xyz/address/0x1D2C9335813B8d3fFDCCC9d43aAf73d7871b20c8#code) |
| DarkCrossHook | `0x9E358e72018B776F22fEf71bd07cD9e8bC4b790e` | [verified](https://sepolia.uniscan.xyz/address/0x9E358e72018B776F22fEf71bd07cD9e8bC4b790e#code) |
| WrapSwapRouter | `0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3` | [verified](https://sepolia.uniscan.xyz/address/0x9C4Fc24f99C2E0212F6d6562b8A417952ef3Eba3#code) |
| IssuerRegistry | `0xA5d433FA4E90D21859B325Be34F0B8845F8E9070` | [verified](https://sepolia.uniscan.xyz/address/0xA5d433FA4E90D21859B325Be34F0B8845F8E9070#code) |
| NyseCalendar | `0x70396f1Be86e3d7F70C017cbbe69efED861387A1` | [verified](https://sepolia.uniscan.xyz/address/0x70396f1Be86e3d7F70C017cbbe69efED861387A1#code) |
| EASEligibility | `0x85ABBc06C69D9426907352034a5A7C3D30EB5C5A` | [verified](https://sepolia.uniscan.xyz/address/0x85ABBc06C69D9426907352034a5A7C3D30EB5C5A#code) |
| MockPriceOracle | `0xBe2fb3259454F35bC5999f345873c870b5DE3dB1` | [verified](https://sepolia.uniscan.xyz/address/0xBe2fb3259454F35bC5999f345873c870b5DE3dB1#code) |
| B20MultiplierAdapter (mcbAAPL) | `0xc3bE8635F1CB05aBCd5DF001157aAb9349184828` | [verified](https://sepolia.uniscan.xyz/address/0xc3bE8635F1CB05aBCd5DF001157aAb9349184828#code) |
| XStocksMultiplierAdapter (mAAPLx) | `0x577C983f0c3cf3868d543C1c4cbb2807B65ddA78` | [verified](https://sepolia.uniscan.xyz/address/0x577C983f0c3cf3868d543C1c4cbb2807B65ddA78#code) |
| MockIssuerToken mcbAAPL (6 dec) | `0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c` | [verified](https://sepolia.uniscan.xyz/address/0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c#code) |
| MockIssuerToken mAAPLx (18 dec) | `0x433DAfF77AD96b9319957D83d9d422E70c996C45` | [verified](https://sepolia.uniscan.xyz/address/0x433DAfF77AD96b9319957D83d9d422E70c996C45#code) |
| PoolSwapTest | `0x8525eD020Aa0CEa75884546b834d1eb40D3987b3` | [verified](https://sepolia.uniscan.xyz/address/0x8525eD020Aa0CEa75884546b834d1eb40D3987b3#code) |
| PoolModifyLiquidityTest | `0x57428942dEC15511cE19700877001813EE5fE81d` | [verified](https://sepolia.uniscan.xyz/address/0x57428942dEC15511cE19700877001813EE5fE81d#code) |

Canonical Uniswap v4 (from Uniswap's deployment docs): PoolManager [`0x00B036B58a818B1BC34d502D3fE730Db729e62AC`](https://sepolia.uniscan.xyz/address/0x00B036B58a818B1BC34d502D3fE730Db729e62AC), V4Quoter [`0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472`](https://sepolia.uniscan.xyz/address/0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472), StateView [`0xc199F1072a74D4e905ABa1A84d9a45E2546B6222`](https://sepolia.uniscan.xyz/address/0xc199F1072a74D4e905ABa1A84d9a45E2546B6222), PositionManager [`0xf969Aee60879C54bAAed9F3eD26147Db216Fd664`](https://sepolia.uniscan.xyz/address/0xf969Aee60879C54bAAed9F3eD26147Db216Fd664). EAS: OP-stack predeploy `0x4200000000000000000000000000000000000021`.

Swap proofs (100 mcbAAPL → mAAPLx through `WrapSwapRouter.swapExactIn`):

- Deployer 0xFD42…3F9e (101.10227625 mAAPLx out): [`0x9b989f6b2494ad76114315fd5f9a0c1cac8bb59d5de820759eee9b14dfc2ef30`](https://sepolia.uniscan.xyz/tx/0x9b989f6b2494ad76114315fd5f9a0c1cac8bb59d5de820759eee9b14dfc2ef30)
<!-- testnet:end -->

## Run locally

Requires Foundry, Node 24, pnpm, local Postgres and an archive-capable Base RPC. Copy `.env.example` to `.env`, set the RPC values, and create database `wrapswap`. Keep `.env` private. The demo generates local deployment data and uses only public fork burner accounts in its wallet selector.

```sh
make install
make test
make demo
# http://localhost:5173 (API :4000, crank :4001)
```

`make demo` starts the Base fork, deploys the hooks, seeds inventory and PositionManager liquidity, starts the API/crank/web supervisor, then executes receipt-checked conversions and a three-wallet crossed/routed batch. The services remain running after the successful summary. Logs live in `logs/`. `DEMO_CHECK=1 make demo` runs finite smoke checks. `make fresh-clone-check` repeats the workflow from a clean temporary clone. The exact integration contract, response JSON, database schema and sequence are in [INTERFACES.md](INTERFACES.md).

`make testnet` targets Unichain Sepolia with mock issuers and verification (explorer: [sepolia.uniscan.xyz](https://sepolia.uniscan.xyz)). No tokenized-stock issuer is represented as having endorsed this project.

## Ground truth and mocks

See [the research and fork compatibility test](docs/ground-truth.md).

| Dependency | Observed behavior / demo treatment |
| --- | --- |
| Coinbase AAPLc on Base | Native B20 at `0xb200000000000000000000C2e324d24d7eEcd1fb`; 8 decimals, `multiplier()` normalized to 1e18. Generic Anvil returns `OpcodeNotFound`, including the attempted holder transfer. This does not prove transfers are allowlisted. Explicit 8-decimal `MockB20` implements the consumed surface. |
| Issuer 2 | No issuer-published Base AAPL wrapper was verified. Uses `MockIssuerToken` mAAPLx, 18 decimals. Base bCOIN is a different stock and is not used as Apple backing. |
| Uniswap v4 | Real deployed Base contracts on the fork; direct IHooks implementation and mined hook addresses. |
| Chainlink | Base Coinbase AAPL/USD at `0x787f13dEa48Db0897CbCDD985de77809D837F988`, 8 decimals, 86400-second heartbeat and 24/5 market schedule. Outside regular NYSE hours or when stale, settlement requires a sufficiently initialized pool TWAP. The token-price feed requires multiplier adjustment before non-unit B20 production use. |
| EAS | Base `0x4200000000000000000000000000000000000021`; verified account schema `0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9`. Production checks include the trusted Coinbase attester; the local demo has `demoMode=true`. |
| USDC | Native Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals; fork seeding impersonates a funded holder. Sepolia uses a mock. |
| Intent bridge | Not implemented; Bridge tab stays hidden without an Ethereum deployment manifest. Proposed trust model: optimistic, single relayer; production = CCIP / Backed xBridge message or storage proof. |

## Roadmap

First harden accounting and oracle normalization with independent security review and live native-B20 compatibility testing. Then replace commit-reveal with FHE matching, use CCA to bootstrap new uAAPL/USDC pools at a discovered price, and build a CCIP/xBridge-backed intent bridge for Ethereum AAPLx holders. Preserve issuer-specific redemption and legal risk disclosure alongside canonical share units.

## Submission

[Verification record](submission/verification.md) · [Live UI screenshot](submission/app-screenshot.png) · [Developer feedback](FEEDBACK.md) · [Feedback form draft](submission/feedback-form.md) · [Three-minute video script](submission/demo-script.md) · [Pitch](submission/pitch.md)

## License

[MIT](LICENSE) for WrapSwap code. Dependencies retain their own licenses.
