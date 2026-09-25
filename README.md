# WrapSwap

WrapSwap is the neutral conversion layer between issuers of the same tokenized stock. Coinbase's tokenized AAPL on Base (B20 standard) and Backed's AAPLx (xStocks) are separate SPV claims on the same Apple share; no issuer redeems the other's token, so one stock trades in siloed pools. WrapSwap moves a position issuer-to-issuer, share-for-share, with no USDC leg: a canonical `uAAPL` minted 1:1 per underlying share from any registered issuer, a Uniswap v4 **ParityHook** that fills swaps between wrappers at exact share-parity from hook-owned inventory (custom accounting), and a Uniswap v4 **DarkCrossHook** that batches sealed orders, crosses them at the oracle midpoint, and routes any residual to the lit pool in the same transaction. A UniswapX-pattern **intent bridge** lets an Ethereum AAPLx holder land in Base uAAPL from one signed order. ParityHook is generic: any wrapper pair on one underlying (WBTC/cbBTC, every future stock issuer). Tax treatment of wrapper conversion is jurisdiction-specific and not determined by the protocol.

The paragraph above is the product specification. The intent bridge is not implemented. Local deployment uses mock issuer tokens because generic Anvil cannot execute Base's native B20 implementation. Contract, API, frontend, and demo verification status is tracked in [PROGRESS.md](PROGRESS.md); do not interpret a deployment script as a completed testnet deployment.

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
| HookMiner + CREATE2 deploy | [contracts/script/Deploy.s.sol](contracts/script/Deploy.s.sol#L59-L59) | 59–59 | Mines permission bits using the CREATE2 proxy as deployer. |
| PositionManager pool init + liquidity | [contracts/script/Seed.s.sol](contracts/script/Seed.s.sol#L53-L67) | 53–67 | Adds actual concentrated positions with MINT_POSITION and SETTLE_PAIR; Deploy initializes pools through PositionManager. |
| V4Quoter/StateView in API | [api/src/routes/index.ts](api/src/routes/index.ts#L30-L180) | 30–180 | Reads state and simulates quotes against deployed contracts. |
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
| Base mainnet fork, chain 8453 | Generated by `make deploy-local` in `deployments/local.json`; ephemeral addresses and public local burner keys |
| Base Sepolia, chain 84532 | Deployment pending deployer funding; no verified addresses claimed |
| Ethereum fork | Intent bridge not shipped; no Ethereum manifest |

FUND ME: `0x094d5923EFC18a97E395b28a97BC4D5bD027dC0c` (Base Sepolia)

## Run locally

Requires Foundry, Node 24, pnpm, local Postgres and an archive-capable Base RPC. Copy `.env.example` to `.env`, set the RPC values, and create database `wrapswap`. Keep `.env` private. The demo generates local deployment data and uses only public fork burner accounts in its wallet selector.

```sh
make install
make test
make demo
# http://localhost:5173 (API :4000, crank :4001)
```

`make demo` starts the Base fork, deploys the hooks, seeds inventory and PositionManager liquidity, executes receipt-checked conversions and a three-wallet crossed/routed batch, then runs the API, crank and web app. Logs live in `logs/`. `DEMO_CHECK=1 make demo` runs finite smoke checks. `make fresh-clone-check` repeats the workflow from a clean temporary clone. The exact integration contract, response JSON, database schema and sequence are in [INTERFACES.md](INTERFACES.md).

`make testnet` targets Base Sepolia with mock issuers and verification. Fund the address above before running it. No tokenized-stock issuer is represented as having endorsed this project.

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

[Developer feedback](FEEDBACK.md) · [Feedback form draft](submission/feedback-form.md) · [Three-minute video script](submission/demo-script.md) · [Pitch](submission/pitch.md)

## License

[MIT](LICENSE) for WrapSwap code. Dependencies retain their own licenses.
