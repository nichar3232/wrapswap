import { test, expect, type Page } from "@playwright/test";
import { DEMO, routes, type Network } from "@wrapswap/types";
import { mockResponse } from "../src/mocks/api";
import { injectTestWallet } from "./testWallet";

// Live transport (VITE_USE_MOCKS=false) against intercepted /api and /crank routes: no backend needed.
const network = (process.env.VITE_NETWORK || "unichain-sepolia") as Network;
const RAW_ERROR = /SyntaxError|Unexpected (token|end)|JSON|TypeError|HTTP \d{3}|Failed to fetch|Chain unavailable|\[object Object\]|undefined|NaN/;
const chainHex = network === "unichain-sepolia" ? "0x515" : "0x7a69";

type Mutate = (name: string, value: any) => any;
/** Serve fixtures for every route; a mutator returns "EMPTY" (200, empty body), "ERROR" (503) or a replacement value. */
async function api(page: Page, mutate: Mutate = (_, v) => v, opts: { wallet?: boolean } = {}) {
  if (opts.wallet !== false) await injectTestWallet(page, { account: DEMO.accounts.demo.anvilAddress, chainId: chainHex, known: [chainHex] });
  // Only the proxied API paths (not dev modules such as /services/crank/…).
  await page.route(/^https?:\/\/[^/]+\/(api|crank)\//, async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace(/^\/(api|crank)/, "");
    const r =
      routes.find((r) => r.path === path) ??
      routes.find((r) => r.path.includes(":") && new RegExp(`^${r.path.replace(/:[A-Za-z]+/, "[^/]+")}$`).test(path));
    if (!r) return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Missing fixture" } } });
    const params = r.path.includes(":")
      ? decodeURIComponent(path.split("/").pop()!) + (url.search ? `?${url.search.slice(1)}` : "")
      : url.search.slice(1);
    const value = mutate(r.name, mockResponse(r.name, network, params));
    if (value === "EMPTY") return route.fulfill({ status: 200, body: "" });
    if (value === "ERROR")
      return route.fulfill({ status: 503, json: { error: { code: "CHAIN_UNAVAILABLE", message: "Chain unavailable" } } });
    await route.fulfill({ json: value });
  });
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  return errors;
}

const convert = (page: Page) => page.locator("#pane-convert");
const tab = (page: Page, name: string) => page.locator("header nav").getByRole("button", { name, exact: true });
async function toQuote(page: Page) {
  await page.goto("/app?tab=move&asset=AAPL");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await convert(page).getByLabel("Amount", { exact: true }).fill("100");
}

