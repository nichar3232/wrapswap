# Unison MCP server

Agent-callable access to Unison on Unichain Sepolia (chain 1301): read the AAPL / NVDA / TSLA conversion pools, quote
share-for-share conversions between issuer wrappers (Coinbase, xStocks), and execute conversions and Dark Cross orders.
All sizes are shares of the stock; there is no USD anywhere.

The server holds no keys and no addresses. It reads the public Unison API (GET routes) and executes through the demo
relay (`POST /demo/*`), which signs with a funded testnet demo account and gives this server its own budget of 20
actions per 10 minutes. The server itself caps every execution at 100 shares.

## Remote (Streamable HTTP)

```
https://nichars-mac-mini.tail43cacc.ts.net/mcp
```

Stateless, JSON responses, POST only, rate-limited per IP (600 requests/min). Claude Code:

```sh
claude mcp add --transport http unison https://nichars-mac-mini.tail43cacc.ts.net/mcp
```

## Local (stdio): Claude Desktop

From a checkout of this repository after `pnpm install`, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "unison": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/ABSOLUTE/PATH/TO/wrapswap/packages/mcp", "start:stdio"]
    }
  }
}
```

Or run it directly: `pnpm --dir packages/mcp start:stdio`. Cursor and other stdio clients take the same command.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_assets` | read | Assets, their issuer wrappers (platform, symbol, address, decimals) and live multipliers (shares per token). |
| `get_pool(asset)` | read | Inventory per wrapper, skew %, fee each direction (base + skew), `cheapDirection`, cumulative LP fees. |
| `quote_convert(asset, fromWrapper, toWrapper, amount)` | read | On-chain quote: sharesOut, baseFee, skewFee, youKeep, reducesImbalance; flags a cheaper reverse direction. |
| `convert(asset, fromWrapper, toWrapper, amount, recipient?)` | executes | Conversion via the relay (`/demo/convert`, or `/demo/send` with a recipient); tx hash, Uniscan link, fee split. |
| `get_batch(asset)` | read | Dark Cross batch: phase, seconds remaining; last settled batch (midpoint, crossed, protocol fee, residual, unfilled). |
| `get_portfolio(address?)` | read | Per asset, the wallet's balance of both wrappers in tokens and shares, plus its 10 most recent fills from the indexer. Omitted address = the demo relay account. |
| `commit_dark_order(asset, side, amount)` | executes | Sealed order via the relay (`/demo/dark-commit`); commit tx, batch id, settlement block. The relay reveals; the crank settles. |
| `send_confidential(asset, amount, recipient, withdrawWrapper?, waitSeconds?)` | executes | Confidential send via the relay (`/demo/send`): ShareVault deposit on Unichain → Seal-encrypted pay on Sui → withdrawal into the other issuer's wrapper. AAPL only; one send at a time. |

Wrappers can be named by token symbol (`mcbAAPL`), platform (`Coinbase`) or address. `amount` is in shares and is
converted to token units with the wrapper's live multiplier. Execution tools reject amounts over 100 shares before
calling the relay and return the relay's error (limit, revert) verbatim on failure.

`send_confidential` (the Sui confidential transfer) is registered only when the Sui lane reports GO; it is live, so
`tools/list` returns eight tools.

## Configuration

| Env | Default | Used by |
| --- | --- | --- |
| `UNISON_API_URL` | `https://nichars-mac-mini.tail43cacc.ts.net/api` | both transports |
| `MCP_PORT`, `MCP_HOST` | `18220`, `127.0.0.1` | HTTP (`pnpm --dir packages/mcp start:http`) |
| `RATE_LIMIT_PER_MIN` | `600` | HTTP (same limiter as `scripts/dev/serve-web.mjs`) |

In the live stack, `scripts/dev/live-up` starts the HTTP server and `scripts/dev/serve-web.mjs` proxies `/mcp` to it.

## Tests

```sh
pnpm --dir packages/mcp test                        # schemas, units, handlers (fake API), MCP tool listing
UNISON_LIVE=1 pnpm --dir packages/mcp test          # plus the read-only integration test against the live API
```
