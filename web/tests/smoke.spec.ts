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

const panel = (page: Page, id: string) => page.locator(`[data-panel="${id}"]`);
const step = (page: Page) => page.locator(".step:not([inert])");
const tab = (page: Page, name: string) => page.locator("header nav").getByRole("button", { name, exact: true });
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
/** Demo mode: no injected wallet; the simulated wallet connects itself. */
async function demo(page: Page, path = "/app") {
  await page.goto(path);
  await expect(page.getByRole("button", { name: /^Account 0x/ })).toBeVisible();
}
/** Drive Move to the Review step with the given choices. */
async function toReview(page: Page, opts: { from?: RegExp; amount?: string; method?: "Instant" | "Sealed cross" } = {}) {
  if (opts.from) await step(page).getByRole("radio", { name: opts.from }).click();
  await page.getByLabel("Move amount").fill(opts.amount ?? "100");
  await step(page).getByRole("button", { name: "Next" }).click();
  await step(page).getByRole("button", { name: "Next" }).click();
  await step(page).getByRole("radio", { name: new RegExp(opts.method ?? "Instant") }).click();
  await step(page).getByRole("button", { name: "Next" }).click();
  await expect(step(page).getByRole("heading", { name: "Review" })).toBeVisible();
}

test("nav: Portfolio · Move · Liquidity, network badge, Demo badge; no console or raw errors", async ({ page }) => {
  const errors = watchConsole(page);
  await demo(page);
  await expect(tab(page, "Portfolio")).toHaveAttribute("aria-current", "page");
  await expect(page.locator("header").getByTestId("status-pill")).toHaveText(/^(Unichain Sepolia|Anvil)$/);
  await expect(page.locator("header").getByText("Demo", { exact: true })).toBeVisible();
  await expect(page.locator("footer")).toHaveCount(0);
  for (const t of ["Move", "Liquidity", "Portfolio"]) {
    await tab(page, t).click();
    await expect(page.locator("main")).not.toContainText(RAW_ERROR);
  }
  expect(errors).toEqual([]);
});

test("panels slide and lock; URL and ←/→ keys stay in sync; legacy ?tab= links redirect", async ({ page }) => {
  await demo(page);
  await tab(page, "Liquidity").click();
  await expect(page).toHaveURL(/tab=liquidity/);
  await expect(page.locator(".track")).toHaveAttribute("style", /translateX\(-200%\)/);
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Move")).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/tab=move/);
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/tab=portfolio/);
  await expect(panel(page, "move")).toHaveAttribute("inert", "");
  // Keys don't hijack typing.
  await tab(page, "Move").click();
  await page.getByLabel("Move amount").press("ArrowLeft");
  await expect(page).toHaveURL(/tab=move/);
  for (const [legacy, now] of [["convert", "move"], ["dark", "move"], ["pool", "liquidity"]]) {
    await page.goto(`/app?tab=${legacy}`);
    await expect(page).toHaveURL(new RegExp(`tab=${now}`));
  }
});

test("Portfolio: total shares, rows per platform, Move prefills From", async ({ page }) => {
  await demo(page);
  const p = panel(page, "portfolio");
  await expect(p.getByText("1,006.25", { exact: false })).toBeVisible(); // 500 mcbAAPL × 1.0125 + 500 mAAPLx
  await expect(p.getByText("Coinbase", { exact: true })).toBeVisible();
  await expect(p.getByText("506.25 shares")).toBeVisible();
  await expect(p.getByText("testnet mocks", { exact: false })).toBeVisible();
  await expect(p.getByText("Get test shares")).toHaveCount(0); // no faucet contract is deployed
  await p.getByRole("button", { name: "Move" }).nth(1).click(); // xStocks row
  await expect(tab(page, "Move")).toHaveAttribute("aria-current", "page");
  await expect(step(page).getByRole("radio", { name: /xStocks/ })).toHaveAttribute("aria-checked", "true");
});

