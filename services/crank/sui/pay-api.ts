// Standalone /pay API (no Postgres, no indexer) for previews and the Sui demo: `tsx services/crank/sui/pay-api.ts`.
// The full API registers the same routes from api/src/routes/pay.ts.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { payRoutes } from '../../../api/src/routes/pay.js';

const port = Number(process.env.PAY_API_PORT ?? 5403);
const app = Fastify({ logger: false });
await app.register(cors, { origin: process.env.CORS_ORIGIN ?? /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ });
await payRoutes(app);
app.setErrorHandler((e: any, _req, reply) =>
  reply.status(e.statusCode ?? 500).send({ error: { code: e.code ?? 'INTERNAL', message: e.message } }),
);
await app.listen({ port, host: process.env.PAY_API_HOST ?? '127.0.0.1' });
console.log(`pay api listening on ${port}`);
