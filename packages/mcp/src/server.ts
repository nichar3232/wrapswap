import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UnisonApi } from "./api.js";
import { type ToolDef, allTools } from "./tools.js";

export const SERVER_INFO = { name: "unison", version: "0.1.0" };

export const INSTRUCTIONS =
  "Unison converts one share of a stock between issuer wrappers (Coinbase and xStocks) of the same stock, share for share, " +
  "on Unichain Sepolia. Assets: AAPL, NVDA, TSLA. Everything is denominated in shares, never USD. Typical flow: list_assets → " +
  "get_pool (find cheapDirection) → quote_convert → convert. The fee is 2 bps plus a skew fee only when a conversion deepens " +
  "the pool's imbalance, so the direction that rebalances the pool is cheapest. Dark Cross batches (get_batch, " +
  "commit_dark_order) cross opposite orders at the oracle midpoint for a 1 bp protocol fee.";

/** One MCP server exposing the Unison tools; shared by the stdio and Streamable HTTP entry points. */
export function createUnisonServer(api = new UnisonApi(), tools: ToolDef<any>[] = allTools()): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations },
      (async (args: any) => {
        try {
          const r = await t.run(args ?? {}, api);
          return { content: [{ type: "text", text: `${r.summary}\n\n${JSON.stringify(r.data, null, 2)}` }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text", text: `${t.name} failed: ${(e as Error).message}` }] };
        }
      }) as any,
    );
  }
  return server;
}
