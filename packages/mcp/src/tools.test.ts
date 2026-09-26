import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UnisonApi, errorMessage } from "./api.js";
import { createUnisonServer } from "./server.js";
import { toolsFor } from "./registry.js";
import {
  RELAY_CAP_SHARES,
  allTools,
  commitDarkOrder,
  convert,
  executionTools,
  getBatch,
  getPool,
  listAssets,
  quoteConvert,
  readTools,
  resolveWrapper,
  suiGo,
} from "./tools.js";
import { formatUnits, parseUnits, tokensForShares } from "./units.js";

// ---------------------------------------------------------------- fake API (shapes of the live routes)

const ASSETS = {
  assets: [
    {
      asset: "AAPL",
      platforms: [
        { platform: "Coinbase", symbol: "mcbAAPL", address: "0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c", decimals: 6, sharesPerTokenX18: "1012500000000000000", healthy: true },
        { platform: "xStocks", symbol: "mAAPLx", address: "0x433DAfF77AD96b9319957D83d9d422E70c996C45", decimals: 18, sharesPerTokenX18: "1000000000000000000", healthy: true },
      ],
      darkCross: { hook: "0xBac8C71CfbB1101221cb4699533d79Df188C4898", baseToken: "0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c", quoteToken: "0x433DAfF77AD96b9319957D83d9d422E70c996C45", batchBlocks: 20 },
    },
  ],
};
const POOL = {
  asset: "AAPL",
  block: "1",
  wrappers: [
    { platform: "Coinbase", symbol: "mcbAAPL", address: "0xaD46d8fE371EED0F68c90eb8A252C34147C2e23c", inventory: "8000000000", inventoryShares: "8100000000000000000000" },
    { platform: "xStocks", symbol: "mAAPLx", address: "0x433DAfF77AD96b9319957D83d9d422E70c996C45", inventory: "12000000000000000000000", inventoryShares: "12000000000000000000000" },
  ],
  totalShares: "20100000000000000000000",
  skewX18: "194029850746268656",
  skewPct: "19.40",
  directions: [
    { from: "mcbAAPL", to: "mAAPLx", skewFeePips: 0, totalPips: 200, totalBps: "2.00", reducesImbalance: true },
    { from: "mAAPLx", to: "mcbAAPL", skewFeePips: 291, totalPips: 491, totalBps: "4.91", reducesImbalance: false },
  ],
  cheapDirection: { from: "mcbAAPL", to: "mAAPLx" },
  lpFees: { fills: 3, baseShares: "20250000000000000", skewShares: "31400000000000000", totalShares: "51650000000000000" },
};

type Call = { method: string; url: URL; body?: any };
function fakeApi(overrides: Record<string, (c: Call) => { status?: number; body: unknown }> = {}) {
  const calls: Call[] = [];
  const fetcher = (async (input: any, init: any) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const path = url.pathname.replace(/^\/api/, "");
    const defaults: Record<string, (c: Call) => { status?: number; body: unknown }> = {
        "GET /assets": () => ({ body: ASSETS }),
        "GET /pool/AAPL": () => ({ body: POOL }),
        "GET /quote": (c: Call) => ({
          body: {
            block: "1",
            fillable: true,
            amountIn: c.url.searchParams.get("amount"),
            amountOut: "49968850000000000000",
            sharesIn: "50000000000000000000",
            sharesOut: "49975450000000000000",
            baseFee: "10000000000000000",
            skewFee: "14550000000000000",
            youKeep: "0.999509",
            reducesImbalance: false,
            postSkewX18: "199000000000000000",
            fee: { basePips: 200, skewPips: 291, totalPips: 491, totalBps: "4.91", reducesImbalance: false, postSkewX18: "199000000000000000" },
          },
        }),
        "GET /batches/current": () => ({ body: { batchId: "271", phase: "COMMIT", phaseEndsBlock: "5432", blockNumber: "5424", batchOrigin: "0", secondsRemaining: 8, participants: 0, oracle: { midX18: "1012500000000000000", stale: false } } }),
        "GET /batches": () => ({ body: [{ batchId: "17", midX18: "1012500000000000000", crossedShares: "50625000000000000000", protocolFeeShares: "10125000000000000", residualFilled: [{ trader: "0x1", feeShares: "2025000000000000", txHash: "0xabc" }], unfilledRefunded: { shares: "0" }, participants: 2, settledTx: "0x5bfc" }] }),
      };
    const route = overrides[`${call.method} ${path}`] ?? defaults[`${call.method} ${path}`];
    if (!route) return new Response('{"error":"not found"}', { status: 404 });
    const r = route(call);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { api: new UnisonApi("https://unison.test/api", fetcher), calls };
}

const text = (r: any) => r.content[0].text as string;

// ---------------------------------------------------------------- schemas

describe("tool schemas", () => {
  it("registers exactly the documented tools, read-only ones annotated", () => {
    expect(readTools.map((t) => t.name)).toEqual(["list_assets", "get_pool", "quote_convert", "get_batch"]);
    expect(executionTools.map((t) => t.name)).toEqual(["convert", "commit_dark_order"]);
    for (const t of readTools) expect(t.annotations.readOnlyHint).toBe(true);
    for (const t of executionTools) expect(t.annotations.readOnlyHint).toBe(false);
    for (const t of allTools()) {
      expect(t.description.length).toBeGreaterThan(150);
      expect(t.description).toMatch(/share/i);
    }
  });

  it("validates arguments", () => {
    const q = z.object(quoteConvert.inputSchema);
    expect(q.safeParse({ asset: "AAPL", fromWrapper: "Coinbase", toWrapper: "mAAPLx", amount: "50" }).success).toBe(true);
    expect(q.safeParse({ asset: "AAPL", fromWrapper: "Coinbase", toWrapper: "mAAPLx", amount: 12.5 }).success).toBe(true);
    expect(q.safeParse({ asset: "AAPL", fromWrapper: "Coinbase", amount: "50" }).success).toBe(false);
    const c = z.object(convert.inputSchema);
    expect(c.safeParse({ asset: "AAPL", fromWrapper: "a", toWrapper: "b", amount: "1", recipient: "0x1234" }).success).toBe(false);
    expect(c.safeParse({ asset: "AAPL", fromWrapper: "a", toWrapper: "b", amount: "1", recipient: "0x" + "ab".repeat(20) }).success).toBe(true);
    const d = z.object(commitDarkOrder.inputSchema);
    expect(d.safeParse({ asset: "AAPL", side: "sell", amount: "10" }).success).toBe(true);
    expect(d.safeParse({ asset: "AAPL", side: "short", amount: "10" }).success).toBe(false);
    expect(z.object(getPool.inputSchema).safeParse({}).success).toBe(false);
  });

  it("lists the tools over MCP (in-memory transport)", async () => {
    const { api } = fakeApi();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createUnisonServer(api, toolsFor(false));
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["commit_dark_order", "convert", "get_batch", "get_pool", "list_assets", "quote_convert"]);
    const q = tools.find((t) => t.name === "quote_convert")!;
    expect(q.inputSchema.required).toEqual(["asset", "fromWrapper", "toWrapper", "amount"]);
    const r: any = await client.callTool({ name: "get_pool", arguments: { asset: "aapl" } });
    expect(text(r)).toContain("cheapest now: mcbAAPL → mAAPLx at 2.00 bps");
    await client.close();
  });
});

