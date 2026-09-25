# Developer feedback
Work in progress; verified evidence and dependency pins are recorded as integration proceeds.

- Base B20 is a native precompile, not a conventional ERC-20 implementation; generic EVM forks need a compatibility test.
- The build specification assumes 18-decimal issuer units; AAPLc reports 8 decimals, so adapters alone cannot correct raw amount arithmetic.

- v4-core latest release tag is v4.0.0 (e50237c43811bd9b526eff40f26772152a42daba); v4-periphery exposes no release tags, pin commit 9969eec44cfdf07e24b41de47f40276a58401976 instead.
- Actual compatible build pins: core 1.0.2 commit `46c6834698c48bc4a463a86d8420f4eb1d7f3b75`, periphery 1.0.4 commit `9969eec44cfdf07e24b41de47f40276a58401976`. Core's sole release tag v4.0.0 uses nested IPoolManager.SwapParams, while current periphery imports standalone PoolOperation.sol. Publish synchronized tags to avoid this incompatibility.
- v4-template main currently specifies solc 0.8.30 and uses OpenZeppelin uniswap-hooks; WrapSwap retains requested 0.8.26/cancun and the template's Foundry layout/workflow, with direct IHooks implementations.
