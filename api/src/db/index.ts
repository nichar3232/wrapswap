import "dotenv/config";
import pg from "pg";
import { readFileSync } from "node:fs";
export const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://localhost/wrapswap",
});
export async function migrate() {
  await db.query(
    readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
  );
}
export const camel = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, x) => x.toUpperCase()),
      v,
    ]),
  );
export async function rows(sql: string, args: unknown[] = []) {
  return (await db.query(sql, args)).rows.map(camel);
}
