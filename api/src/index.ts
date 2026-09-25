import Fastify from "fastify";
import cors from "@fastify/cors";
import { migrate } from "./db/index.js";
import { routes } from "./routes/index.js";
import { startIndexer } from "./indexer/index.js";
const app = Fastify({ logger: true });
await app.register(cors, {
  origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
});
app.setReplySerializer((v) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)),
);
app.setErrorHandler((err, req, reply) =>
  reply
    .status((err as any).statusCode || 503)
    .send({ error: (err as Error).message }),
);
await migrate();
await routes(app);
await app.listen({
  port: Number(process.env.API_PORT || 4000),
  host: "127.0.0.1",
});
startIndexer().catch((error) => {
  app.log.error(error);
  setTimeout(() => startIndexer().catch(console.error), 5000);
});