test("demo Move · Instant end to end: shares after fee, Details, receipt", async ({ page }) => {
  await demo(page, "/app?tab=move");
  await toReview(page, { from: /Coinbase/ });
  const review = step(page);
  await expect(review.locator(".review-line")).toHaveText("101.25 AAPL shares on Coinbase → 101.10 AAPL shares on xStocks");
  await expect(review).toContainText(`${v.parityFill.feeBps} bps`);
  await expect(review).toContainText("99.85%");
  await review.getByRole("button", { name: "Details", exact: true }).click();
  await expect(review.getByText("PARITY", { exact: true })).toBeVisible();
  await expect(review.getByTestId("fee-breakdown")).toContainText(`${v.parityFill.feeBps} bps`);
  await review.getByRole("button", { name: "Move", exact: true }).click();
  const done = step(page);
  await expect(done.getByText("Conversion confirmed (simulated)")).toBeVisible();
  await expect(done.locator(".review-line")).toContainText("101.10 AAPL shares on xStocks");
  await expect(done.getByRole("button", { name: "Copy transaction hash" })).toBeVisible();
  await tab(page, "Portfolio").click();
  await expect(panel(page, "portfolio").getByText("405.00 shares")).toBeVisible(); // 400 mcbAAPL left
});

test("demo Move · Sealed cross end to end: real quote, tracker Sealed → Revealed → Crossed, receipt", async ({ page }) => {
  test.setTimeout(45000);
  await demo(page, "/app?tab=move");
  await step(page).getByRole("radio", { name: /Coinbase/ }).click();
  await page.getByLabel("Move amount").fill("100");
  await step(page).getByRole("button", { name: "Next" }).click();
  await step(page).getByRole("button", { name: "Next" }).click();
  const how = step(page);
  const sealed = how.getByRole("radio", { name: /Sealed cross/ });
  await expect(sealed).toContainText("101.19"); // 100 mcbAAPL × 1.0125 at mid, less the 5 bps cross fee
  await expect(sealed).toContainText("5.00 bps on crossed volume");
  await expect(sealed).not.toContainText("0 fee");
  await sealed.click();
  await expect(how.getByText("= oracle mid")).toBeVisible();
  await expect(how.getByLabel("Limit price")).toHaveValue("1.0125");
  await how.getByRole("button", { name: "Next" }).click();
  await step(page).getByRole("button", { name: "Move", exact: true }).click();
  const tracker = page.locator(".tracker");
  await expect(tracker.locator("li.on")).toHaveText(/Sealed/);
  await expect(tracker.locator("li.on")).toHaveText(/Revealed/, { timeout: 10000 });
  await expect(tracker.getByText("Crossed at the oracle mid (simulated)")).toBeVisible({ timeout: 12000 });
  await expect(tracker).toContainText("101.25 → 101.19 AAPL");
  await expect(tracker).toContainText("Residual via pool");
});

test("deliver-to: validates the address, hides Sealed cross for other recipients, shows the recipient", async ({ page }) => {
  await demo(page, "/app?tab=move");
  await page.getByLabel("Move amount").fill("10");
  await step(page).getByRole("button", { name: "Next" }).click();
  const to = step(page);
  await to.getByRole("radio", { name: "Another address" }).click();
  await to.getByLabel("Recipient address").fill("0x1234");
  await expect(to.getByText(/Enter a valid 0x address/)).toBeVisible();
  await expect(to.getByRole("button", { name: "Next" })).toBeDisabled();
  await to.getByLabel("Recipient address").fill("0x0000000000000000000000000000000000000000");
  await expect(to.getByRole("button", { name: "Next" })).toBeDisabled();
  const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  await to.getByLabel("Recipient address").fill(other);
  await to.getByRole("button", { name: "Next" }).click();
  await expect(step(page).getByRole("radio", { name: /Sealed cross/ })).toHaveCount(0); // settlement has no recipient
  await step(page).getByRole("button", { name: "Next" }).click();
  await expect(step(page).getByRole("button", { name: "Copy address" })).toBeVisible();
});

