// Production web server for the live stack: serves the static build (dist/web) with an SPA fallback, and proxies
// /api → API_PORT, /crank → CRANK_HEALTH_PORT and /rpc → RPC_URL (so a keyed RPC stays server-side).
// /api/pay/* goes to the Sui pay-api (PAY_API_URL). /api, /crank and /rpc share a fixed-window per-IP rate limit; behind Tailscale Funnel the client IP comes from
// X-Forwarded-For (only trusted when the socket peer is loopback).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(process.cwd(), 'dist/web');
const port = Number(process.env.WEB_PORT || 13010);
const apiPort = Number(process.env.API_PORT || 18010);
const crankPort = Number(process.env.CRANK_HEALTH_PORT || 18110);
const rpcUrl = process.env.RPC_URL;
const limit = Number(process.env.RATE_LIMIT_PER_MIN || 600);
// Sui payments API (the Sui keeper's pay-api) until the sui branch mounts /pay routes in the API itself.
const payUrl = process.env.PAY_API_URL || 'http://127.0.0.1:5402';
// Demo relay (services/relay): POST /api/demo/* signs with the demo key; it enforces its own per-IP action limit.
const relayPort = Number(process.env.RELAY_PORT || 18210);
if (!rpcUrl) throw Error('RPC_URL is required');

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp' };

const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
function clientIp(req) {
  const peer = req.socket.remoteAddress ?? '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const fwd = loopback && req.headers['x-forwarded-for'];
  return fwd ? String(fwd).split(',')[0].trim() : peer;
}
function limited(req, res) {
  const ip = clientIp(req);
  const n = (hits.get(ip) ?? 0) + 1;
  hits.set(ip, n);
  res.setHeader('x-ratelimit-limit', String(limit));
  res.setHeader('x-ratelimit-remaining', String(Math.max(limit - n, 0)));
  if (n <= limit) return false;
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }).end('{"error":"rate limited"}');
  return true;
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1_000_000) throw Error('body too large'); chunks.push(c); }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}
async function proxy(req, res, target) {
  try {
    // Upstreams rate-limit per client IP: pass it on (X-Forwarded-For is only trusted from loopback peers).
    const headers = { 'content-type': req.headers['content-type'] ?? 'application/json', 'x-forwarded-for': clientIp(req) };
    if (req.headers.accept) headers.accept = req.headers.accept;
    const r = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : await body(req) });
    const out = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' }).end(out);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'upstream unavailable' }));
  }
}

async function file(res, path) {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) return false;
  const immutable = path.includes(`${join(root, 'assets')}`);
  res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' }).end(await readFile(path));
  return true;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  if (p.startsWith('/api/demo/')) {
    if (!limited(req, res)) await proxy(req, res, `http://127.0.0.1:${relayPort}${p.slice(4)}${url.search}`);
  } else if (p.startsWith('/api/pay/')) {
    if (!limited(req, res)) await proxy(req, res, `${payUrl}${p.slice(4)}${url.search}`);
  } else if (p === '/api' || p.startsWith('/api/')) {
    if (!limited(req, res)) await proxy(req, res, `http://127.0.0.1:${apiPort}${p.slice(4) || '/'}${url.search}`);
  } else if (p === '/crank' || p.startsWith('/crank/')) {
    if (!limited(req, res)) await proxy(req, res, `http://127.0.0.1:${crankPort}${p.slice(6) || '/'}${url.search}`);
  } else if (p === '/rpc') {
    if (req.method !== 'POST') res.writeHead(405).end();
    else if (!limited(req, res)) await proxy(req, res, rpcUrl);
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
  } else {
    const path = normalize(join(root, decodeURIComponent(p)));
    if (!path.startsWith(root) || !(await file(res, path))) await file(res, join(root, 'index.html'));
  }
}).listen(port, '127.0.0.1', () => console.log(`web (dist/web) on 127.0.0.1:${port}; /api → ${apiPort}, /crank → ${crankPort}, /rpc → RPC_URL; ${limit}/min/IP`));
