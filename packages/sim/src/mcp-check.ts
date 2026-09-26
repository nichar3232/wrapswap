// Phase 1 MCP row: the unmodified Unison MCP server against the fork stack. list_assets → get_pool → quote_convert →
// convert (with recipient) → get_batch; the convert's tx is checked on the fork (Converted event, fee split).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { abi, events, pub, PARITY_HOOK, ROOT, agentAddress, read, assets } from "./chain.js";
import { ipProxy, mcpClient } from "./mcp.js";

const proxy = await ipProxy("10.77.0.200", 19301);
const m = await mcpClient("http://127.0.0.1:19301/api");
const lines: string[] = [];
let ok = true;
try {
  const tools = ((await m.client.listTools()).tools as any[]).map((t) => t.name);
  lines.push(`tools: ${tools.join(", ")}`);
  const la = await m.tool("list_assets", {});
  ok &&= !la.isError;
  const gp = await m.tool("get_pool", { asset: "TSLA" });
  ok &&= !gp.isError;
  const q = await m.tool("quote_convert", { asset: "TSLA", fromWrapper: "Coinbase", toWrapper: "xStocks", amount: "20" });
  ok &&= !q.isError;
  const recipient = agentAddress("p1-mcp-recipient");
  const w = assets[2].wrappers.find((x) => x.platform === "xStocks")!;
  const before = await read<bigint>(w.token, abi.erc20, "balanceOf", [recipient]);
  const c = await m.tool("convert", { asset: "TSLA", fromWrapper: "Coinbase", toWrapper: "xStocks", amount: "20", recipient });
  const hash = (c.json?.txHash ?? /0x[0-9a-f]{64}/i.exec(c.text)?.[0]) as `0x${string}` | undefined;
  if (c.isError || !hash) throw Error(`convert: ${c.text.slice(0, 200)}`);
  const receipt = await pub.getTransactionReceipt({ hash });
  const conv = events(receipt.logs, abi.hook, PARITY_HOOK).find((e) => e.eventName === "Converted");
  const got = (await read<bigint>(w.token, abi.erc20, "balanceOf", [recipient])) - before;
  ok &&= receipt.status === "success" && conv?.args.recipient === recipient && got > 0n;
  const b = await m.tool("get_batch", { asset: "AAPL" });
  ok &&= !b.isError;
  lines.push(`list_assets/get_pool/quote_convert/get_batch ok; convert 20 mcbTSLA→mTSLAx to ${recipient.slice(0, 8)}… tx ${hash} (Converted base ${conv?.args.baseFee} + skew ${conv?.args.skewFee}, recipient +${got})`);
} catch (e: any) {
  ok = false;
  lines.push(`error: ${e.message}`);
} finally {
  await m.close();
  proxy.close();
}
const p = resolve(ROOT, "packages/sim/out/phase1.json");
const j = JSON.parse(readFileSync(p, "utf8"));
j.rows = j.rows.filter((r: any) => r.id !== "M1");
j.rows.push({ id: "M1", check: "MCP tools (mcp READY FOR MERGE) against the fork stack", ok, evidence: lines.join("; ") });
writeFileSync(p, JSON.stringify(j, null, 2));
console.log(`${ok ? "PASS" : "FAIL"} M1 ${lines.join("; ")}`);
process.exit(ok ? 0 : 1);
