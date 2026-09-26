// Streamable HTTP entry point (stateless, JSON responses) for remote MCP clients. Mounted at /mcp; behind the Unison
// funnel it is reached through scripts/dev/serve-web.mjs (or directly), both applying the shared per-IP rate limit.
// Env: MCP_PORT (default 18220), MCP_HOST (default 127.0.0.1), UNISON_API_URL, RATE_LIMIT_PER_MIN.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLimiter } from "../../../scripts/dev/rate-limit.mjs";
import { UnisonApi } from "./api.js";
import { createUnisonServer } from "./server.js";
import { toolsFor } from "./registry.js";

const limited = createLimiter();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw Error("body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

export function mcpHandler(api = new UnisonApi()) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, api: api.base }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    if (limited(req, res)) return;
    if (req.method !== "POST") {
      // Stateless server: no server-initiated streams or sessions.
      res.writeHead(405, { "content-type": "application/json", allow: "POST" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }),
      );
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }),
      );
      return;
    }
    const server = createUnisonServer(api, toolsFor());
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MCP_PORT || 18220);
  const host = process.env.MCP_HOST || "127.0.0.1";
  const api = new UnisonApi();
  createServer(mcpHandler(api)).listen(port, host, () =>
    console.log(`unison mcp (streamable http, stateless) on http://${host}:${port}/mcp -> ${api.base}`),
  );
}