test("API down (empty bodies): Connecting pill, placeholders, zero raw errors on every panel", async ({ page }) => {
  const errors = watchConsole(page);
  await api(page, () => "EMPTY");
  await page.goto("/app?tab=liquidity");
  const pill = page.getByTestId("status-pill");
  await expect(pill).toHaveText(/^(Unichain Sepolia|Anvil) · connecting…$/);
  // After a few failed attempts values settle on "unavailable" while the pill keeps retrying.
  await expect(page.locator('[data-panel="liquidity"]').getByText("unavailable").first()).toBeVisible({ timeout: 15000 });
  await expect(pill).toHaveText(/connecting…/);
  for (const [t, text] of [
    ["Liquidity", "unavailable"],
    ["Move", "Same share, converted at parity"], // platforms from the committed manifest
    ["Send", "Confidential, not anonymous"],
    ["Portfolio", "AAPL"],
  ]) {
    await tab(page, t).click();
    await expect(page.locator(`[data-panel="${t.toLowerCase()}"]`).getByText(text, { exact: false }).first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText(RAW_ERROR);
  }
  await pill.click();
  await expect(page.locator("#feed-status")).toContainText("unavailable · retrying");
  expect(errors).toEqual([]);
});

test("wallet button: Connect until clicked, Connecting… only in flight, back to Connect after 5 s", async ({ page }) => {
  await api(page, (_, v) => v, { wallet: false });
  await page.route(/\/api\/demo\/status/, () => undefined); // the relay probe never answers
  await page.goto("/app?tab=liquidity");
  const btn = page.getByRole("button", { name: "Connect wallet" });
  await expect(btn).toHaveText("Connect");
  await page.waitForTimeout(1500);
  await expect(btn).toHaveText("Connect");
  await btn.click();
  await expect(btn).toHaveText("Connecting…");
  await expect(btn).toHaveText("Connect", { timeout: 7000 });
  await expect(btn).toBeEnabled();
});

test("degraded names only the failing feeds; everything else stays live", async ({ page }) => {
  await api(page, (name, v) => (["crankStatus", "poolAsset"].includes(name) ? "ERROR" : v));
  await page.goto("/app?asset=AAPL");
  const pill = page.getByTestId("status-pill");
  await expect(pill).toHaveText(/^(Unichain Sepolia|Anvil) · degraded$/, { timeout: 15000 });
  await expect(pill).toHaveAttribute("title", "Degraded: AAPL pool, Crank");
  await pill.click();
  const feeds = page.locator("#feed-status");
  await expect(feeds.getByRole("listitem").filter({ hasText: "Assets" })).toContainText("live");
  await expect(feeds.getByRole("listitem").filter({ hasText: "AAPL pool" })).not.toContainText("live");
  await expect(page.locator("main")).not.toContainText(RAW_ERROR);
});

test("all feeds loaded: Live badge; a real wallet turns demo off", async ({ page }) => {
  await api(page);
  await page.goto("/app");
  await expect(page.getByTestId("status-pill")).toHaveText(/^(Unichain Sepolia|Anvil)$/);
  await expect(page.locator("header").getByText("Demo", { exact: true })).toHaveCount(0);
});

test("eligibility denial blocks Convert with a reason", async ({ page }) => {
  await api(page, (name, value) =>
    name === "eligibility" ? { ...value, eligible: false, reason: "RESTRICTED_COUNTRY", reasonCode: 7 } : value,
  );
  await toQuote(page);
  await expect(convert(page).getByText("no issuer eligibility attestation", { exact: false })).toBeVisible();
  await expect(convert(page).getByRole("button", { name: /convert$/i })).toBeDisabled();
});

test("blocked peg route is visible and cannot proceed", async ({ page }) => {
  await api(page, (name, value) =>
    name === "route" ? { ...value, route: "BLOCKED-PEG", reason: "Peg deviation exceeds 50 bps", quote: null } : value,
  );
  await toQuote(page);
  await expect(convert(page).getByText("Peg deviation exceeds 50 bps")).toBeVisible();
  await expect(convert(page).getByRole("button", { name: /convert$/i })).toBeDisabled();
});

test("slow and malformed responses never produce blank screens or raw errors", async ({ page }) => {
  await api(page, (name, v) => (name === "fills" || name === "batches" ? { items: [], nextCursor: null } : v));
  await page.route("**/api/deployment", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ json: {} });
  });
  await page.goto("/app?tab=move");
  // While /deployment is slow (then malformed) the committed Unichain manifest still names the platforms.
  await expect(convert(page).getByRole("radio", { name: /Coinbase/ })).toBeVisible();
  await page.getByRole("tab", { name: "Dark Cross" }).click();
  await expect(page.getByText("No settled batches for AAPL yet.")).toBeVisible();
  await tab(page, "Liquidity").click();
  await expect(page.getByText("LP economics")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(RAW_ERROR);
});

// ---- Demo relay (no wallet): real actions through POST /api/demo/*, rate-limited per IP.
const RELAY = "0x8f2e78AbD6E234D7B1CA7047F7502c374C81dA6C";
const status = { ok: true, address: RELAY, ethWei: "1", tokens: [], limits: { actionsPer10Min: 3, maxShares: "100" }, pendingReveals: [], recent: [] };
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");
async function relay(page: Page, routes: Record<string, (r: import("@playwright/test").Route) => Promise<void>>) {
  await page.route(/^https?:\/\/[^/]+\/api\/demo\//, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/demo/, "");
    const handler = routes[path] ?? (path.startsWith("/send/") ? routes["/send/:id"] : undefined);
    if (path === "/status" && !handler) return route.fulfill({ json: status });
    if (!handler) return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Unknown route" } } });
    await handler(route);
  });
}

