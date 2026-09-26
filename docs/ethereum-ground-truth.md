# Ethereum AAPLx ground truth

Verified 2026-09-25. These are source and read-only RPC observations, not a deployed Unison bridge.

## Issuer-published identity

The [Backed Finance GitHub organization](https://github.com/backed-fi) is verified for `backed.fi`. Its official [CoW Swap token list, pinned commit 401edae9acf8e14152825864b974635e802ac948](https://github.com/backed-fi/cowswap-xstocks-tokenlist/blob/401edae9acf8e14152825864b974635e802ac948/tokenlist.json#L70737-L70743) explicitly publishes:

| Field | Value |
|---|---|
| Chain | Ethereum, chain ID 1 |
| Contract | `0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a` |
| Name / symbol | Apple xStock / AAPLx |
| Decimals | 18 |
| List version | 7.2.0 |
| List timestamp | 2026-09-24T20:38:13.373Z |

The [issuer product page](https://assets.backed.fi/products/apple-xstock) identifies Apple xStock as the Backed Assets (JE) Limited tracker certificate, ISIN CH1436219187, available in ERC-20 form.

## Ethereum RPC corroboration and large holder

Public RPC used: `https://ethereum-rpc.publicnode.com`. Observed Ethereum block: **26055638**. No API key or private `ETH_RPC` was required.

| Call | Observed result |
|---|---|
| `symbol()(string)` | `AAPLx` |
| `name()(string)` | `Apple xStock` |
| `decimals()(uint8)` | `18` |
| `balanceOf(0x5F7A4c11bde4f218f0025Ef444c369d838ffa2aD)` at block 26055638 | `72886472560138609409145` raw = **72886.472560138609409145 AAPLx** |
| `getCurrentMultiplier()(uint256,uint256,uint256)` at block 26055638 | `(1003269012539818700, 0, 5)` |
| simulated `transfer(0x1111111111111111111111111111111111111111, 1000000000000000000)` from that holder, block 26055638 | `true` |

The holder was independently discovered in [Ethereum Blockscout's token-holder API](https://eth.blockscout.com/api/v2/tokens/0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a/holders), where it was the first result with the same raw balance, and tagged `Backed: Deployer`. The label is explorer metadata; the balance was corroborated directly by RPC. The transfer above was an `eth_call` simulation, not an on-chain transaction or a measured recipient balance change.

Reproduction (read-only):

```sh
cast call 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a 'symbol()(string)' --rpc-url https://ethereum-rpc.publicnode.com
cast call 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a 'decimals()(uint8)' --rpc-url https://ethereum-rpc.publicnode.com
cast call 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a 'balanceOf(address)(uint256)' 0x5F7A4c11bde4f218f0025Ef444c369d838ffa2aD --block 26055638 --rpc-url https://ethereum-rpc.publicnode.com
cast call 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a 'getCurrentMultiplier()(uint256,uint256,uint256)' --block 26055638 --rpc-url https://ethereum-rpc.publicnode.com
cast call 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a 'transfer(address,uint256)(bool)' 0x1111111111111111111111111111111111111111 1000000000000000000 --from 0x5F7A4c11bde4f218f0025Ef444c369d838ffa2aD --block 26055638 --rpc-url https://ethereum-rpc.publicnode.com
```

## Integration consequence: rebasing and rounding

The current multiplier is not 1e18. Backed's published [BackedAutoFeeTokenImplementation](https://github.com/backed-fi/backed-token-contract/blob/main/contracts/BackedAutoFeeTokenImplementation.sol#L254-L270) computes ERC-20 `balanceOf` from internal shares and the multiplier. Its [transfer implementation](https://github.com/backed-fi/backed-token-contract/blob/main/contracts/BackedAutoFeeTokenImplementation.sol#L514-L554) converts the requested amount to internal shares with integer division. Therefore a future intent reactor must measure actual escrow balance changes and account for transfer rounding; it must not blindly assume an exact `amountIn` balance increase or apply a second multiplier to already rebased ERC-20 balances. This is an inference from issuer code plus the live multiplier read; a transfer-to-fresh-contract balance-delta fork test is still required before shipping §5.

## Is issuer-published AAPLx available on Base?

**No Base AAPLx deployment was verified.** The issuer list above publishes AAPLx on chain IDs **1, 56, 196, 999, 5000, 42161, 57073**; there is no AAPLx entry for **8453**, and this version of the list has no Base entries at all. A direct Base RPC `eth_getCode` at the published common EVM address returned **`0x`**, observed alongside Base block **51782063**, using `https://mainnet.base.org`:

```sh
cast code 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a --rpc-url https://mainnet.base.org
# 0x
```

This rules out a contract at that address at the observation time; it does not prove that no bridge or other address exists anywhere. Keep Base issuer 2 explicitly labeled **MockIssuerToken mAAPLx** unless a different issuer-published Base deployment is independently verified. Backed bCOIN is not Apple exposure and cannot substitute for AAPLx.
