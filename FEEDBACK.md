# Developer feedback
Work in progress; verified evidence and dependency pins are recorded as integration proceeds.

- Base B20 is a native precompile, not a conventional ERC-20 implementation; generic EVM forks need a compatibility test.
- The build specification assumes 18-decimal issuer units; AAPLc reports 8 decimals, so adapters alone cannot correct raw amount arithmetic.

- v4-core latest release tag is v4.0.0 (e50237c43811bd9b526eff40f26772152a42daba); v4-periphery exposes no release tags, pin commit 9969eec44cfdf07e24b41de47f40276a58401976 instead.
