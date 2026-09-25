# DarkCross workstream

- Decision: batchOrigin is the deployment block, so phase end blocks are deterministic across deployments.
- Decision: direct IHooks callback selectors (no unavailable BaseHook in periphery 1.0.4); CREATE2 address flags 0x08c0.
- Decision: buy locks cover ceil(qty*price/1e30) plus ceil(5bps cost); stock quantities 18 decimals, USDC 6.
- Decision: cumulative pro-rata allocation conserves exactly the crossed quantity on both sides; buy cost rounds up, sell proceeds down; treasury receives fee/rounding dust as escrow credit.
- Decision: valid reveals with wrong/insufficient collateral drop with no penalty; their collateral unlocks at settlement.
- Decision: every residual executes a real manager.swap within one manager.unlock callback; exact-output buys, exact-input sells; sqrt limit respects both midpoint +/-1% and individual limit. An unfillable residual reverts only its self-call and returns collateral, emitting ResidualSkipped.
- Decision: core suppresses self-hook callbacks; residual explicitly records the post-swap TWAP observation.
- Decision: TWAP stores every distinct-timestamp tick change, 64 entries. It rejects missing 30-minute history rather than fabricating a price; high-frequency activity can evict history. Production should increase capacity or use external fallback.
- Decision: treasury fees stay in escrow, preserving available+locked == token balances for all participants including treasury.
- Decision: nonreveal penalties are apportioned by revealed share quantity, separately per currency, with rounding dust to treasury.
- Decision: production EAS gate verifies Coinbase attester, schema, recipient, UID, expiry and revocation. beforeAddLiquidity's sender is the calling router, so a production attested-router integration is needed; tx.origin is deliberately not trusted.
- Decision: Solidity 0.8.26 uses assembly tload/tstore for the internal-swap transient flag.

## Extra ABI details
`orders(batch,trader)` => `(bytes32 hash,address currency,uint256 locked,bool revealed,bool isBuy,uint256 qty,uint256 limitPx,bool routeResidual,uint256 crossed)`.
`participants(batch)` => address[]. `settled(batch)` => bool. `batchOrigin()` => uint256.
`poolKey()` => `(Currency currency0,Currency currency1,uint24 fee,int24 tickSpacing,IHooks hooks)`.
`requiredBuyLock(qty,price)` => uint256. `priceToSqrt(price)` => uint160. `twapPrice()` => uint256.
`observations(i)` => `(uint64 timestamp,int256 cumulative,int24 tick)`; `observationIndex()` / `observationCount()` uint8.
`ResidualSkipped(uint256 indexed batchId,address indexed trader,bytes reason)` documents isolated limit failure.
`configurePool(key)` owner-only once, AFTER manager.initialize; initializes TWAP from slot0.

## Progress
- 13 DarkCross tests green with a real local PoolManager, including 1000 escrow/pro-rata fuzz runs.
- Fork finding: prank accounts need ETH on this Foundry/Base fork; funding them with vm.deal fixes a zero-gas approve revert. Three-wallet Crossed+RoutedToLit test passes against deployed Base PoolManager 0x498581fF718922c3f8e6A244956aF099B2652b2b.
