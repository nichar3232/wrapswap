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
  let windowStart = Date.now();
  setInterval(() => {
    hits.clear();
    windowStart = Date.now();
  }, 60_000).unref();
  return function limited(req, res) {
    const ip = clientIp(req);
    const n = (hits.get(ip) ?? 0) + 1;
    hits.set(ip, n);
    res.setHeader('x-ratelimit-limit', String(limit));
    res.setHeader('x-ratelimit-remaining', String(Math.max(limit - n, 0)));
    if (n <= limit) return false;
    const retryAfter = Math.max(1, Math.ceil((windowStart + 60_000 - Date.now()) / 1000));
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfter) })
      .end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: `${limit} requests per minute` }, retryAfter }));
    return true;
  };
}
