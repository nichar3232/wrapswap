// Quick still of the replay at a tick: node packages/sim/scripts/shot.mjs <tick> <out.png> [light|dark]
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../../web/public");
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };
const srv = createServer(async (req, res) => {
  const p = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  try { res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" }).end(await readFile(p)); } catch { res.writeHead(404).end(); }
}).listen(14098, "127.0.0.1");
const [tick = "150", out = "shot.png", scheme = "dark", width = "1280"] = process.argv.slice(2);
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: Number(width), height: 800 }, colorScheme: scheme });
pg.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
pg.on("pageerror", (e) => console.error("pageerror:", e.message));
await pg.goto(`http://127.0.0.1:14098/sim.html?at=${tick}`);
await pg.waitForTimeout(1200);
await pg.evaluate((t) => window.__replay?.seek(Number(t)), tick);
await pg.waitForTimeout(500);
await pg.screenshot({ path: out, fullPage: true });
await b.close(); srv.close();
