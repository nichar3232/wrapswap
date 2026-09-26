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
    const r = routes.find(
      (r) => r.path === path || (r.path.includes(":address") && path.startsWith(r.path.split(":")[0])),
    );
    if (!r) return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Missing fixture" } } });
    const params = r.path.includes(":address") ? path.split("/").pop()! : url.search.slice(1);
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

test("API down (empty bodies): Connecting pill, skeleton cards, zero raw errors on every tab", async ({ page }) => {
  const errors = watchConsole(page);
  await api(page, () => "EMPTY");
  await page.goto("/app");
  const pill = page.getByTestId("status-pill");
  await expect(pill).toHaveText(/^Connecting to (Unichain Sepolia|Anvil)…$/);
  await expect(page.locator(".swap .skeleton").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // After a few failed attempts values settle on "unavailable" while the pill keeps retrying.
  await page.getByRole("button", { name: "Pool", exact: true }).click();
  await expect(page.getByText("unavailable").first()).toBeVisible({ timeout: 15000 });
  await expect(pill).toHaveText(/Connecting to/);
  for (const [tab, card] of [
    ["Pool", "Hook inventory"],
    ["Dark Cross", "Your order"],
    ["Convert", "Route"],
  ]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.locator("main").getByText(card, { exact: true }).first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText(RAW_ERROR);
  }
  await pill.click();
  await expect(page.locator("#feed-status")).toContainText("unavailable · retrying");
  expect(errors).toEqual([]);
});

test("degraded names only the failing feeds; everything else stays live", async ({ page }) => {
  await api(page, (name, v) => (["crankStatus", "pool"].includes(name) ? "ERROR" : v));
  await page.goto("/app");
  const pill = page.getByTestId("status-pill");
  await expect(pill).toHaveText("Degraded · Peg guard, Crank", { timeout: 15000 });
  await expect(page.getByText("PARITY", { exact: true })).toBeVisible();
  await pill.click();
  await expect(page.locator("#feed-status")).toContainText("Fees");
  await expect(page.locator("main")).not.toContainText(RAW_ERROR);
});

test("all feeds loaded: Live pill", async ({ page }) => {
  await api(page);
  await page.goto("/app");
  await expect(page.getByTestId("status-pill")).toHaveText(/^Live · (Unichain Sepolia|Anvil)$/);
});

test("eligibility denial disables the action with a reason", async ({ page }) => {
  await api(page, (name, value) =>
    name === "eligibility" ? { ...value, eligible: false, reason: "RESTRICTED_COUNTRY", reasonCode: 7 } : value,
  );
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText("A valid issuer eligibility attestation is required.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("route-badge")).toHaveText("BLOCKED-ELIGIBILITY");
  await expect(page.getByRole("button", { name: "Approve token", exact: true })).toBeDisabled();
  await expect(page.getByText("Simulated transactions", { exact: true })).toHaveCount(0);
});

test("blocked peg route is visible and cannot submit", async ({ page }) => {
  await api(page, (name, value) =>
    name === "route" ? { ...value, route: "BLOCKED-PEG", reason: "Peg deviation exceeds 50 bps", quote: null } : value,
  );
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("route-badge")).toHaveText("BLOCKED-PEG");
  await expect(page.getByText("Peg deviation exceeds 50 bps")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve token", exact: true })).toBeDisabled();
});

test("slow and malformed responses show skeletons, never blank screens or raw errors", async ({ page }) => {
  await api(page, (name, v) => (name === "fills" || name === "batches" ? { items: [], nextCursor: null } : v));
  await page.route("**/api/deployment", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ json: {} });
  });
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".skeleton").first()).toBeVisible();
  await page.getByRole("button", { name: "Pool", exact: true }).click();
  await expect(page.getByText(/No fills yet/)).toBeVisible();
  await page.getByRole("button", { name: "Dark Cross", exact: true }).click();
  await expect(page.getByText(/No batches yet/)).toBeVisible();
  await expect(page.locator("main")).not.toContainText(RAW_ERROR);
});
