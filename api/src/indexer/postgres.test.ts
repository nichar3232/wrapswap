import { it, expect } from "vitest";
import pg from "pg";
import { migrate } from "../db/index.js";
import { Indexer } from "./index.js";
import { deployment, fixture, hash, chainMock } from "../testing/fixtures.js";
import { eventNames } from "./events.js";
it("empty migration, all event projections, replay, restart, reorg cascade and rollback", async () => {
  if (!process.env.DATABASE_URL)
    throw Error("DATABASE_URL is required for Postgres integration tests");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: "-c search_path=backend_test",
  });
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query("DROP SCHEMA IF EXISTS backend_test CASCADE");
  await admin.query("CREATE SCHEMA backend_test");
  try {
    await migrate(deployment, false, pool);
    await migrate(deployment, false, pool);
    let reorg = false,
      head = 1n;
    const client = {
      ...chainMock(),
      getBlockNumber: async () => head,
      getBlock: async ({ blockNumber = 1n }: any = {}) => ({
        number: blockNumber,
        hash: hash(Number(blockNumber) + (reorg ? 10 : 0)),
        parentHash: hash(Number(blockNumber) - 1),
        timestamp: 100n,
      }),
      getLogs: async () =>
        reorg ? [] : eventNames.map((name, i) => fixture(name, i)),
    };
    const indexer = new Indexer(deployment, client, pool, 0);
    await indexer.catchup();
    await indexer.catchup();
    await new Indexer(deployment, client, pool, 0).catchup();
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM raw_logs")).rows[0].n,
    ).toBe(33);
    expect((await pool.query("SELECT * FROM v_dark_orders")).rows).toHaveLength(
      1,
    );
    expect(
      (await pool.query("SELECT * FROM v_fills WHERE kind='DARK-RESIDUAL'"))
        .rows,
    ).toHaveLength(1);
    reorg = true;
    await indexer.catchup();
    expect((await pool.query("SELECT * FROM raw_logs")).rows).toHaveLength(0);
    expect((await pool.query("SELECT * FROM v_dark_orders")).rows).toHaveLength(
      0,
    );
    expect(
      (await pool.query("SELECT last_block_hash FROM indexer_cursor")).rows[0]
        .last_block_hash,
    ).toBe(hash(11));
    await migrate(deployment, true, pool);
    expect(
      (
        await pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='backend_test'",
        )
      ).rows,
    ).toHaveLength(0);
    await migrate(deployment, false, pool);
    reorg = false;
    head = 3n;
    client.getLogs = async () =>
      eventNames.map((name, i) => ({ ...fixture(name, i), removed: true }));
    await new Indexer(deployment, client, pool, 2).catchup();
    expect(
      (await pool.query("SELECT last_block FROM indexer_cursor")).rows[0]
        .last_block,
    ).toBe("1");
    expect((await pool.query("SELECT * FROM raw_logs")).rows).toHaveLength(0);
    head = 4n;
    client.getLogs = async () => [
      {
        ...fixture("InventoryFill"),
        data: "0x",
        blockNumber: 2n,
        blockHash: hash(2),
      },
    ];
    await expect(
      new Indexer(deployment, client, pool, 2).catchup(),
    ).rejects.toThrow();
    expect(
      (await pool.query("SELECT last_block FROM indexer_cursor")).rows[0]
        .last_block,
    ).toBe("1");
    expect(
      (await pool.query("SELECT * FROM blocks WHERE block_number=2")).rows,
    ).toHaveLength(0);
  } finally {
    await pool.end();
    await admin.query("DROP SCHEMA backend_test CASCADE");
    await admin.end();
  }
});
