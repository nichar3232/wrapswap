// Records the replay (web/public/sim.html + web/public/sim/run.json) to a webm clip and three screenshots.
// Usage (repo root): node packages/sim/scripts/record.mjs [outDir]   (default ~/wrapswap-run/status)
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdir, rename, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { homedir } from "node:os";

const root = resolve(import.meta.dirname, "../../../web/public");
const out = resolve(process.argv[2] ?? join(homedir(), "wrapswap-run/status"));
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const srv = createServer(async (req, res) => {
  const p = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(root)) return res.writeHead(403).end();
  try {
    res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" }).end(await readFile(p));
  } catch {
    res.writeHead(404).end();
  }
}).listen(14099, "127.0.0.1");
const base = "http://127.0.0.1:14099/sim.html";
const viewport = { width: 1280, height: 800 };
const SECONDS = 38;

const browser = await chromium.launch();
await mkdir(join(out, "sim-shots"), { recursive: true });
const tmp = join(out, ".sim-video");
await rm(tmp, { recursive: true, force: true });
const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "dark", recordVideo: { dir: tmp, size: viewport } });
const page = await ctx.newPage();
await page.goto(`${base}?seconds=${SECONDS}`);
await page.waitForFunction(() => window.__replay);
await page.waitForTimeout(SECONDS * 1000 + 2500); // full replay + a beat on the final frame
const video = page.video();
await ctx.close();
await rename(await video.path(), join(out, "sim-clip.webm"));
await rm(tmp, { recursive: true, force: true });

// Stills at fixed ticks: the first gap collapsing, just after the second gap, the end state.
const sctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: "dark" });
const sp = await sctx.newPage();
await sp.goto(base);
await sp.waitForFunction(() => window.__replay);
const T = await sp.evaluate(() => window.__replay.T);
const at = [["1-first-gap-collapsing", 12], ["2-second-gap", Math.floor(T / 2) + 12], ["3-end", T - 1]];
for (const [name, tick] of at) {
  await sp.goto(`${base}?at=${tick}`);
  await sp.waitForFunction(() => window.__replay);
  await sp.evaluate(() => window.__replay.pause());
  // Replay the feed up to the tick so the event list matches the frame.
  await sp.evaluate((t) => window.__replay.seek(t), tick);
  await sp.waitForTimeout(600);
  await sp.screenshot({ path: join(out, "sim-shots", `${name}.png`) });
}
await browser.close();
srv.close();
console.log(`clip ${join(out, "sim-clip.webm")}; shots ${join(out, "sim-shots")}`);
