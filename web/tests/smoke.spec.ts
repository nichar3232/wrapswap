import { formatUnits } from "viem";
import { test, expect, type Page } from "@playwright/test";
import { DEMO, type Network } from "@wrapswap/types";
import { injectTestWallet, setTxMode } from "./testWallet";

// Mock mode (VITE_USE_MOCKS=true). The default network is Unichain Sepolia: NYSE closed, 14.60 bps.
const network = (process.env.VITE_NETWORK || "unichain-sepolia") as Network;
const v = DEMO.variants[network];
const account = DEMO.accounts.demo.anvilAddress;
const RIGHT = network === "unichain-sepolia" ? "0x515" : "0x7a69";
const RAW_ERROR = /SyntaxError|Unexpected (token|end)|TypeError|ReferenceError|HTTP \d{3}|Failed to fetch|\[object Object\]|undefined|NaN/;

/** Track console errors and uncaught exceptions for the whole test. */
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
async function connected(page: Page, chainId = RIGHT) {
  await injectTestWallet(page, { account, chainId, known: [RIGHT] });
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByRole("button", { name: /^Account 0x7099/ })).toBeVisible();
}
const primary = (page: Page) => page.locator(".swap button.primary.wide");

test("loads with a live status pill, no console errors and no raw error text", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "share-for-share conversion, no USDC leg." })).toBeVisible();
  await expect(page.getByTestId("status-pill")).toHaveText(/Mock data · Unichain Sepolia|Mock data · Anvil/);
  await page.getByTestId("status-pill").click();
  await expect(page.locator("#feed-status li")).toHaveCount(6);
  await expect(page.getByText("Demo mode", { exact: true })).toBeVisible();
  for (const tab of ["Dark Cross", "Pool", "Convert"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.locator("main")).not.toContainText(RAW_ERROR);
  }
  expect(errors).toEqual([]);
});

test("wallet: wrong chain → one click adds and switches to Unichain Sepolia; copy, balances, disconnect", async ({
  page,
}) => {
  test.skip(network !== "unichain-sepolia", "the add-chain flow targets Unichain Sepolia");
  await injectTestWallet(page, { account, chainId: "0x1" });
  await page.goto("/app");
  const connect = page.getByRole("button", { name: "Connect wallet" });
  await expect(connect).toBeEnabled();
  expect(await connect.evaluate((b) => getComputedStyle(b).opacity)).toBe("1");
  await connect.click();
  const switchBtn = page.locator("header").getByRole("button", { name: "Switch to Unichain Sepolia" });
  await expect(switchBtn).toBeVisible();
  await expect(primary(page)).toHaveText("Switch to Unichain Sepolia");
  await switchBtn.click();
  const added = await page.evaluate(() => (window as any).__wallet.added);
  expect(added).toEqual([
    {
      chainId: "0x515",
      chainName: "Unichain Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://sepolia.unichain.org"],
      blockExplorerUrls: ["https://sepolia.uniscan.xyz"],
    },
  ]);
  const acct = page.getByRole("button", { name: /^Account 0x7099/ });
  await expect(acct).toHaveText(/0x7099…79C8/);
  await acct.click();
  const menu = page.getByRole("dialog", { name: "Wallet" });
  await expect(menu.getByRole("button", { name: "Copy address" })).toBeVisible();
  await expect(menu).toContainText("mcbAAPL500");
  await expect(menu).toContainText("mAAPLx500");
  await menu.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
});

test("Convert: quote panel, Max, approve → convert → receipt, anatomy highlight", async ({ page }) => {
  await connected(page);
  await expect(page.getByText("PARITY", { exact: true })).toBeVisible();
  await expect(page.getByTestId("fee-breakdown").getByText(`${v.parityFill.feeBps} bps`, { exact: true })).toBeVisible();
  if (!v.marketOpen)
    await expect(page.getByText("NYSE closed: +10 bps off-hours premium", { exact: true })).toBeVisible();
  await expect(page.getByText("1.0125 mAAPLx/mcbAAPL", { exact: true })).toBeVisible();
  await expect(page.getByText("Clear · 0 bps from NAV")).toBeVisible();
  await expect(page.getByText("Eligibility verified", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Max" }).click();
  await expect(page.getByLabel("Conversion amount")).toHaveValue("500");
  await page.getByLabel("Conversion amount").fill("100");
  await expect(page.getByLabel("You receive")).toContainText("101.");
  await page.getByRole("button", { name: "Approve token", exact: true }).click();
  await expect(page.getByText(/Approval confirmed/)).toBeVisible();
  await page.getByRole("button", { name: "Convert through ParityHook", exact: true }).click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Conversion confirmed");
  await expect(receipt).toContainText("100 mcbAAPL");
  await expect(receipt).toContainText(`${v.parityFill.feeBps} bps`);
  await expect(receipt).toContainText("Filled from hook inventory");
  await expect(receipt.getByRole("button", { name: "Copy transaction hash" })).toBeVisible();
  await expect(page.locator(".swap .balance").first()).toContainText("400");
  await page.getByRole("button", { name: /Anatomy of this swap/ }).click();
  await expect(page.getByRole("img", { name: /your last swap took the inventory path/ })).toBeVisible();
  await expect(page.locator(".an-msg.an-on")).toHaveCount(7);
});

test("Convert: wallet rejection and contract failures show a human reason and Retry", async ({ page }) => {
  await connected(page);
  await setTxMode(page, "reject");
  await page.getByRole("button", { name: "Approve token", exact: true }).click();
  await expect(page.getByText("Approval failed.")).toBeVisible();
  await expect(page.getByText("You rejected the request in your wallet. Nothing was sent.")).toBeVisible();
  await setTxMode(page, "ok");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/Approval confirmed/)).toBeVisible();
  await setTxMode(page, "revert-peg");
  await page.getByRole("button", { name: "Convert through ParityHook", exact: true }).click();
  await expect(page.getByText("Conversion failed.")).toBeVisible();
  await expect(page.getByText(/Peg guard: the pool drifted more than 50 bps/)).toBeVisible();
  await setTxMode(page, "revert-slippage");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/slippage limit/)).toBeVisible();
  await expect(page.locator("main")).not.toContainText(RAW_ERROR);
  await expect(page.locator("main")).not.toContainText(/execution reverted|PegGuardTripped|TooLittleReceived/);
});

