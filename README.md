# WrapSwap

WrapSwap is the neutral conversion layer between issuers of the same tokenized stock. Coinbase's tokenized AAPL on Base (B20 standard) and Backed's AAPLx (xStocks) are separate SPV claims on the same Apple share; no issuer redeems the other's token, so one stock trades in siloed pools. WrapSwap moves a position issuer-to-issuer, share-for-share, with no USDC leg: a canonical `uAAPL` minted 1:1 per underlying share from any registered issuer, a Uniswap v4 **ParityHook** that fills swaps between wrappers at exact share-parity from hook-owned inventory (custom accounting), and a Uniswap v4 **DarkCrossHook** that batches sealed orders, crosses them at the oracle midpoint, and routes any residual to the lit pool in the same transaction. A UniswapX-pattern **intent bridge** lets an Ethereum AAPLx holder land in Base uAAPL from one signed order. ParityHook is generic: any wrapper pair on one underlying (WBTC/cbBTC, every future stock issuer). Tax treatment of wrapper conversion is jurisdiction-specific and not determined by the protocol.

**Build status:** implementation and integration are in progress. The product paragraph above is the requested product specification; it is not a claim that every section is shipped. See [PROGRESS.md](PROGRESS.md). The bridge is not implemented yet. Base B20 does not execute in generic Anvil; the fork demo uses an explicit 8-decimal MockB20 and mock issuer2. See [ground truth](docs/ground-truth.md).

FUND ME: `0x094d5923EFC18a97E395b28a97BC4D5bD027dC0c` (Base Sepolia)

## Uniswap stack integration
Integration table will be generated from the final verified source tree.

## Run
`make install`, `make test`, `make demo`. Final demo verification pending.

## Feedback
[FEEDBACK.md](FEEDBACK.md)

## License
MIT for WrapSwap code; dependencies retain their own licenses.
