import { test, expect, type Page } from "@playwright/test";
import { DEMO, type Network } from "@wrapswap/types";
import { demoVariant } from "../src/mocks/api";
import { injectTestWallet, setTxMode } from "./testWallet";

// Mock data (VITE_USE_MOCKS=true), Unichain Sepolia by default: market closed, fee from the contract formula.
const network = (process.env.VITE_NETWORK || "unichain-sepolia") as Network;
const v = demoVariant(network);
const account = DEMO.accounts.demo.anvilAddress;
const RIGHT = network === "unichain-sepolia" ? "0x515" : "0x7a69";
const RAW_ERROR = /SyntaxError|Unexpected (token|end)|TypeError|ReferenceError|HTTP \d{3}|Failed to fetch|\[object Object\]|undefined|NaN/;

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
/** Demo mode: no injected wallet, the simulated wallet connects. */
async function demoConnected(page: Page, path = "/app") {
  await page.goto(path);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByRole("button", { name: /^Account 0x/ })).toBeVisible();
}
async function injectedConnected(page: Page, chainId = RIGHT) {
  await injectTestWallet(page, { account, chainId, known: [RIGHT] });
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByRole("button", { name: /^Account 0x7099/ })).toBeVisible();
}
const primary = (page: Page) => page.locator(".convert button.primary.wide");

test("nav: logo, tabs, network badge, Demo badge, wallet; no console errors, no raw errors", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/app");
  const header = page.locator("header");
  await expect(header.getByTestId("status-pill")).toHaveText(/^(Unichain Sepolia|Anvil)$/);
  await expect(header.getByText("Demo", { exact: true })).toBeVisible();
  await expect(header.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(page.locator("footer")).toHaveCount(0);
  for (const tab of ["Dark Cross", "Pool", "Convert"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.locator("main")).not.toContainText(RAW_ERROR);
  }
  expect(errors).toEqual([]);
});

test("demo mode Convert end to end: simulated wallet, shares headline, approve → convert → receipt → recent", async ({ page }) => {
  await demoConnected(page);
  const card = page.locator(".convert");
  await expect(card.locator(".share-line")).toContainText("101.25 AAPL shares");
  await expect(card.locator(".share-line")).toContainText("Coinbase");
  await expect(card.locator(".share-line")).toContainText("xStocks");
  await expect(card.getByText(`${((1_000_000 - v.parityFill.feePips) / 10_000).toFixed(2)}%`)).toBeVisible();
  await expect(page.getByTestId("fee-breakdown").getByText(`${v.parityFill.feeBps} bps`, { exact: true })).toBeVisible();
  if (!v.marketOpen) await expect(card.getByText("Market closed: +10 bps", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Max" }).click();
  await expect(page.getByLabel("Conversion amount")).toHaveValue("500");
  await page.getByLabel("Conversion amount").fill("100");
  await page.getByRole("button", { name: "Approve token", exact: true }).click();
  await expect(page.getByText("Approval confirmed (simulated). Now convert.")).toBeVisible();
  await page.getByRole("button", { name: "Convert through ParityHook", exact: true }).click();
  const receipt = page.locator(".receipt");
  await expect(receipt).toContainText("Conversion confirmed (simulated)");
  await expect(receipt).toContainText("101.25 → 101.25 AAPL");
  await expect(receipt).toContainText("100 mcbAAPL → 101.1");
  await expect(receipt).toContainText(`${v.parityFill.feeBps} bps`);
  await expect(receipt.getByRole("button", { name: "Copy transaction hash" })).toBeVisible();
  await expect(card.locator(".balance").first()).toContainText("400");
  const recent = page.getByRole("region", { name: "Your recent conversions" });
  await expect(recent).toContainText("101.25 AAPL shares · mcbAAPL → mAAPLx");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByText("PARITY", { exact: true })).toBeVisible();
  await expect(page.getByText("1.0125 mAAPLx/mcbAAPL")).toBeVisible();
  await expect(page.getByText("Clear · 0 bps from NAV")).toBeVisible();
  await expect(page.getByRole("img", { name: /your last swap took the inventory path/ })).toBeVisible();
});

test("details are closed by default and recent conversions are hidden until there are any", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("PARITY", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Your recent conversions" })).toHaveCount(0);
});

test("wallet: wrong chain → one click adds and switches to Unichain Sepolia; copy, balances, disconnect", async ({ page }) => {
  test.skip(network !== "unichain-sepolia", "the add-chain flow targets Unichain Sepolia");
  await injectTestWallet(page, { account, chainId: "0x1" });
  await page.goto("/app");
  await expect(page.locator("header").getByText("Demo", { exact: true })).toBeVisible(); // mock data is still demo
  const connect = page.getByRole("button", { name: "Connect wallet" });
  expect(await connect.evaluate((b) => getComputedStyle(b).opacity)).toBe("1");
  await connect.click();
  const switchBtn = page.locator("header").getByRole("button", { name: "Switch to Unichain Sepolia" });
  await expect(switchBtn).toBeVisible();
  await expect(primary(page)).toHaveText("Switch to Unichain Sepolia");
  await switchBtn.click();
  expect(await page.evaluate(() => (window as any).__wallet.added)).toEqual([
    {
      chainId: "0x515",
      chainName: "Unichain Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://sepolia.unichain.org"],
      blockExplorerUrls: ["https://sepolia.uniscan.xyz"],
    },
  ]);
  const acct = page.getByRole("button", { name: /^Account 0x7099/ });
  await acct.click();
  const menu = page.getByRole("dialog", { name: "Wallet" });
  await expect(menu.getByRole("button", { name: "Copy address" })).toBeVisible();
  await expect(menu).toContainText("mcbAAPL500");
  await expect(menu).toContainText("mAAPLx500");
  await menu.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
});

