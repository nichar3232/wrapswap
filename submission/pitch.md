# WrapSwap pitch

Tokenized Apple shares can arrive through multiple issuers. Their legal claims remain separate, but the trading infrastructure treats each wrapper as its own island. Moving a position between issuers often requires selling one wrapper and buying another, adding a cash leg and fragmenting liquidity.

WrapSwap creates a conversion layer: one uAAPL represents one underlying share. Issuer adapters normalize share multipliers and token decimals. The canonical vault mints against registered wrappers, while a Uniswap v4 ParityHook uses its own ERC-6909 inventory to fill at the share ratio, less transparent fees. When inventory is unavailable, a guarded swap falls through to concentrated liquidity.

As institutional flow arrives, the same stack supports sealed batch orders. DarkCrossHook escrows funds, accepts commitments, reveals orders and crosses compatible flow at a single midpoint. Any selected residual can execute against the lit uAAPL/USDC pool within that settlement transaction. The market-hours calendar and initialized pool TWAP define what happens when the external feed is stale or the regular session is closed.

An intent bridge is the proposed entry path for an Ethereum AAPLx holder: sign once, receive Base uAAPL, and let a filler handle inventory. It is not implemented in this submission. The first design would be optimistic with one relayer; production settlement requires CCIP, a Backed xBridge message, or a storage proof.

The contribution to the Uniswap stack is the combination of custom accounting, claim-backed inventory, dynamic fee overrides, phase gating and atomic residual routing, with a reproducible local fork and explicit compatibility findings. The demo's issuers are mocks; the Uniswap PoolManager and periphery are real forked deployments. Share parity does not erase issuer risk, transfer restrictions or jurisdiction-specific tax treatment.
