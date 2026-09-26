import { test, expect, type Page } from "@playwright/test";
import { DEMO, routes, type Network } from "@wrapswap/types";
import { fixtures, mockResponse } from "../src/mocks/api";
const network = (process.env.VITE_NETWORK || "anvil") as Network;
async function api(
  page: Page,
  mutate: (name: string, value: any) => any = (_, v) => v,
) {
  await page.addInitScript(
    ({ account }) => {
      (window as any).ethereum = {
        request: async ({ method }: any) =>
          method === "eth_requestAccounts" ? [account] : null,
        on: () => {},
        removeListener: () => {},
      };
    },
    { account: DEMO.accounts.demo.anvilAddress },
  );
  await page.route(/\/(api|crank)\//, async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace(/^\/(api|crank)/, "");
    const r = routes.find(
      (r) =>
        r.path === path ||
        (r.path.includes(":address") && path.startsWith(r.path.split(":")[0])),
    );
    if (!r)
      return route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "Missing fixture" } },
      });
    const params = r.path.includes(":address")
      ? path.split("/").pop()!
      : url.search.slice(1);
    const value = mutate(r.name, mockResponse(r.name, network, params));
    if (value === "ERROR")
      return route.fulfill({
        status: 503,
        json: {
          error: { code: "CHAIN_UNAVAILABLE", message: "Chain unavailable" },
        },
      });
    await route.fulfill({ json: value });
  });
}
test("env-only live API transport, deployment chain and eligibility denial", async ({
  page,
}) => {
  await api(page, (name, value) =>
    name === "eligibility"
      ? {
          ...value,
          eligible: false,
          reason: "RESTRICTED_COUNTRY",
          reasonCode: 7,
        }
      : value,
  );
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(
    page.getByText(`${network} · Chain ${DEMO.variants[network].chainId}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("A valid issuer eligibility attestation is required.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve token", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Simulated transactions", { exact: true }),
  ).toHaveCount(0);
});
test("live blocked peg route is visible and cannot submit", async ({
  page,
}) => {
  await api(page, (name, value) =>
    name === "route"
      ? {
          ...value,
          route: "BLOCKED-PEG",
          reason: "Peg deviation exceeds 50 bps",
          quote: null,
        }
      : value,
  );
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("route-badge")).toHaveText("BLOCKED-PEG");
  await expect(page.getByText("Peg deviation exceeds 50 bps")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve token", exact: true }),
  ).toBeDisabled();
});
test("network errors and empty lists stay visible on each tab", async ({
  page,
}) => {
  await api(page, (name, value) =>
    ["crankStatus", "quote", "currentBatch", "inventory"].includes(name)
      ? "ERROR"
      : ["fills", "batches"].includes(name)
        ? { items: [], nextCursor: null }
        : value,
  );
  await page.goto("/app");
  await expect(
    page.getByText("Quote: Error: Chain unavailable.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Crank health: Error: Chain unavailable.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dark Cross", exact: true }).click();
  await expect(
    page.getByText("Current batch: Error: Chain unavailable.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("No batches yet.")).toBeVisible();
  await page.getByRole("button", { name: "Pool", exact: true }).click();
  await expect(
    page.getByText("Inventory: Error: Chain unavailable.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("No fills yet.")).toBeVisible();
});
test("loading and malformed deployment never produce blank screens", async ({
  page,
}) => {
  await page.route("**/api/deployment", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ json: {} });
  });
  await page.goto("/app");
  await expect(page.getByText("Loading deployment…")).toBeVisible();
  await expect(page.getByText("Deployment:", { exact: false })).toContainText(
    "Retrying automatically",
  );
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