// ---------------------------------------------------------------- units

describe("units", () => {
  it("is exact", () => {
    expect(parseUnits("50", 18)).toBe(50n * 10n ** 18n);
    expect(parseUnits("0.123456789", 6)).toBe(123456n);
    expect(parseUnits(12.5, 18)).toBe(125n * 10n ** 17n);
    expect(() => parseUnits("-1", 18)).toThrow();
    expect(() => parseUnits("1e3", 18)).toThrow();
    expect(formatUnits(50614875000000000000n, 18)).toBe("50.614875");
    expect(tokensForShares(50n * 10n ** 18n, 1012500000000000000n, 6)).toBe(49382716n);
  });
});

// ---------------------------------------------------------------- handlers

describe("read tools", () => {
  it("resolves wrappers by symbol, platform or address", () => {
    const a = ASSETS.assets[0] as any;
    expect(resolveWrapper(a, "coinbase").symbol).toBe("mcbAAPL");
    expect(resolveWrapper(a, "MAAPLX").symbol).toBe("mAAPLx");
    expect(resolveWrapper(a, "0x433daff77ad96b9319957d83d9d422e70c996c45").symbol).toBe("mAAPLx");
    expect(() => resolveWrapper(a, "mcbNVDA")).toThrow(/not a AAPL wrapper/);
  });

  it("list_assets reports multipliers", async () => {
    const { api } = fakeApi();
    const r = await listAssets.run({}, api);
    expect(r.summary).toBe("AAPL: mcbAAPL (Coinbase, ×1.0125) / mAAPLx (xStocks, ×1)");
  });

  it("quote_convert sends token units and flags the cheaper reverse direction", async () => {
    const { api, calls } = fakeApi();
    const r: any = await quoteConvert.run({ asset: "AAPL", fromWrapper: "xStocks", toWrapper: "Coinbase", amount: "50" }, api);
    const q = calls.find((c) => c.url.pathname.endsWith("/quote"))!;
    expect(q.url.searchParams.get("from")).toBe("mAAPLx");
    expect(q.url.searchParams.get("amount")).toBe("50000000000000000000"); // 50 shares of a ×1 18-dec wrapper
    expect(r.data.sharesOut).toBe("49.97545");
    expect(r.data.skewFee).toBe("0.01455");
    expect(r.data.cheaperReverse.from).toBe("mcbAAPL");
    expect(r.summary).toMatch(/cheaper right now \(2\.00 bps vs 4\.91 bps\)/);
  });

  it("get_batch reports the current phase and the last settled batch", async () => {
    const { api } = fakeApi();
    const r: any = await getBatch.run({ asset: "AAPL" }, api);
    expect(r.data.current.phase).toBe("COMMIT");
    expect(r.data.lastSettled.crossedShares).toBe("50.625");
    expect(r.data.lastSettled.protocolFeeShares).toBe("0.010125");
    expect(r.data.lastSettled.explorer).toBe("https://sepolia.uniscan.xyz/tx/0x5bfc");
  });

  it("unknown asset lists the available ones", async () => {
    const { api } = fakeApi();
    await expect(getPool.run({ asset: "MSFT" }, api)).rejects.toThrow("Unknown asset \"MSFT\". Available: AAPL.");
  });
});

