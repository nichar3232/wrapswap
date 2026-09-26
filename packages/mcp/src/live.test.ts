// Integration test against the live public API (runs when UNISON_LIVE=1). Read-only: no relay POSTs.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UnisonApi } from "./api.js";
import { createUnisonServer } from "./server.js";
import { toolsFor } from "./registry.js";
import { suiGo } from "./tools.js";

describe.runIf(process.env.UNISON_LIVE === "1")("live API", () => {
  it("reads pools and quotes the cheap direction for every asset over MCP", async () => {
    const api = new UnisonApi();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createUnisonServer(api, toolsFor()).connect(a);
    const client = new Client({ name: "live", version: "0" });
    await client.connect(b);
    const assets: any = await client.callTool({ name: "list_assets", arguments: {} });
    expect(assets.isError).toBeFalsy();
    const list = JSON.parse(assets.content[0].text.split("\n\n")[1]);
    expect(list.map((x: any) => x.asset)).toEqual(expect.arrayContaining(["AAPL", "NVDA", "TSLA"]));
    for (const { asset } of list) {
      const pool: any = await client.callTool({ name: "get_pool", arguments: { asset } });
      expect(pool.isError).toBeFalsy();
      const p = JSON.parse(pool.content[0].text.split("\n\n")[1]);
      const { from, to } = p.cheapDirection;
      const q: any = await client.callTool({ name: "quote_convert", arguments: { asset, fromWrapper: from, toWrapper: to, amount: "10" } });
      expect(q.isError).toBeFalsy();
      const d = JSON.parse(q.content[0].text.split("\n\n")[1]);
      expect(d.reducesImbalance).toBe(true);
      expect(Number(d.skewFee)).toBe(0);
      expect(d.cheaperReverse).toBeUndefined();
      expect(Number(d.sharesOut)).toBeLessThan(10);
      expect(Number(d.sharesOut)).toBeGreaterThan(9.99);
    }
    // send_confidential is exposed exactly when the Sui lane is GO; the relay's /demo/send is live (tracking 404s cleanly).
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.includes("send_confidential")).toBe(suiGo());
    const status = await api.get<any>("/demo/status");
    expect(status.ok).toBe(true);
    expect(status.sui).toBeTruthy();
    await expect(api.get("/demo/send/does-not-exist")).rejects.toMatchObject({ status: 404 });
    const batch: any = await client.callTool({ name: "get_batch", arguments: { asset: "AAPL" } });
    expect(batch.isError).toBeFalsy();
    await client.close();
  }, 60_000);
});