test("Liquidity: direction-aware fees, balance diagram, the highlighted direction prefills Move", async ({ page }) => {
  await demo(page, "/app?tab=liquidity");
  const l = panel(page, "liquidity");
  await expect(l.getByText("Coinbase → xStocks")).toBeVisible();
  await expect(l.getByText("rebalances the pool")).toBeVisible();
  await expect(l.getByRole("img", { name: /Inventory balance/ })).toBeVisible();
  await expect(l.getByRole("region", { name: "Market" })).toContainText(v.marketOpen ? "Open" : "Moves live 24/7");
  await expect(l.getByRole("cell", { name: /Instant/ }).first()).toBeVisible();
  await l.getByRole("button", { name: /Move the (cheap|rebalancing) direction/ }).click();
  await expect(tab(page, "Move")).toHaveAttribute("aria-current", "page");
  await expect(step(page).getByRole("radio", { name: /Coinbase/ })).toHaveAttribute("aria-checked", "true");
  await tab(page, "Liquidity").click();
  await l.getByRole("button", { name: "How fees work" }).click();
  await expect(l.getByRole("button", { name: "Rebalances" })).toBeVisible();
  await l.getByLabel("Inventory skew (percent)").fill("0");
  await l.getByRole("button", { name: "Market open" }).click();
  await expect(l.locator(".curve-readout")).toContainText("2.00 bps");
});

test("real (injected) wallet: wrong chain → add + switch; Move rejection and revert show a reason and Retry", async ({ page }) => {
  test.skip(network !== "unichain-sepolia", "the add-chain flow targets Unichain Sepolia");
  await injectTestWallet(page, { account, chainId: "0x1" });
  await page.goto("/app?tab=move");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.locator("header").getByRole("button", { name: "Switch to Unichain Sepolia" }).click();
  expect((await page.evaluate(() => (window as any).__wallet.added))[0]).toMatchObject({
    chainId: "0x515",
    rpcUrls: ["https://sepolia.unichain.org"],
    blockExplorerUrls: ["https://sepolia.uniscan.xyz"],
    nativeCurrency: { symbol: "ETH" },
  });
  await toReview(page, { from: /Coinbase/ });
  await setTxMode(page, "reject");
  await step(page).getByRole("button", { name: "Move", exact: true }).click();
  await expect(step(page).getByText("You rejected the request in your wallet. Nothing was sent.")).toBeVisible();
  await setTxMode(page, "revert-peg");
  await step(page).getByRole("button", { name: "Retry" }).click();
  await expect(step(page).getByText(/Peg guard: the pool drifted more than 50 bps/)).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/execution reverted|PegGuardTripped/);
});