describe("execution tools", () => {
  it("enforce the relay cap before any POST", async () => {
    const { api, calls } = fakeApi();
    await expect(
      convert.run({ asset: "AAPL", fromWrapper: "mcbAAPL", toWrapper: "mAAPLx", amount: String(RELAY_CAP_SHARES + 1) } as any, api),
    ).rejects.toThrow(/at most 100 shares/);
    await expect(commitDarkOrder.run({ asset: "AAPL", side: "sell", amount: "100.000001" } as any, api)).rejects.toThrow(/at most 100/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("convert posts whole tokens to /demo/convert and returns the tx link and fee split", async () => {
    const { api, calls } = fakeApi({
      "POST /demo/convert": () => ({ body: { asset: "AAPL", from: "mcbAAPL", to: "mAAPLx", amountIn: "49382716", sharesIn: "49999999950000000000", quotedOut: "49989875000000000000", feeBps: "2.00", recipient: "0xRelay", approveTx: null, txHash: "0xdead" } }),
    });
    const r: any = await convert.run({ asset: "AAPL", fromWrapper: "mcbAAPL", toWrapper: "mAAPLx", amount: "50" } as any, api);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url.pathname).toBe("/api/demo/convert");
    expect(post.body).toEqual({ asset: "AAPL", from: "mcbAAPL", to: "mAAPLx", amount: "49.382716" });
    expect(r.data.explorer).toBe("https://sepolia.uniscan.xyz/tx/0xdead");
    expect(r.data.received).toBe("49.989875 mAAPLx");
    expect(r.data.totalFee).toBe("2.00 bps");
    expect(r.data.baseFee).toBe("0.01");
    expect(r.data.feeSplitSource).toMatch(/on-chain quote at block 1/);
  });

  it("convert with a recipient uses /demo/send-unichain", async () => {
    const to = "0x" + "12".repeat(20);
    const { api, calls } = fakeApi({ "POST /demo/send-unichain": () => ({ body: { txHash: "0xbeef", recipient: to } }) });
    const r: any = await convert.run({ asset: "AAPL", fromWrapper: "mcbAAPL", toWrapper: "mAAPLx", amount: "1", recipient: to } as any, api);
    expect(calls.find((c) => c.method === "POST")!.body.recipient).toBe(to);
    expect(r.data.recipient).toBe(to);
  });

  it("commit_dark_order sells the base wrapper on 'sell' and reports settlement timing", async () => {
    const { api, calls } = fakeApi({
      "POST /demo/dark-commit": () => ({ body: { asset: "AAPL", batchId: "271", side: "sellBase", amountIn: "9876543", sharesIn: "9999999787500000000", limitPriceX18: "1010475000000000000", fundTx: null, txHash: "0xc0", reveal: "automatic" } }),
    });
    const r: any = await commitDarkOrder.run({ asset: "AAPL", side: "sell", amount: "10" } as any, api);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ asset: "AAPL", from: "mcbAAPL", amount: "9.876543" });
    expect(r.data.settlesAtBlock).toBe("5438"); // (271 + 1) * 20 - 2
    expect(r.data.settlesInSeconds).toBe(14);
    expect(r.data.limitPrice).toBe("1.010475");
  });

  it("surface the relay's real reason", async () => {
    const { api } = fakeApi({
      "POST /demo/convert": () => ({ status: 502, body: { error: { code: "REVERTED", message: "transaction reverted: 0xabc" } } }),
    });
    await expect(
      convert.run({ asset: "AAPL", fromWrapper: "mcbAAPL", toWrapper: "mAAPLx", amount: "5" } as any, api),
    ).rejects.toThrow("Relay rejected the order: REVERTED: transaction reverted: 0xabc");
    expect(errorMessage({ error: "x", revertReason: "y" })).toBe("x: y");
  });

  it("report a relay that is not live", async () => {
    const { api } = fakeApi();
    await expect(commitDarkOrder.run({ asset: "AAPL", side: "buy", amount: "5" } as any, api)).rejects.toThrow(/not live yet/);
    const { api: limitedApi } = fakeApi({ "POST /demo/dark-commit": () => ({ status: 429, body: { error: { code: "RATE_LIMITED", message: "3 demo actions per 10 minutes" } } }) });
    await expect(commitDarkOrder.run({ asset: "AAPL", side: "buy", amount: "5" } as any, limitedApi)).rejects.toThrow("RATE_LIMITED: 3 demo actions per 10 minutes");
  });
});

describe("send_confidential gating", () => {
  it("is off unless the Sui status starts with GO and the relay route exists", () => {
    expect(suiGo("/nonexistent")).toBe(false);
    expect(toolsFor(false).some((t) => t.name === "send_confidential")).toBe(false);
  });
});
