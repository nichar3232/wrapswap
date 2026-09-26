import { it, expect, vi } from "vitest";
import Fastify from "fastify";
import pg from "pg";
import { validators } from "@wrapswap/types";
import { routes } from "./index.js";
import { migrate } from "../db/index.js";
import { Indexer } from "../indexer/index.js";
import { eventNames } from "../indexer/events.js";
import {
  deployment as d,
  fixture,
  chainMock,
  hash,
} from "../testing/fixtures.js";
import { Crank } from "../../../services/crank/worker.js";
it("every §5 API route validates, all decisions, errors, pagination and history", async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query("DROP SCHEMA IF EXISTS backend_api_test CASCADE");
  await admin.query("CREATE SCHEMA backend_api_test");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: "-c search_path=backend_api_test",
  });
  const client = chainMock();
  client.getLogs = async () =>
    eventNames.map((name, i) => ({
      ...fixture(name, i),
      ...(["InventoryFill", "FallThrough", "ResidualRouted"].includes(name)
        ? { transactionHash: hash(500) }
        : {}),
    })) as any;
  const app = Fastify();
  try {
    await migrate(d, false, pool);
    await new Indexer(d, client, pool, 0).catchup();
    await routes(app, d, client, pool);
    process.env.CRANK_HEALTH_PORT = "18104";
    const status = new Crank(d, client, {}, { address: d.deployer }).status;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(status)));
    const swap = `tokenIn=${d.tokens[0].address}&tokenOut=${d.tokens[1].address}&amount=100000000`;
    const list: [string, keyof typeof validators][] = [
      ["/health", "HealthResponse"],
      ["/deployment", "Deployment"],
      ["/pool", "PoolStateResponse"],
      ["/inventory", "InventoryResponse"],
      ["/inventory/changes", "InventoryChangesResponse"],
      ["/fees", "FeesResponse"],
      ["/quote?" + swap, "QuoteResponse"],
      ["/route?" + swap + "&swapper=" + d.deployer, "RouteResponse"],
      ["/nyse", "NyseResponse"],
      ["/batches/current", "CurrentBatchResponse"],
      ["/batches", "BatchListResponse"],
      ["/batches/1", "BatchDetailResponse"],
      ["/orders/" + d.tokens[0].address, "OrderListResponse"],
      ["/fills", "FillListResponse"],
      ["/eligibility/" + d.deployer, "EligibilityResponse"],
      ["/status", "CrankStatusResponse"],
    ];
    for (const [url, schema] of list) {
      const r = await app.inject(url);
      expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
      expect(validators[schema].is(r.json()), url).toBe(true);
    }
    fetchMock.mockRestore();
    const first = (await app.inject("/inventory/changes?limit=1")).json();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = (
      await app.inject("/inventory/changes?limit=1&cursor=" + first.nextCursor)
    ).json();
    expect(second.items[0].kind).not.toBe(first.items[0].kind);
    const fills = (await app.inject("/fills")).json().items;
    expect(fills.filter((f: any) => f.kind === "DARK-RESIDUAL")).toHaveLength(
      1,
    );
    expect(fills.filter((f: any) => f.kind === "PARITY")).toHaveLength(0);
    const routeUrl = "/route?" + swap + "&swapper=" + d.deployer;
    expect((await app.inject(routeUrl)).json().route).toBe("PARITY");
    const original = client.readContract;
    let eligible = true,
      healthy = true,
      fillable = false;
    client.readContract = async (p: any) =>
      p.functionName === "check"
        ? [eligible, eligible ? 0 : 7]
        : p.functionName === "active"
          ? healthy
          : p.functionName === "quote"
            ? { ...(await original(p)), fillable }
            : original(p);
    expect((await app.inject(routeUrl)).json().route).toBe("FALL-THROUGH");
    client.simulateContract = async () => {
      throw Error("PegGuardTripped");
    };
    expect((await app.inject(routeUrl)).json().route).toBe("DARK");
    expect((await app.inject(routeUrl + "&allowDark=false")).json().route).toBe(
      "BLOCKED-PEG",
    );
    healthy = false;
    expect((await app.inject(routeUrl)).json().reason).toBe(
      "ADAPTER_UNHEALTHY",
    );
    eligible = false;
    expect((await app.inject(routeUrl)).json().route).toBe(
      "BLOCKED-ELIGIBILITY",
    );
    eligible = true;
    healthy = true;
    client.simulateContract = async () => {
      throw Error("RPC disconnected");
    };
    expect((await app.inject(routeUrl)).statusCode).toBe(503);
    const audits = await pool.query(
      "SELECT count(*)::int AS n FROM eligibility_checks",
    );
    expect(audits.rows[0].n).toBeGreaterThan(7);
    for (const url of [
      "/quote?amount=0",
      "/fills?limit=201",
      "/orders/nope",
      "/batches/nope",
      "/missing",
      "/batches/999",
    ]) {
      const r = await app.inject(url);
      expect([400, 404]).toContain(r.statusCode);
      expect(validators.ErrorResponse.is(r.json())).toBe(true);
    }
    client.getChainId = async () => {
      throw Error("offline");
    };
    const health = await app.inject("/health");
    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(false);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    await pool.end();
    await admin.query("DROP SCHEMA backend_api_test CASCADE");
    await admin.end();
  }
});