test("Convert with a real (injected) wallet: rejection and reverts show a human reason and Retry", async ({ page }) => {
  await injectedConnected(page);
  await setTxMode(page, "reject");
  await page.getByRole("button", { name: "Approve token", exact: true }).click();
  await expect(page.getByText("Approval failed.")).toBeVisible();
  await expect(page.getByText("You rejected the request in your wallet. Nothing was sent.")).toBeVisible();
  await setTxMode(page, "ok");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/Approval confirmed/)).toBeVisible();
  await setTxMode(page, "revert-peg");
  await page.getByRole("button", { name: "Convert through ParityHook", exact: true }).click();
  await expect(page.getByText(/Peg guard: the pool drifted more than 50 bps/)).toBeVisible();
  await setTxMode(page, "revert-slippage");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/slippage limit/)).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/execution reverted|PegGuardTripped|TooLittleReceived/);
  await expect(page.locator("main")).not.toContainText(RAW_ERROR);
});

test("Convert: invalid amount and insufficient balance block the button with a reason", async ({ page }) => {
  await demoConnected(page);
  await page.getByLabel("Conversion amount").fill("0");
  await expect(page.getByText("Enter a positive amount", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve token", exact: true })).toBeDisabled();
  await page.getByLabel("Conversion amount").fill("900");
  await expect(page.getByText("Insufficient mcbAAPL balance.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve token", exact: true })).toBeDisabled();
});

test("Dark Cross: a sealed order goes sealed → revealed → filled with tx links", async ({ page }) => {
  await demoConnected(page, "/app?tab=dark");
  await expect(page.getByText(/Next cross in/)).toBeVisible();
  await expect(page.getByText("crosses at the 30-min oracle mid", { exact: false })).toBeVisible();
  await expect(page.getByRole("img", { name: /Current phase: commit/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your orders" })).toHaveCount(0);
  await page.getByRole("button", { name: /Sell mAAPLx/ }).click();
  await expect(page.getByLabel("Order amount")).toBeVisible();
  await page.getByRole("button", { name: /Sell mcbAAPL/ }).click();
  await page.getByRole("button", { name: "Max" }).click();
  await expect(page.getByLabel("Order amount")).toHaveValue("500");
  await page.getByLabel("Order amount").fill("50");
  await expect(page.getByLabel("Limit price")).toHaveAttribute("placeholder", "1.0125");
  await page.getByRole("button", { name: "Place sealed order" }).click();
  await expect(page.getByText(/Order sealed/)).toBeVisible();
  const orders = page.getByRole("region", { name: "Your orders" });
  await expect(orders).toContainText("sealed");
  await expect(orders).toContainText("Sell 50 mcbAAPL");
  await expect(orders.getByRole("button", { name: "Copy transaction hash" })).toHaveCount(1);
  await page.getByRole("button", { name: "Reveal order" }).click();
  await expect(page.getByText(/Reveal confirmed/)).toBeVisible();
  await expect(orders).toContainText("revealed");
  await page.getByRole("button", { name: "Settle batch" }).click();
  await expect(page.getByText(/Batch crossed/)).toBeVisible();
  await expect(orders).toContainText("filled");
  await expect(orders.getByRole("button", { name: "Copy transaction hash" })).toHaveCount(3);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByText("Last crossed batch")).toBeVisible();
});

test("Pool: three tiles, recent fills, fee curve behind 'How fees work'", async ({ page }) => {
  await page.goto("/app?tab=pool");
  await expect(page.getByRole("region", { name: "Current fee" })).toContainText(`${v.parityFill.feeBps} bps`);
  await expect(page.getByRole("region", { name: "Inventory balance" })).toContainText("mcbAAPL 40.0% · 8,000");
  await expect(page.getByRole("region", { name: "Inventory balance" })).toContainText("total 20,250 shares");
  await expect(page.getByLabel("Inventory skew", { exact: true })).toHaveAttribute("value", "-0.2");
  await expect(page.getByRole("region", { name: "Market" })).toContainText(v.marketOpen ? "Open" : "Closed");
  await expect(page.getByRole("cell", { name: /101\.10\d* mAAPLx/ })).toBeVisible();
  await expect(page.locator(".curve")).toHaveCount(0);
  await page.getByRole("button", { name: "How fees work" }).click();
  const readout = page.locator(".curve-readout");
  await expect(readout).toContainText(`${v.parityFill.feeBps} bps`);
  const slider = page.getByLabel("Inventory skew (percent)");
  await slider.fill("0");
  await expect(readout).toContainText(v.marketOpen ? "2.00 bps" : "12.00 bps");
  await page.getByRole("button", { name: "Market open" }).click();
  await expect(readout).toContainText("2.00 bps");
  await slider.fill("100");
  await page.getByRole("button", { name: "Off-hours" }).click();
  await expect(readout).toContainText("25.00 bps");
});

test("every control produces a visible result (demo mode, all tabs)", async ({ page, context }) => {
  test.setTimeout(120000);
  await context.route(/uniscan\.xyz|github\.com/, (r) => r.fulfill({ body: "ok" }));
  const snapshot = () =>
    page.evaluate(() => ({
      html: document.querySelector("#root")!.innerHTML,
      values: [...document.querySelectorAll("input")].map((i) => i.value).join("|"),
      url: location.href,
    }));
  // The skip link is a keyboard control (off-screen until focused), so the pointer audit leaves it out.
  const CONTROLS = "button:visible:enabled:not([aria-current=page]), a[href]:visible:not(.skip)"; // the current tab is a no-op by design
  for (const tab of ["convert", "dark", "pool"]) {
    await demoConnected(page, `/app?tab=${tab}`);
    const count = await page.locator(CONTROLS).count();
    expect(count, `${tab}: controls found`).toBeGreaterThan(4);
    for (let i = 0; i < count; i++) {
      await demoConnected(page, `/app?tab=${tab}`);
      const el = page.locator(CONTROLS).nth(i);
      if (!(await el.count())) continue;
      const name = (await el.getAttribute("aria-label")) || (await el.innerText()).trim();
      if ((await el.getAttribute("target")) === "_blank") {
        const [popup] = await Promise.all([page.waitForEvent("popup"), el.click()]);
        expect(popup.url(), `${tab} · ${name}`).toMatch(/^https:\/\//);
        await popup.close();
        continue;
      }
      const before = await snapshot();
      await el.click();
      await page.waitForTimeout(250);
      const after = await snapshot();
      expect(JSON.stringify(after) !== JSON.stringify(before), `${tab} · "${name}" changed nothing`).toBe(true);
    }
  }
});

test("no empty fold at 1440×900: content reaches the fold, key numbers ≥ 28px, labels ≥ 14px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const checks: Record<string, string> = { convert: ".share-n", dark: ".status-line strong", pool: ".tile-v" };
  for (const [tab, big] of Object.entries(checks)) {
    await demoConnected(page, `/app?tab=${tab}`);
    const bottom = await page.evaluate(() =>
      Math.max(...[...document.querySelectorAll("main .card")].map((c) => c.getBoundingClientRect().bottom)),
    );
    expect(bottom, `${tab}: content bottom`).toBeGreaterThan(560);
    const size = await page.locator(big).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(size, `${tab}: key number size`).toBeGreaterThanOrEqual(28);
    const labels = await page
      .locator(".field-label, .tile-k, .cost-k, .card-title")
      .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(Math.min(...labels), `${tab}: smallest label`).toBeGreaterThanOrEqual(14);
    const width = await page.locator("main").evaluate((e) => e.getBoundingClientRect().width);
    expect(width, `${tab}: container`).toBeGreaterThan(1150);
  }
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
  await injectTestWallet(page, { account, chainId: RIGHT, known: [RIGHT] });
  await page.goto("/app");
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByLabel("Conversion amount").fill("100");
  await page.getByRole("button", { name: "Details", exact: true }).click();
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
