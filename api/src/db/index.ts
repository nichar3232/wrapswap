import "dotenv/config";
import pg from "pg";
import { readFileSync } from "node:fs";
import type { Deployment } from "@wrapswap/types";
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export async function migrate(d: Deployment, down = false, pool = db) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(1301026)");
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
      for (const m of ["001-network-check.sql", "002-faucet-claims.sql", "003-final-model.sql"])
        await c.query(
          readFileSync(new URL(`./migrations/${m}`, import.meta.url), "utf8"),
        );
      await upsertDarkPairs(d, c);
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
/** One dark_pairs row per DarkCrossHook (every asset's hook, else the single `dark` pair). Idempotent; the indexer
 *  also calls it before each catch-up because the dev reset truncates every table. */
export async function upsertDarkPairs(d: Deployment, c: { query: (q: string, a: any[]) => Promise<any> }) {
  const pairs = d.assets?.length
    ? d.assets
        .filter((a) => a.darkCrossHook && a.darkBaseToken && a.darkQuoteToken)
        .map((a) => [a.darkCrossHook!, a.symbol, a.darkBaseToken!, a.darkQuoteToken!])
    : [[d.contracts.darkCrossHook, d.tokens[0].underlying, d.dark.baseToken, d.dark.quoteToken]];
  for (const [contract, asset, base, quote] of pairs)
    await c.query(
      "INSERT INTO dark_pairs (chain_id, contract, asset, base, quote) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (chain_id, contract) DO UPDATE SET asset=EXCLUDED.asset, base=EXCLUDED.base, quote=EXCLUDED.quote",
      [d.chainId, contract.toLowerCase(), asset, base.toLowerCase(), quote.toLowerCase()],
    );
}
