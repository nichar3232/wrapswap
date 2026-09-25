import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { db } from "../db/index";
import { projection } from "./index";
it("Postgres replay is idempotent and a canonical rebuild removes orphaned reveals", async () => {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("CREATE SCHEMA wrapswap_indexer_test");
    await c.query("SET LOCAL search_path TO wrapswap_indexer_test");
    await c.query(
      readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"),
    );
    const e = {
      tx: "0x1",
      log_index: 0,
      chain_id: 8453,
      block: "1",
      ts: "1",
      trader: "0xabc",
    };
    const commit = projection(
      "Committed",
      { batchId: "7", trader: "0xABC", hash: "0xhash" },
      e,
    )!;
    const reveal = projection(
      "Revealed",
      {
        batchId: "7",
        trader: "0xABC",
        isBuy: true,
        qty: "100000000000000000001",
        limitPx: "200",
        routeResidual: true,
      },
      e,
    )!;
    for (const p of [commit, commit, reveal, reveal])
      await c.query(p.sql, p.values);
    let records = (await c.query("SELECT * FROM orders")).rows;
    expect(records).toHaveLength(1);
    expect(records[0].commit_hash).toBe("0xhash");
    expect(records[0].qty).toBe("100000000000000000001");
    expect(records[0].revealed).toBe(true);
    await c.query("TRUNCATE orders");
    await c.query(commit.sql, commit.values);
    records = (await c.query("SELECT * FROM orders")).rows;
    expect(records[0].revealed).toBe(false);
    expect(records[0].qty).toBeNull();
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}, 15000);
