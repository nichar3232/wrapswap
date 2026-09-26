# Unison MCP — live end-to-end demo

Client: Claude Code 2.1.283 (`claude -p`, headless agent), connected only to the remote Unison MCP server through the public funnel:

```sh
claude -p "Convert 50 AAPL into whichever wrapper is cheapest right now." \
  --mcp-config '{"mcpServers":{"unison":{"type":"http","url":"https://nichars-mac-mini.tail43cacc.ts.net/mcp"}}}' \
  --strict-mcp-config --allowedTools "mcp__unison__list_assets,mcp__unison__get_pool,mcp__unison__quote_convert,mcp__unison__convert,mcp__unison__get_batch" \
  --output-format stream-json --verbose
```

Run at 2026-09-27 02:45 JST (2026-09-26 17:45 UTC). The prompt names no tool; the agent chose get_pool → quote_convert → convert itself.

MCP servers at init: [{"name": "unison", "status": "connected", "source": "dynamic"}]

## Prompt

> Convert 50 AAPL into whichever wrapper is cheapest right now.

_(client loads the Unison tool schemas: `ToolSearch {"query": "select:mcp__unison__list_assets,mcp__unison__get_pool,mcp__unison__quote_convert,mcp__unison__convert", "max_results": 4}`)_

## Step 1: `get_pool`

Arguments:

```json
{
  "asset": "AAPL"
}
```

Result:

```
AAPL skew 18.79%; cheapest now: mcbAAPL → mAAPLx at 2.00 bps; mcbAAPL→mAAPLx 2.00 bps, mAAPLx→mcbAAPL 4.83 bps

{
  "asset": "AAPL",
  "block": "63592294",
  "wrappers": [
    {
      "platform": "Coinbase",
      "symbol": "mcbAAPL",
      "inventory": "8020.55694",
      "inventoryShares": "8120.813901"
    },
    {
      "platform": "xStocks",
      "symbol": "mAAPLx",
      "inventory": "11879.2836983875",
      "inventoryShares": "11879.283698"
    }
  ],
  "totalShares": "20000.0976",
  "skewPct": 18.79,
  "directions": [
    {
      "from": "mcbAAPL",
      "to": "mAAPLx",
      "baseFee": "2.00 bps",
      "skewFee": "0.00 bps",
      "totalFee": "2.00 bps",
      "reducesImbalance": true
    },
    {
      "from": "mAAPLx",
      "to": "mcbAAPL",
      "baseFee": "2.00 bps",
      "skewFee": "2.83 bps",
      "totalFee": "4.83 bps",
      "reducesImbalance": false
    }
  ],
  "cheapDirection": {
    "from": "mcbAAPL",
    "to": "mAAPLx"
  },
  "lpFees": {
    "fills": 7,
    "baseShares": "0.065353",
    "skewShares": "0.032246",
    "totalShares": "0.0976"
  }
}
```

## Step 2: `quote_convert`

Arguments:

```json
{
  "asset": "AAPL",
  "fromWrapper": "mcbAAPL",
  "toWrapper": "mAAPLx",
  "amount": 50
}
```

Result:

```
49.999999 shares mcbAAPL → 49.989999 shares mAAPLx (49.98999995001 mAAPLx); fee 2.00 bps (base 0.009999, skew 0 shares), reduces imbalance

{
  "asset": "AAPL",
  "from": "mcbAAPL",
  "to": "mAAPLx",
  "sharesIn": "49.999999",
  "amountIn": "49.382716 mcbAAPL",
  "sharesOut": "49.989999",
  "amountOut": "49.98999995001 mAAPLx",
  "baseFee": "0.009999",
  "skewFee": "0",
  "totalFee": "2.00 bps",
  "youKeep": "0.999800",
  "reducesImbalance": true,
  "postSkewPct": 18.29,
  "fillable": true,
  "block": "63592298"
}
```

## Step 3: `convert`

Arguments:

```json
{
  "asset": "AAPL",
  "fromWrapper": "mcbAAPL",
  "toWrapper": "mAAPLx",
  "amount": 50
}
```

Result:

```
Converted 49.999999 shares mcbAAPL → 49.98999995001 mAAPLx: 0x8ab08c71d47c6354ad972e0629182d9809dede261af8b5329cf0d4c8f79e482d (https://sepolia.uniscan.xyz/tx/0x8ab08c71d47c6354ad972e0629182d9809dede261af8b5329cf0d4c8f79e482d); fee 2.00 bps = base 0.009999 + skew 0 shares

{
  "asset": "AAPL",
  "from": "mcbAAPL",
  "to": "mAAPLx",
  "sharesIn": "49.999999",
  "amountIn": "49.382716 mcbAAPL",
  "received": "49.98999995001 mAAPLx",
  "sharesOut": "49.989999",
  "totalFee": "2.00 bps",
  "baseFee": "0.009999",
  "skewFee": "0",
  "reducesImbalance": true,
  "feeSplitSource": "on-chain quote at block 63592300, immediately before execution",
  "recipient": "0x8f2e78AbD6E234D7B1CA7047F7502c374C81dA6C",
  "txHash": "0x8ab08c71d47c6354ad972e0629182d9809dede261af8b5329cf0d4c8f79e482d",
  "explorer": "https://sepolia.uniscan.xyz/tx/0x8ab08c71d47c6354ad972e0629182d9809dede261af8b5329cf0d4c8f79e482d"
}
```

## Agent's answer

I converted 50 shares of AAPL from the Coinbase wrapper (mcbAAPL) to the xStocks wrapper (mAAPLx), which was the cheaper one. It went through on Unichain Sepolia.

- **Why xStocks:** the pool was holding more mAAPLx than mcbAAPL (18.79% skew). Converting in that direction pays only the 2 bps base fee because it evens the pool out. Going the other way would have cost 4.83 bps.
- **Sent:** 49.999999 shares, which is 49.382716 mcbAAPL tokens.
- **Received:** 49.989999 shares, which is 49.98999995 mAAPLx tokens.
- **Fee:** 2.00 bps, about 0.01 shares. There was no extra imbalance fee.
- **Pool afterwards:** the skew should have dropped to about 18.29%, based on the quote before the trade.
- **Transaction:** [0x8ab08c71…482d](https://sepolia.uniscan.xyz/tx/0x8ab08c71d47c6354ad972e0629182d9809dede261af8b5329cf0d4c8f79e482d)

You didn't give an address, so the mAAPLx went to the relay's demo account (`0x8f2e78AbD6E234D7B1CA7047F7502c374C81dA6C`), not a wallet of yours. The relay limits each client to 3 actions per 10 minutes and 100 shares per call. Give me your address if you want future conversions sent there.

Run result: success, 5 turns, 20.3 s.
## On-chain verification (independent of the MCP server)

- `cast receipt 0x8ab08c71d47c6354ad972e0629182d9809dede261af8b5329cf0d4c8f79e482d` on Unichain Sepolia: status 1 (success), from the relay account 0x8f2e78AbD6E234D7B1CA7047F7502c374C81dA6C to WrapSwapRouter 0x49d7eA31c619E80785Fa31CBc5bE052ED4EC40Cb.
- ParityHook `Converted` event in the same transaction: sender = recipient = 0x8f2e…dA6C, amountIn 49,382,716 (49.382716 mcbAAPL), sharesOut 49.98999995, baseFee 0.00999999999 shares, skewFee 0, postSkew 0.1829.
- Uniscan: https://sepolia.uniscan.xyz/tx/0x8ab08c71d47c6354ad972e0629182d9809dede261af8b5329cf0d4c8f79e482d
