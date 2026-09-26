import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { DEMO, type Network } from "@wrapswap/types";
import { formatUnits } from "viem";
const network = (process.env.VITE_NETWORK || "anvil") as Network;
const v = DEMO.variants[network];
test("Convert: canonical quote, approval, settlement", async ({ page }) => {
  await page.goto("/app");
  await expect(
    page.getByRole("heading", {
      name: "share-for-share conversion, no USDC leg.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Demo mode", { exact: true })).toBeVisible();
  await expect(
    page.getByText(`${formatUnits(v.parityFill.amountOut, 18)} mAAPLx`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("1.0125 mAAPLx/mcbAAPL", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("fee-breakdown")).toContainText(
    `${v.parityFill.feeBps} bps`,
  );
  if (!v.marketOpen)
    await expect(
      page.getByText("NYSE closed: +10 bps off-hours premium", { exact: true }),
    ).toBeVisible();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(
    page.getByText("Eligibility verified", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Approve token", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Convert through ParityHook", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Simulated conversion confirmed" }),
  ).toContainText(formatUnits(v.parityFill.amountOut, 18));
  await page.getByLabel("Conversion amount").fill("0");
  await expect(
    page.getByText("Enter a positive amount", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve token", exact: true }),
  ).toBeDisabled();
});
test("Dark Cross: commit, reveal, settle and exact residual", async ({
  page,
}) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Dark Cross", exact: true }).click();
  await expect(page.getByText("50 mcbAAPL", { exact: true })).toBeVisible();
  await expect(page.getByText("50.625 mAAPLx", { exact: true })).toBeVisible();
  await expect(
    page.getByText(`${formatUnits(v.residual.amountOut, 18)} mAAPLx`, {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve, fund & commit" }).click();
  await page.getByRole("button", { name: "Reveal order" }).click();
  await page.getByRole("button", { name: "Settle batch" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Batch settled:" }),
  ).toBeVisible();
});
test("Pool: token inventory, canonical shares, skew and fills", async ({
  page,
}) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Pool", exact: true }).click();
  for (const text of [
    "8000 tokens",
    "12150 tokens",
    "8100 shares",
    "12150 shares",
    "Total 20250 canonical shares",
    "Inventory · ParityHook",
  ])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("Inventory skew", { exact: true }),
  ).toHaveAttribute("value", "-0.2");
  await expect(
    page.getByRole("cell", {
      name: `${formatUnits(v.parityFill.amountOut, 18)} mAAPLx`,
      exact: true,
    }),
  ).toBeVisible();
});
test("Landing: Unison brand, proof from deployment, Launch app", async ({
  page,
}) => {
  const d = JSON.parse(
    readFileSync(
      new URL("../../deployments/base-sepolia.json", import.meta.url),
      "utf8",
    ),
  );
  await page.goto("/");
  await expect(page).toHaveTitle("Unison");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Unison");
  await expect(page.getByText("WrapSwap", { exact: true })).toHaveCount(0);
  const proof = page.locator("#proof");
  await expect(
    proof.getByRole("link", { name: "Basescan ↗" }).first(),
  ).toHaveAttribute(
    "href",
    `https://sepolia.basescan.org/address/${d.contracts.parityHook}`,
  );
  await expect(proof.getByRole("row")).toHaveCount(6);
  await page.getByRole("button", { name: /switch to dark theme/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: "Launch app" }).first().click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(
    page.getByRole("button", { name: "Convert", exact: true }),
  ).toBeVisible();
  await page.goto("/app?tab=pool");
  await expect(page.getByText("Total 20250 canonical shares")).toBeVisible();
});
