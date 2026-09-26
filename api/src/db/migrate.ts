import { migrate, db } from "./index.js";
import { loadDeployment } from "../chain/client.js";
for (const name of ["NETWORK", "DATABASE_URL"])
  if (!process.env[name]) throw Error(`${name} is required`);
try {
  await migrate(loadDeployment(), process.argv.includes("--down"));
} finally {
  await db.end();
}
