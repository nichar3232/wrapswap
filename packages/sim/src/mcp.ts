// MCP harness: the Unison MCP server (branch mcp, ~/wrapswap-mcp, READY FOR MERGE) run unmodified over stdio with
// UNISON_API_URL pointed at the fork's web server. Each client gets its own loopback proxy that stamps a distinct
// X-Forwarded-For, which serve-web and the relay trust from loopback: every agent gets its own per-IP relay budget
// exactly as distinct remote users would.
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MCP_DIR = process.env.MCP_DIR ?? resolve(homedir(), "wrapswap-mcp/packages/mcp");
export const WEB = process.env.SIM_WEB ?? "http://127.0.0.1:14010";

export function ipProxy(ip: string, port: number): Promise<Server> {
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await fetch(`${WEB}${req.url}`, {
      method: req.method,
      headers: { "content-type": String(req.headers["content-type"] ?? "application/json"), accept: "application/json", "x-forwarded-for": ip },
      body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks),
    }).catch(() => null);
    if (!r) return void res.writeHead(502).end('{"error":"upstream"}');
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv)));
}

const sdk = (p: string) => import(pathToFileURL(resolve(MCP_DIR, "node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href);

export async function mcpClient(apiUrl: string) {
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");
  const transport = new StdioClientTransport({
    command: resolve(MCP_DIR, "../../node_modules/.bin/tsx"),
    args: [resolve(MCP_DIR, "src/stdio.ts")],
    cwd: MCP_DIR,
    env: { ...process.env, UNISON_API_URL: apiUrl } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "wrapswap-sim", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    async tool(name: string, args: Record<string, unknown>) {
      const r: any = await client.callTool({ name, arguments: args });
      const text = (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
      let json: any = null;
      try {
        json = r.structuredContent ?? JSON.parse(text);
      } catch {
        /* text result */
      }
      return { isError: !!r.isError, text, json };
    },
    close: () => client.close(),
  };
}

/// MCP config for `claude -p --mcp-config`: one stdio Unison server behind this agent's proxy.
export const claudeMcpConfig = (apiUrl: string) => ({
  mcpServers: {
    unison: {
      command: resolve(MCP_DIR, "../../node_modules/.bin/tsx"),
      args: [resolve(MCP_DIR, "src/stdio.ts")],
      env: { UNISON_API_URL: apiUrl },
    },
  },
});