test("no wallet: the demo relay connects itself; a 429 shows a live countdown and blocks the action", async ({ page }) => {
  await api(page, undefined, { wallet: false });
  let posted: unknown;
  await relay(page, {
    "/convert": async (r) => {
      posted = r.request().postDataJSON();
      await r.fulfill({ status: 429, headers: { "retry-after": "125" }, json: { error: { code: "RATE_LIMITED", message: "3 demo actions per 10 minutes" } } });
    },
  });
  await page.goto("/app?tab=move&asset=AAPL");
  await expect(page.getByRole("button", { name: /^Account 0x8f2e/ })).toBeVisible();
  await expect(page.locator("header").getByText("Demo", { exact: true })).toBeVisible();
  await convert(page).getByLabel("Amount", { exact: true }).fill("10");
  await convert(page).getByRole("button", { name: "Convert", exact: true }).click();
  expect(posted).toEqual({ asset: "AAPL", from: expect.stringMatching(/^m/), to: expect.stringMatching(/^m/), amount: "10" });
  await expect(convert(page).getByTestId("relay-cooldown")).toHaveText(/Demo limit: 3 actions per 10 minutes\. Next action in 2m \d\ds\./);
  await expect(convert(page).getByText(/Demo limit reached/)).toBeVisible();
  await expect(convert(page).getByRole("button", { name: "Convert", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Dark Cross" }).click();
  await expect(page.locator("#pane-dark").getByTestId("relay-cooldown")).toBeVisible(); // one limit for every action
});

test("no wallet: Send returns the deposit at once, then reveals Sui pay, Sui withdraw and Unichain settle as they arrive", async ({ page }) => {
  await api(page, undefined, { wallet: false });
  const step = (n: number, chain: "unichain" | "sui", label: string) => ({
    step: label,
    at: "2026-09-26T18:00:00Z",
    chain,
    tx: chain === "sui" ? `Dig${n}estSuiXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` : tx(n),
    url: chain === "sui" ? `https://suiscan.xyz/testnet/tx/Dig${n}` : `https://sepolia.uniscan.xyz/tx/${tx(n)}`,
  });
  const all = [
    step(1, "unichain", "deposit mcbAAPL into ShareVault"),
    step(2, "sui", "sealed pay A → B"),
    step(3, "sui", "sealed withdraw into mAAPLx"),
    step(4, "unichain", "settled: mAAPLx delivered"),
  ];
  const statuses = ["deposited", "paid", "withdraw-submitted", "settled"];
  const job = (k: number) => ({ id: "send-1", status: statuses[k - 1], asset: "AAPL", from: "mcbAAPL", to: "mAAPLx", amountIn: "10000000", shares: "10125000000000000000", recipient: RELAY, depositTx: tx(1), steps: all.slice(0, k) });
  let body: any;
  let polls = 0;
  let release = 1; // how many legs the relay has reported so far
  await relay(page, {
    "/send": async (r) => {
      body = r.request().postDataJSON();
      await r.fulfill({ json: { ...job(1), txHash: tx(1), path: "sui-confidential", track: "/demo/send/send-1" } });
    },
    "/send/:id": (r) => (polls++, r.fulfill({ json: job(release) })),
  });
  await page.goto("/app?tab=send&asset=NVDA"); // Send stays AAPL whatever the global asset
  const s = page.locator('[data-panel="send"]');
  await expect(s).toContainText("Send moves AAPL wrappers only");
  await s.getByLabel("Send amount").fill("10");
  await s.getByRole("button", { name: "Send confidentially" }).click();
  expect(body).toMatchObject({ asset: "AAPL", from: "mcbAAPL", to: "mAAPLx", amount: "10", recipient: RELAY });
  const leg = (k: string) => s.locator(`[data-leg="${k}"]`);
  // Only the deposit is known at first; the other three legs wait.
  await expect(leg("deposit").getByRole("link")).toHaveAttribute("href", `https://sepolia.uniscan.xyz/tx/${tx(1)}`);
  for (const k of ["pay", "withdraw", "settle"]) await expect(leg(k)).toContainText("waiting");
  for (const [k, n, href] of [
    ["pay", 2, "https://suiscan.xyz/testnet/tx/Dig2"],
    ["withdraw", 3, "https://suiscan.xyz/testnet/tx/Dig3"],
    ["settle", 4, `https://sepolia.uniscan.xyz/tx/${tx(4)}`],
  ] as const) {
    release = n;
    await expect(leg(k).getByRole("link")).toHaveAttribute("href", href, { timeout: 10000 });
  }
  await expect(s.getByTestId("relay-send-status")).toContainText("Settled");
  const settledAt = polls;
  await page.waitForTimeout(5000);
  expect(polls).toBe(settledAt); // polling stops once settled
  await expect(s).not.toContainText(/simulated/i);
});

test("no wallet: a 409 from /api/demo/send shows the one-send-at-a-time notice", async ({ page }) => {
  await api(page, undefined, { wallet: false });
  await relay(page, {
    "/send": (r) => r.fulfill({ status: 409, json: { error: { code: "BUSY", message: "a Sui send is in progress (send-x, paid); retry in a few minutes" } } }),
  });
  await page.goto("/app?tab=send");
  const s = page.locator('[data-panel="send"]');
  await s.getByLabel("Send amount").fill("2");
  await s.getByRole("button", { name: "Send confidentially" }).click();
  await expect(s.getByTestId("relay-one-at-a-time")).toContainText("One send at a time");
  await expect(s.getByText(/One send at a time: the demo relay is already running a Sui send\. Retry/)).toBeVisible();
});
