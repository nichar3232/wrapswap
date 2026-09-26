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
async function api(page: Page, mutate: Mutate = (_, v) => v) {
  await injectTestWallet(page, { account: DEMO.accounts.demo.anvilAddress, chainId: chainHex, known: [chainHex] });
  await page.route(/\/(api|crank)\//, async (route) => {
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