test("every control produces a visible result (demo mode, all panels and Move steps)", async ({ page, context }) => {
  test.setTimeout(240000);
  await context.route(/uniscan\.xyz|github\.com/, (r) => r.fulfill({ body: "ok" }));
  const snapshot = () =>
    page.evaluate(() => ({
      html: document.querySelector("#root")!.innerHTML,
      values: [...document.querySelectorAll("input")].map((i) => i.value).join("|"),
      url: location.href,
    }));
  // The current tab is a no-op by design; the skip link is keyboard-only; inert panels are excluded by :visible.
  // A radio that is already selected is a no-op by design, like the current tab.
  const CONTROLS =
    "main :is(button, a[href]):visible:not([disabled]):not([aria-checked=true]):not([inert] *), header :is(button):visible:not([disabled]):not([aria-current=page])";
  const places: [string, (p: Page) => Promise<void>][] = [
    ["portfolio", async () => {}],
    ["liquidity", async () => {}],
    ["move · from", async () => {}],
    ["move · to", async (p) => void (await step(p).getByRole("button", { name: "Next" }).click())],
    [
      "move · how",
      async (p) => {
        await step(p).getByRole("button", { name: "Next" }).click();
        await step(p).getByRole("button", { name: "Next" }).click();
      },
    ],
    ["move · review", async (p) => void (await toReview(p))],
  ];
  for (const [place, go] of places) {
    const path = `/app?tab=${place.split(" ")[0]}`;
    await demo(page, path);
    await go(page);
    await page.waitForTimeout(400); // let the step slide finish
    const count = await page.locator(CONTROLS).count();
    expect(count, `${place}: controls`).toBeGreaterThan(2);
    for (let i = 0; i < count; i++) {
      await demo(page, path);
      await go(page);
      await page.waitForTimeout(400);
      const el = page.locator(CONTROLS).nth(i);
      if (!(await el.count())) continue;
      const name = (await el.getAttribute("aria-label")) || (await el.innerText()).trim();
      if ((await el.getAttribute("target")) === "_blank") {
        const [popup] = await Promise.all([page.waitForEvent("popup"), el.click()]);
        expect(popup.url(), `${place} · ${name}`).toMatch(/^https:\/\//);
        await popup.close();
        continue;
      }
      const before = await snapshot();
      await el.click({ timeout: 5000 }).catch((e) => {
        throw new Error(`${place} · "${name}" is not clickable: ${String(e).split("\n")[0]}`);
      });
      await page.waitForTimeout(350);
      expect(JSON.stringify(await snapshot()) !== JSON.stringify(before), `${place} · "${name}" changed nothing`).toBe(true);
    }
  }
});

test("no empty fold at 1440×900 and 2560 wide: content reaches the fold, numbers ≥ 28px, labels ≥ 14px", async ({ page }) => {
  for (const [w, h] of [
    [1440, 900],
    [2560, 1440],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    const big: Record<string, string> = { portfolio: ".asset .tile-v", move: ".step:not([inert]) .amount", liquidity: ".dir-v" };
    for (const [id, sel] of Object.entries(big)) {
      await demo(page, `/app?tab=${id}`);
      const bottom = await panel(page, id).evaluate((p) => Math.max(...[...p.querySelectorAll(".card")].map((c) => c.getBoundingClientRect().bottom)));
      expect(bottom, `${id} @${w}: content bottom`).toBeGreaterThan(h * 0.6);
      expect(
        await panel(page, id).locator(sel).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
        `${id}: key number`,
      ).toBeGreaterThanOrEqual(28);
      const labels = await panel(page, id)
        .locator(".field-label, .tile-k, .card-title, .stepper li, .choice-sub")
        .evaluateAll((els) =>
          els.filter((e) => (e as HTMLElement).offsetParent && e.textContent?.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize)),
        );
      expect(Math.min(...labels), `${id}: smallest label`).toBeGreaterThanOrEqual(14);
    }
  }
});

test("responsive: 390px has no sideways page scroll on any panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of ["portfolio", "move", "liquidity"]) {
    await demo(page, `/app?tab=${id}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("e2e/demo.spec selector contract: its Move steps resolve to exactly one element each", async ({ page }) => {
  await injectTestWallet(page, { account, chainId: RIGHT, known: [RIGHT] });
  await page.goto("/app?tab=move");
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await step(page).getByRole("radio", { name: /Coinbase/ }).click();
  await page.getByLabel("Move amount").fill("100");
  await step(page).getByRole("button", { name: "Next" }).click();
  await step(page).getByRole("button", { name: "Next" }).click();
  await step(page).getByRole("radio", { name: /Instant/ }).click();
  await step(page).getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByText("PARITY", { exact: true })).toBeVisible();
  await expect(page.getByTestId("fee-breakdown").getByText(new RegExp(v.parityFill.feeBps.replace(".", "\\.") + "\\s*bps"))).toBeVisible();
  await step(page).getByRole("button", { name: /^move$/i }).click();
  await expect(page.getByText(/conversion confirmed/i)).toBeVisible({ timeout: 30000 });
  await tab(page, "Liquidity").click();
  await expect(page.getByText(/20(?:\.0+)?\s*%/).first()).toBeVisible(); // demo.spec expects 19% after its real fill
  await tab(page, "Move").click();
  await step(page).getByRole("button", { name: "Move again" }).click();
  await step(page).getByRole("button", { name: "Next" }).click();
  await step(page).getByRole("button", { name: "Next" }).click();
  await expect(step(page).getByText(/cross/i).first()).toBeVisible();
  await expect(step(page).getByText(/residual/i).first()).toBeVisible();
});
