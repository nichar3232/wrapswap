import { Indexer, startIndexer } from "./index.js";
import { loadDeployment } from "../chain/client.js";
import { db, migrate } from "../db/index.js";
for (const name of ["NETWORK", "DATABASE_URL", "RPC_URL"])
  if (!process.env[name]) throw Error(`${name} is required`);
const d = loadDeployment();
await migrate(d);
if (process.argv.includes("--live")) startIndexer(d);
else {
  try {
    await new Indexer(d).catchup();
  } finally {
    await db.end();
  }
}
