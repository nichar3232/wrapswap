// Fixed-window per-IP rate limit shared by the web server (scripts/dev/serve-web.mjs) and the MCP HTTP server
// (packages/mcp/src/http.ts). Behind Tailscale Funnel the client IP comes from X-Forwarded-For, trusted only when the
// socket peer is loopback.
export function clientIp(req) {
  const peer = req.socket.remoteAddress ?? '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const fwd = loopback && req.headers['x-forwarded-for'];
  return fwd ? String(fwd).split(',')[0].trim() : peer;
}

/** Returns limited(req, res): true (and a 429 already sent) when the caller exceeded `limit` requests this minute. */
export function createLimiter(limit = Number(process.env.RATE_LIMIT_PER_MIN || 600)) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return function limited(req, res) {
    const ip = clientIp(req);
    const n = (hits.get(ip) ?? 0) + 1;
    hits.set(ip, n);
    res.setHeader('x-ratelimit-limit', String(limit));
    res.setHeader('x-ratelimit-remaining', String(Math.max(limit - n, 0)));
    if (n <= limit) return false;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }).end('{"error":"rate limited"}');
    return true;
  };
}
