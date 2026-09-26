import Fastify from "fastify";
import cors from "@fastify/cors";
import { db, migrate } from "./db/index.js";
import { routes } from "./routes/index.js";
import { startIndexer } from "./indexer/index.js";
import { loadDeployment } from "./chain/client.js";
for (const key of ["DATABASE_URL", "RPC_URL", "API_PORT", "NETWORK"])
  if (!process.env[key]) throw Error(`${key} is required`);
const d = loadDeployment(),
  app = Fastify({ logger: true });
await app.register(cors, {
  origin:
    process.env.CORS_ORIGIN ?? /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
});
await migrate(d);
await routes(app, d);
await app.listen({
  port: Number(process.env.API_PORT),
  host: process.env.API_HOST ?? "127.0.0.1",
});
const stop = startIndexer(d);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    stop();
    await app.close();
    await db.end();
  });
