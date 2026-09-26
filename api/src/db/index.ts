import "dotenv/config";
import pg from "pg";
import { readFileSync } from "node:fs";
import type { Deployment } from "@wrapswap/types";
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export async function migrate(d: Deployment, down = false, pool = db) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(84532026)");
    if (down)
      await c.query(
        readFileSync(new URL("./down.sql", import.meta.url), "utf8"),
      );
    else {
      // Validated addresses contain only hexadecimal digits; never interpolate user input here.
      await c.query(
        `CREATE OR REPLACE VIEW v_dark_pair AS SELECT '${d.dark.baseToken.toLowerCase()}'::text AS base, '${d.dark.quoteToken.toLowerCase()}'::text AS quote`,
      );
      const exists = await c.query(
        "SELECT to_regclass('indexer_deployments') AS name",
      );
      if (!exists.rows[0].name)
        await c.query(
          readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
        );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export const camel = (r: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(r).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, x) => x.toUpperCase()),
      v,
    ]),
  );
