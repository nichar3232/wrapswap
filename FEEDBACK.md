# Developer feedback

This is implementation feedback from WrapSwap, a Solidity 0.8.26 / Cancun project integrating custom-accounting parity fills, ERC-6909 inventory, commit-reveal crossing and atomic residual swaps on a Base fork. Evidence links below pin upstream commits; local links identify the resulting implementation. Final execution evidence is tracked in [PROGRESS.md](PROGRESS.md).

## Dependency compatibility

The v4-core release tag `v4.0.0` resolves to `e50237c43811bd9b526eff40f26772152a42daba`. v4-periphery exposes no matching release tags. The compatible build pins are core package 1.0.2 at `46c6834698c48bc4a463a86d8420f4eb1d7f3b75` and periphery package 1.0.4 at `9969eec44cfdf07e24b41de47f40276a58401976`. Package versions are not claimed as Git release tags.

Core's release-tag interface nests `SwapParams` in [IPoolManager.sol](https://github.com/Uniswap/v4-core/blob/e50237c43811bd9b526eff40f26772152a42daba/src/interfaces/IPoolManager.sol), while the compatible periphery expects standalone [PoolOperation.sol](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/types/PoolOperation.sol). Mixing latest release tags with current periphery caused an incompatible import/type surface. Publish synchronized release tags and a tested core/periphery/compiler matrix. [foundry.toml](foundry.toml) records our direct remappings.

The v4-template main configuration observed during ground truth used solc 0.8.30 and OpenZeppelin uniswap-hooks. WrapSwap keeps the requested 0.8.26/Cancun and the template's Foundry layout/workflow, using direct IHooks implementations. A template version selector tied to that compatibility matrix would remove guesswork. This is a template-derived layout, not a claim that untouched current template code compiles under 0.8.26.

## v4-core: custom accounting and fees

[Hooks.sol lines 250–278](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/Hooks.sol#L250-L278) adds the specified hook delta to `amountSpecified`. Fully intercepting exact input therefore needs a positive specified delta; exact output mirrors the signs. A four-case table showing direction × exact input/output, including token decimals and fees, would improve the custom-curve example. Our [ParityHook](contracts/src/ParityHook.sol) tests both modes and uses ERC-6909 claims rather than external transfers inside the callback.

[PoolManager.sol lines 322–336](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/PoolManager.sol#L322-L336) converts claim mint/burn operations into currency deltas. The error for an unsettled unlock is correct but far from the accounting mistake. Add a documented settlement ledger example with four columns: caller delta, hook delta, ERC-20 balance, claim balance. It would make fee retention and withdrawable inventory easier to review.

[LPFeeLibrary.sol lines 15–19](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/LPFeeLibrary.sol#L15-L19) defines dynamic/override flags; [Pool.sol lines 303–304](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/Pool.sol#L303-L304) selects the transaction's fee override. An override does not write the stored slot0 LP fee. The original requested test expected that storage change; we corrected the assertion to actual charged amounts. Document this distinction beside the override example and explicitly distinguish basis points from fee millionths.

[Hooks.sol line 253](https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/Hooks.sol#L253) skips callbacks when the hook itself is the caller. Residual routing must understand this behavior: a hook-internal swap is not evidence that beforeSwap executed and accepted an internal flag. [DarkCrossHook](contracts/src/DarkCrossHook.sol) explicitly handles internal routing and observation updates. Include a callback execution diagram for hook-originated swaps in the docs.

## v4-periphery and HookMiner

[V4Quoter.sol lines 18–32](https://github.com/Uniswap/v4-periphery/blob/9969eec44cfdf07e24b41de47f40276a58401976/src/lens/V4Quoter.sol#L18-L32) explains why quote methods are not view functions. The API uses simulation, not a transaction, for curve quotes. Include a viem `simulateContract` example that preserves custom hook errors and labels inventory-derived quotes separately from simulated curve quotes.

[HookMiner.sol lines 14–38](https://github.com/Uniswap/v4-periphery/blob/9969eec44cfdf07e24b41de47f40276a58401976/test/shared/HookMiner.sol#L14-L38) bounds the salt search and derives addresses using the deployer. The import currently lives under `test/shared`; a supported public utility path and explicit broadcast CREATE2-proxy example would help production scripts. Our [Deploy script](contracts/script/Deploy.s.sol) mines against the proxy address, not the EOA.

PositionManager's action stream and Permit2 approvals require coordinating ERC-20 approval, Permit2 allowance, action encoding and per-currency settlement. [Seed.s.sol](contracts/script/Seed.s.sol) demonstrates the complete fork setup. A minimal runnable example containing all four steps, sorted currencies and mixed 18/6-decimal amounts would be more useful than separate action fragments.

## Deployments/docs and Base-specific findings

The [official deployments page](https://developers.uniswap.org/docs/protocols/v4/deployments) supplied PoolManager, PositionManager, StateView, V4Quoter, Universal Router and Permit2 addresses. The existing [versioned JSON feed](https://developers.uniswap.org/deployments.json) already includes chain IDs and source references. Extend its Base records with deployment blocks, bytecode hashes, and a tested package-compatibility matrix; pin sourceCodeUrl to the sourceRef rather than main. This would make fork checks reproducible without implying that the current feed is absent. [Addresses.sol](contracts/script/Addresses.sol) is our explicit chain-address source.

Base B20 is a native implementation, not ordinary ERC-20 bytecode. Base RPC reads of AAPLc succeed, but generic Anvil returns `OpcodeNotFound`, including the attempted holder-to-contract transfer. This is a fork-runtime incompatibility, not proof of a live transfer allowlist. The fork uses [MockB20](contracts/src/mocks/MockB20.sol) with the identical consumed ERC-20/multiplier/pause surface. Publish an Anvil compatibility note or supported native-precompile shim in Base's B20 integration guide.

The original specification assumed 18-decimal issuer amounts; live AAPLc reports 8. Reading `multiplier()` alone cannot normalize raw amount arithmetic. [Ground truth](docs/ground-truth.md) records the live address, sampled holder, multiplier, transfer test outcome and authoritative sources. Our vault and parity math use token decimals. Add 8/18-decimal wrapper examples to the share-conversion docs.

The verified Base feed prices Coinbase AAPL, has an 86400-second heartbeat and 24/5 feed schedule, and is not a promise of fresh regular-session share price at every block. We require calendar-aware source selection and initialized TWAP history. Production non-unit multipliers also require adjusting token-price feed values into USD/share; this remains a disclosed limitation.

EAS schema matching alone does not establish Coinbase provenance: the trusted attester must match as well. The local demo explicitly bypasses the gate; production callbacks also need clarity on whether the identity is a router, PositionManager, or end user. Provide a router-aware attestation example that cryptographically binds the intended recipient.

## Requested next improvements

1. Synchronized core/periphery/template releases with a compiler matrix and enriched deployment records.
2. A custom-accounting tutorial covering exact output, ERC-6909 fee inventory, mixed decimals and callback bypass.
3. A Base-native B20 fork compatibility fixture and a fully executable PositionManager/Permit2 seeding example.

## Runtime integration finding

The sustained local run hit Node 24.21.0's bundled Undici macOS `setTypeOfService EINVAL` crash and the supervisor correctly stopped the remaining services. This is an upstream runtime issue, not a Uniswap contract failure: [Undici issue 5544](https://github.com/nodejs/undici/issues/5544), [merged fix 5547](https://github.com/nodejs/undici/pull/5547). WrapSwap installs a fixed Undici dispatcher for Node HTTP clients and tests forced socket-QoS failure handling. The browser keeps its native fetch implementation.
