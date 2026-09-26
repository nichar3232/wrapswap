import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "http-smoke", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.argv[2])));
console.log("TOOLS", (await c.listTools()).tools.map((t) => t.name).join(", "));
const r: any = await c.callTool({ name: "get_pool", arguments: { asset: "TSLA" } });
console.log(r.content[0].text.split("\n")[0]);
await c.close();
