// Standalone /pay server (no Postgres, no indexer): `pnpm dev:pay-api`.
// Serves GET /pay/reserves (and /api/pay/reserves). With PAY_WEB_DIST pointing at a `vite build` output it also serves
// the web app with an SPA fallback, so /pay works from a single long-lived process.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { payRoutes } from '../../../api/src/routes/pay.js';

const port = Number(process.env.PAY_API_PORT ?? 5403);
const dist = process.env.PAY_WEB_DIST;
const app = Fastify({ logger: false });
await app.register(cors, { origin: process.env.CORS_ORIGIN ?? /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ });
await payRoutes(app);
await app.register(async (scoped) => payRoutes(scoped), { prefix: '/api' });
app.setErrorHandler((e: any, _req, reply) =>
  reply.status(e.statusCode ?? 500).send({ error: { code: e.code ?? 'INTERNAL', message: e.message } }),
);

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
if (dist && existsSync(dist)) {
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown route' } });
    const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const file = join(dist, path);
    const hit = file.startsWith(dist) && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html');
    reply.type(types[extname(hit)] ?? 'application/octet-stream').send(readFileSync(hit));
  });
}
await app.listen({ port, host: process.env.PAY_API_HOST ?? '127.0.0.1' });
console.log(`pay server on ${port}${dist ? ` (web from ${dist})` : ''}`);