test("Convert: invalid amount and insufficient balance block the button with a reason", async ({ page }) => {
  await connected(page);
  await page.getByLabel("Conversion amount").fill("0");
  await expect(page.getByText("Enter a positive amount", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve token", exact: true })).toBeDisabled();
  await page.getByLabel("Conversion amount").fill("900");
  await expect(page.getByText("Insufficient mcbAAPL balance.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve token", exact: true })).toBeDisabled();
});

test("Dark Cross: batch, timeline, commit → reveal → settle with receipts and proof", async ({ page }) => {
  await connected(page);
  await page.getByRole("button", { name: "Dark Cross", exact: true }).click();
  await expect(page.locator('[aria-label="Current batch"]').getByText("Batch #4")).toBeVisible();
  await expect(page.getByRole("img", { name: /Current phase: commit/ })).toBeVisible();
  await expect(page.getByText("60 mcbAAPL", { exact: true })).toBeVisible();
  await expect(page.getByText(/No orders yet/)).toBeVisible();
  await expect(page.getByText("50.625 mAAPLx", { exact: true })).toBeVisible();
  await expect(page.locator('[aria-label="Last settlement"]').getByRole("button", { name: "Copy transaction hash" })).toBeVisible();
  await page.getByRole("button", { name: "Approve, fund & commit" }).click();
  await expect(page.getByText(/Commit confirmed/)).toBeVisible();
  await expect(page.getByRole("img", { name: /Current phase: reveal/ })).toBeVisible();
  await page.getByRole("button", { name: "Reveal order" }).click();
  await expect(page.getByText(/Reveal confirmed/)).toBeVisible();
  await page.getByRole("button", { name: "Settle batch" }).click();
  await expect(page.getByText(/Batch settled:/)).toBeVisible();
});

test("Pool: stats, inventory, fee-curve sliders drawn with the contract formula, fills", async ({ page }) => {
  await page.goto("/app?tab=pool");
  await expect(page.getByText("Total 20,250 canonical shares")).toBeVisible();
  await expect(page.getByText("8,000 tokens · 8,100 shares")).toBeVisible();
  await expect(page.getByLabel("Inventory skew", { exact: true })).toHaveAttribute("value", "-0.2");
  const readout = page.locator(".curve-readout");
  // Off-hours the curve shows the skew-increasing side: + 15 bps x |skew| (0.2 -> 3 bps); the demo fill itself reduces skew.
  await expect(readout).toContainText(v.marketOpen ? `${v.parityFill.feeBps} bps` : "7.60 bps");
  await expect(page.locator(".live-marker")).toBeVisible();
  const slider = page.getByLabel("Inventory skew (percent)");
  await slider.fill("0");
  await expect(readout).toContainText("2.00 bps"); // balanced: no off-hours premium, open or closed
  await page.getByRole("button", { name: "Market open" }).click();
  await expect(readout).toContainText("2.00 bps");
  await slider.fill("100");
  await expect(readout).toContainText("15.00 bps");
  await page.getByRole("button", { name: "Off-hours" }).click();
  await expect(readout).toContainText("25.00 bps");
  await expect(readout).toContainText("capped at 25");
  // The mock fill is the network variant's parity fill (INTERFACES.md §10), not a pinned literal.
  const full = formatUnits(BigInt(v.parityFill.amountOut), 18); // the table truncates to 6 decimals
  const out = full.slice(0, full.indexOf(".") + 7).replace(".", "\\.");
  await expect(page.getByRole("cell", { name: new RegExp(`${out} mAAPLx`) })).toBeVisible();
});

test("responsive: 390px has no sideways page scroll on any tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ["convert", "dark", "pool"]) {
    await page.goto(`/app?tab=${tab}`);
    await expect(page.locator("main .card").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("e2e/demo.spec selector contract: the same UI steps resolve to exactly one element each", async ({ page }) => {
  // Mirrors e2e/demo.spec.ts's browser steps (which run on anvil) so selector drift is caught in mock mode.
  await injectTestWallet(page, { account, chainId: RIGHT, known: [RIGHT] });
  await page.goto("/app");
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByLabel("Conversion amount").fill("100");
  await expect(page.getByText("PARITY", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("fee-breakdown").getByText(new RegExp(v.parityFill.feeBps.replace(".", "\\.") + "\\s*bps")),
  ).toBeVisible();
  const convert = page.getByRole("button", { name: /^convert through parityhook$/i });
  await page.getByRole("button", { name: /^approve token$/i }).click();
  await expect(convert).toBeEnabled({ timeout: 30000 });
  await convert.click();
  await expect(page.getByText(/conversion confirmed/i)).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Pool", exact: true }).click();
  await expect(page.getByText(/20(?:\.0+)?\s*%/).first()).toBeVisible(); // demo.spec expects 19% after its real fill
  await page.getByRole("button", { name: /dark/i }).click();
  await expect(page.getByText(/cross/i).first()).toBeVisible();
  await expect(page.getByText(/residual/i).first()).toBeVisible();
});
