import pg from 'pg';
const db = new pg.Client({connectionString: process.env.DATABASE_URL});
await db.connect();
try {
  const {rows} = await db.query('SELECT last_block FROM indexer_cursor WHERE chain_id = 31337');
  if (!rows.length) throw Error('backend boundary: missing indexer_cursor');
} finally { await db.end(); }
