import { test, expect, type Page } from "@playwright/test";
import { DEMO, type Network } from "@wrapswap/types";
import { MOCK_BATCH } from "../src/mocks/api";
import { injectTestWallet, setTxMode } from "./testWallet";

// Mock data (VITE_USE_MOCKS=true), Unichain Sepolia by default. Figures come from the shared formula.
const network = (process.env.VITE_NETWORK || "unichain-sepolia") as Network;
const account = DEMO.accounts.demo.anvilAddress;
const RIGHT = network === "unichain-sepolia" ? "0x515" : "0x7a69";
const RAW_ERROR = /SyntaxError|Unexpected (token|end)|TypeError|ReferenceError|HTTP \d{3}|Failed to fetch|\[object Object\]|undefined|NaN/;
const RETIRED = /off-hours|NYSE|market (open|closed)|parity gap fee|USD|\$\d/i;

const panel = (page: Page, id: string) => page.locator(`[data-panel="${id}"]`);
const tab = (page: Page, name: string) => page.locator("header nav").getByRole("button", { name, exact: true });
const convert = (page: Page) => page.locator("#pane-convert");
const dark = (page: Page) => page.locator("#pane-dark");
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
/** Mock mode, no injected wallet: the mock wallet connects itself. */
async function demo(page: Page, path = "/app") {
  await page.goto(path);
  await expect(page.getByRole("button", { name: /^Account 0x/ })).toBeVisible();
}
/** A wall-clock second inside mock batch `k` at `offset` seconds (commit 0–9, reveal 10–17, settle 18–23). */
const batchTime = (k: number, offset: number) => (MOCK_BATCH.origin + k * MOCK_BATCH.seconds + offset) * 1000;

test("nav: Portfolio · Move · Send · Liquidity with the asset picker; no console, raw or retired copy", async ({ page }) => {
  const errors = watchConsole(page);
  await demo(page);
  await expect(tab(page, "Portfolio")).toHaveAttribute("aria-current", "page");
  // The asset picker is not in the header: it sits in Move and Liquidity.
  await expect(page.locator("header").getByRole("radiogroup", { name: "Asset" })).toHaveCount(0);
  await expect(panel(page, "portfolio").getByRole("radiogroup", { name: "Asset" })).toHaveCount(0);
  for (const t of ["move", "liquidity"])
    await expect(panel(page, t).locator('.asset-pick [role="radio"]')).toHaveText(["AAPL", "NVDA", "TSLA"]); // inactive panels are aria-hidden
  // Header right: no network pill; the MCP toggle sits just left of the wallet.
  await expect(page.locator("header").getByTestId("status-pill")).toHaveCount(0);
  await expect(page.locator("header")).not.toContainText("Unichain Sepolia");
  const mcp = page.locator("header").getByRole("button", { name: "MCP" });
  const acct = page.locator("header").getByRole("button", { name: /^Account 0x|Connect wallet/ });
  const [m, a] = await Promise.all([mcp, acct].map((x) => x.evaluate((e) => e.getBoundingClientRect().toJSON())));
  expect(m.right).toBeLessThanOrEqual(a.left);
  await mcp.click();
  const dlg = page.getByRole("dialog", { name: "Use Unison from Claude (MCP)" });
  await expect(dlg).toContainText("https://nichars-mac-mini.tail43cacc.ts.net/mcp");
  await expect(dlg).toContainText("claude mcp add unison --transport http https://nichars-mac-mini.tail43cacc.ts.net/mcp");
  await expect(dlg.getByRole("button", { name: "Copy MCP endpoint" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.locator("header").getByText("Demo", { exact: true })).toBeVisible();
  for (const t of ["Move", "Send", "Liquidity", "Portfolio"]) {
    await tab(page, t).click();
    await expect(page.locator("main")).not.toContainText(RAW_ERROR);
    await expect(page.locator("main")).not.toContainText(RETIRED);
  }
  expect(errors).toEqual([]);
});

test("panels slide and lock; URL and ←/→ keys stay in sync; legacy ?tab= links redirect", async ({ page }) => {
  await demo(page);
  await tab(page, "Liquidity").click();
  await expect(page).toHaveURL(/tab=liquidity/);
  await expect(page.locator(".track")).toHaveAttribute("style", /translateX\(-300%\)/);
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Send")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/tab=move/);
  await expect(panel(page, "liquidity")).toHaveAttribute("inert", "");
  // Keys don't hijack typing.
  await convert(page).getByLabel("Amount", { exact: true }).press("ArrowLeft");
  await expect(page).toHaveURL(/tab=move/);
  for (const [legacy, now] of [["convert", "move"], ["dark", "move"], ["pool", "liquidity"]]) {
    await page.goto(`/app?tab=${legacy}`);
    await expect(page).toHaveURL(new RegExp(`tab=${now}`));
  }
});

test("asset picker: NVDA / TSLA switch every panel, and the choice survives a reload", async ({ page }) => {
  await demo(page, "/app?tab=move");
  await expect(convert(page).getByRole("radio", { name: /Coinbase/ })).toContainText("mcbAAPL");
  await panel(page, "move").getByRole("radio", { name: "NVDA" }).click();
  await expect(page).toHaveURL(/asset=NVDA/);
  await expect(convert(page).getByRole("radio", { name: /Coinbase/ })).toContainText("mcbNVDA");
  await expect(convert(page).locator(".unit")).toHaveText("mcbNVDA");
  await expect(convert(page).getByTestId("you-keep")).toContainText("→");
  await tab(page, "Liquidity").click();
  await expect(panel(page, "liquidity")).toContainText("NVDA · fee by direction now");
  await panel(page, "liquidity").getByRole("radio", { name: "TSLA" }).click();
  await expect(panel(page, "liquidity")).toContainText("TSLA · fee by direction now");
  await page.reload();
  await expect(panel(page, "liquidity").getByRole("radio", { name: "TSLA" })).toHaveAttribute("aria-checked", "true");
});

test("Portfolio: holdings per asset per wrapper in shares, faucet claim → cooldown, Convert prefills Move", async ({ page }) => {
  await demo(page);
  const p = panel(page, "portfolio");
  const aapl = p.getByRole("region", { name: "AAPL holdings" });
  await expect(aapl).toContainText("1,006.25"); // 500 mcbAAPL × 1.0125 + 500 mAAPLx
  await expect(aapl).toContainText("506.25 sh");
  await expect(p.getByRole("region", { name: "NVDA holdings" })).toContainText("Coinbase");
  await expect(p.getByRole("region", { name: "TSLA holdings" })).toContainText("xStocks");
  const faucet = p.getByRole("region", { name: "Test shares faucet" });
  await expect(faucet).toContainText("1,000 of each of 6 test wrappers, once a day");
  await faucet.getByRole("button", { name: "Claim test shares" }).click();
  await expect(faucet.getByTestId("faucet-cooldown")).toHaveText(/Next claim in 2[34]h \d\dm/);
  await expect(aapl).toContainText("3,018.75"); // + 1,000 of each wrapper: 1,500 × 1.0125 + 1,500
  await aapl.getByRole("button", { name: "Convert mAAPLx" }).click();
  await expect(tab(page, "Move")).toHaveAttribute("aria-current", "page");
  await expect(convert(page).getByRole("radio", { name: /xStocks/ })).toHaveAttribute("aria-checked", "true");
});

test("Convert: quote card (shares in · base · skew · You keep), parity line, receipt with fee split and new skew", async ({ page }) => {
  await demo(page, "/app?tab=move&asset=AAPL");
  const c = convert(page);
  await c.getByRole("radio", { name: /Coinbase/ }).click();
  await c.getByLabel("Amount", { exact: true }).fill("100");
  const card = c.getByRole("region", { name: "Quote" });
  await expect(card.locator(".qc-row")).toContainText("101.25");
  await expect(card.getByTestId("fee-breakdown")).toContainText("Base fee 2.00 bps · to LP0.02 sh");
  await expect(card.getByTestId("fee-breakdown")).toContainText("0 — this trade rebalances the pool");
  await expect(c.getByTestId("you-keep")).toContainText("101.25 → 101.23 AAPL shares");
  await expect(c).toContainText("Same share, converted at parity. Price gap between issuers is not charged.");
  // The other direction adds to the imbalance: a skew fee to the LP.
  await c.getByRole("button", { name: /^Flip/ }).click();
  await expect(card.getByTestId("fee-breakdown")).toContainText(/Skew fee \d+\.\d\d bps · to LP/);
  await c.getByRole("button", { name: /^Flip/ }).click();
  await c.getByRole("button", { name: "Convert", exact: true }).click();
  await expect(c.getByText("Converted (mock)")).toBeVisible();
  await expect(c.locator(".review-line")).toHaveText("101.25 AAPL shares on Coinbase (mock) → 101.23 on xStocks (mock)");
  await expect(c.getByTestId("fee-breakdown")).toContainText("0 — this trade rebalances the pool");
  await expect(c.getByTestId("receipt-skew")).toHaveText(/^\+20\.00% → \+19\.\d\d%$/);
  await expect(c.getByRole("button", { name: "Copy transaction hash" })).toBeVisible();
});

test("Convert: clicking a direction row selects it, sets from → to, and re-quotes", async ({ page }) => {
  await demo(page, "/app?tab=move&asset=AAPL");
  const c = convert(page);
  const card = c.getByRole("region", { name: "Quote" });
  const coinbase = c.getByRole("radio", { name: /Coinbase/ }),
    xstocks = c.getByRole("radio", { name: /xStocks/ });
  await expect(coinbase).toHaveAttribute("aria-checked", "true");
  await expect(card.getByTestId("fee-breakdown")).toContainText("0 — this trade rebalances the pool");
  await xstocks.click();
  await expect(xstocks).toHaveAttribute("aria-checked", "true");
  await expect(coinbase).toHaveAttribute("aria-checked", "false");
  await expect(c.locator(".pair-line")).toHaveText("xStocks (mock) → Coinbase (mock)");
  await expect(c.locator(".unit")).toHaveText("mAAPLx");
  await expect(card.getByTestId("fee-breakdown")).toContainText(/Skew fee \d+\.\d\d bps · to LP/);
  await expect(c.getByTestId("you-keep")).toContainText("100.00 → ");
  await coinbase.click();
  await expect(coinbase).toHaveAttribute("aria-checked", "true");
  await expect(c.locator(".pair-line")).toHaveText("Coinbase (mock) → xStocks (mock)");
  await expect(c.locator(".unit")).toHaveText("mcbAAPL");
  await expect(c.getByTestId("you-keep")).toContainText("101.25 → 101.23 AAPL shares");
});

test("Dark Cross: side + size → sealed commit; commit → reveal → settle; 3-row result; privacy line; history", async ({ page }) => {
  test.setTimeout(60000);
  const k = 5000;
  await page.clock.setFixedTime(batchTime(k, 1));
  await demo(page, "/app?tab=move&asset=AAPL");
  await page.getByRole("tab", { name: "Dark Cross" }).click();
  const x = dark(page);
  await expect(x.locator(".batch-strip")).toHaveAttribute("data-phase", "COMMIT");
  await expect(x.getByTestId("batch-countdown")).toContainText("Commit · 9s left");
  await expect(x).toContainText("Hidden until matched. Public on-chain after settlement.");
  await expect(x).toContainText("1.00 bp · protocol");
  // Same body as Convert: wrapper cards, flip, a direction line that carries the batch status.
  await x.getByRole("radio", { name: /Coinbase/ }).click();
  await expect(x.locator(".pair-line")).toContainText("Coinbase (mock) → xStocks (mock) · sell mcbAAPL");
  await x.getByLabel("Size").fill("60");
  await x.getByRole("button", { name: `Commit sealed order · batch #${k}` }).click();
  const order = x.getByRole("region", { name: "Your sealed order" });
  await expect(order.locator("li.on")).toHaveText(/Sealed/);
  await page.clock.setFixedTime(batchTime(k, 11));
  await expect(x.locator(".batch-strip")).toHaveAttribute("data-phase", "REVEAL", { timeout: 6000 });
  await expect(order.locator("li.on")).toHaveText(/Revealed/, { timeout: 8000 });
  await page.clock.setFixedTime(batchTime(k, 19));
  await expect(x.locator(".batch-strip")).toHaveAttribute("data-phase", "SETTLE", { timeout: 6000 });
  const result = x.getByTestId("settled-result");
  await expect(result).toBeVisible({ timeout: 10000 });
  await expect(result).toContainText("Crossed at the 30-min midpoint 1 bp venue fee · protocol");
  await expect(result).toContainText("50.63 → 50.62 sh"); // 50 mcbAAPL at mid 1.0125 (50.625 sh), less 1 bp; half-up
  await expect(result).toContainText("Residual via Convert base + skew · LP");
  await expect(result).toContainText("10.13 → 10.12 sh");
  await expect(result).toContainText("Unfilled, refunded0.00 sh");
  const history = x.locator("details.dark-history");
  await history.locator("summary").click(); // collapsed by default so the body fits one screen
  await expect(history.getByRole("row")).toHaveCount(4); // header + 3 settled batches
  await expect(history).toContainText("50.63 sh"); // 50.625, half-up
});

test("Liquidity: pool inventory, skew, the two directions toggle and drive the Convert button; no keeper block or LP economics", async ({ page }) => {
  await demo(page, "/app?tab=liquidity&asset=AAPL");
  const l = panel(page, "liquidity");
  await expect(l.getByRole("heading", { level: 1 })).toHaveText("Pool inventory");
  await expect(tab(page, "Liquidity")).toHaveText("Liquidity");
  await expect(l.getByTestId("skew")).toHaveText("skew +20.00%");
  await expect(l.getByRole("img", { name: /^Inventory: Coinbase \(mock\) 8,100\.00 shares, xStocks \(mock\) 12,150\.00 shares/ })).toBeVisible();
  await expect(l.getByRole("region", { name: "AAPL inventory" }).getByTestId("keeper-set")).toHaveText("Inventory set by pool keeper");
  await expect(l.getByRole("region", { name: /LP economics|Who supplies inventory/ })).toHaveCount(0);
  await expect(l).not.toContainText("LP fees earned");
  const dirs = l.getByRole("radiogroup", { name: "Direction" }).getByRole("radio");
  const cb = dirs.filter({ hasText: /^Coinbase \(mock\) → xStocks \(mock\)/ }),
    xs = dirs.filter({ hasText: /^xStocks \(mock\) → Coinbase \(mock\)/ });
  await expect(cb).toContainText("Coinbase (mock) → xStocks (mock)cheapest2.00 bps2.00 base · skew 0 — rebalances the pool");
  await expect(xs).toContainText(/\d\.\d\d bps2\.00 base \+ \d\.\d\d skew · to LP/);
  // Starts on the cheap direction; clicking the other selects it and re-labels the button.
  await expect(cb).toHaveAttribute("aria-checked", "true");
  await xs.click();
  await expect(xs).toHaveAttribute("aria-checked", "true");
  await expect(cb).toHaveAttribute("aria-checked", "false");
  const go = l.getByRole("button", { name: /^Convert xStocks \(mock\) → Coinbase \(mock\) · \d\.\d\d bps$/ });
  await expect(go).toBeVisible();
  await cb.click();
  await expect(cb).toHaveAttribute("aria-checked", "true");
  await xs.click();
  await go.click();
  await expect(tab(page, "Move")).toHaveAttribute("aria-current", "page");
  await expect(convert(page).getByRole("radio", { name: /xStocks/ })).toHaveAttribute("aria-checked", "true");
});

test("Send: the form and the three steps side by side, same width and height; no tracker, who-sees-what or use cases", async ({ page }) => {
  await demo(page, "/app?tab=send");
  const s = panel(page, "send");
  await expect(s.locator(".send-steps li")).toHaveCount(3);
  await expect(s).toContainText("Confidential, not anonymous. Operator-blind enclave on roadmap.");
  await expect(s).toContainText("Reserves");
  await expect(s.getByRole("table")).toHaveCount(0);
  await expect(s.locator(".send-tracker")).toHaveCount(0);
  for (const gone of ["Who sees what", "Private compensation", "Private settlement", "Keeper credits shares"]) await expect(s).not.toContainText(gone);
  const [form, side] = await Promise.all(
    [s.locator(".send-main .card").first(), s.locator(".send-side .card")].map((l) => l.evaluate((e) => e.getBoundingClientRect().toJSON())),
  );
  expect(Math.abs(form.top - side.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(form.bottom - side.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(form.width - side.width)).toBeLessThanOrEqual(1);
});

test("real (injected) wallet: wrong chain → add + switch; rejection and decoded reverts show the real reason", async ({ page }) => {
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
  const c = convert(page);
  await c.getByLabel("Amount", { exact: true }).fill("100");
  await setTxMode(page, "reject");
  await c.getByRole("button", { name: /^(Approve and )?convert$/i }).click();
  await expect(c.getByText("You rejected the request in your wallet. Nothing was sent.")).toBeVisible();
  await setTxMode(page, "revert-peg");
  await c.getByRole("button", { name: "Retry" }).click();
  await expect(c.getByText(/Peg guard: the pool drifted more than 50 bps/)).toBeVisible();
  await setTxMode(page, "revert-slippage");
  await c.getByRole("button", { name: "Retry" }).click();
  await expect(c.getByText(/fell below your 0.5% minimum/)).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/execution reverted|Internal JSON-RPC/);
});

test("every control produces a visible result (all panels, both Move modes)", async ({ page, context }) => {
  test.setTimeout(240000);
  await context.route(/uniscan\.xyz|github\.com/, (r) => r.fulfill({ body: "ok" }));
  await page.clock.setFixedTime(batchTime(6000, 1)); // a commit window, so Dark Cross controls are live
  const snapshot = () =>
    page.evaluate(() => ({
      html: document.querySelector("#root")!.innerHTML,
      values: [...document.querySelectorAll("input")].map((i) => i.value).join("|"),
      url: location.href,
    }));
  // The current tab / selected radio are no-ops by design; the skip link is keyboard-only; inert panels are excluded.
  const CONTROLS =
    "main :is(button, a[href]):visible:not([disabled]):not([aria-checked=true]):not([aria-selected=true]):not([inert] *), header :is(button):visible:not([disabled]):not([aria-current=page]):not([aria-checked=true])";
  const places: [string, (p: Page) => Promise<void>][] = [
    ["portfolio", async () => {}],
    ["move · convert", async () => {}],
    ["move · dark", async (p) => void (await p.getByRole("tab", { name: "Dark Cross" }).click())],
    ["send", async () => {}],
    ["liquidity", async () => {}],
  ];
  for (const [place, go] of places) {
    const path = `/app?tab=${place.split(" ")[0]}`;
    await demo(page, path);
    await go(page);
    const count = await page.locator(CONTROLS).count();
    expect(count, `${place}: controls`).toBeGreaterThan(2);
    for (let i = 0; i < count; i++) {
      await demo(page, path);
      await go(page);
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

test("key numbers ≥ 28px, labels ≥ 13px; content reaches the fold at 1440×900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const big: Record<string, string> = { portfolio: ".asset .tile-v", move: ".keep-v", liquidity: ".dir-v" };
  for (const [id, sel] of Object.entries(big)) {
    await demo(page, `/app?tab=${id}`);
    await expect(panel(page, id).locator(sel).first()).toBeVisible();
    const bottom = await panel(page, id).evaluate((p) => Math.max(...[...p.querySelectorAll(".card")].map((c) => c.getBoundingClientRect().bottom)));
    expect(bottom, `${id}: content bottom`).toBeGreaterThan(900 * 0.5); // Liquidity is two cards now (keeper + LP economics removed)
    expect(await panel(page, id).locator(sel).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize)), `${id}: key number`).toBeGreaterThanOrEqual(28);
    const labels = await panel(page, id)
      .locator(".field-label, .tile-k, .card-title, .choice-sub")
      .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent && e.textContent?.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(Math.min(...labels), `${id}: smallest label`).toBeGreaterThanOrEqual(13);
  }
});

test("responsive: 390px has no sideways page scroll on any panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of ["portfolio", "move", "send", "liquidity"]) {
    await demo(page, `/app?tab=${id}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), id).toBe(true);
  }
});

test("e2e/demo.spec selector contract: its Convert steps resolve to exactly one element each", async ({ page }) => {
  await injectTestWallet(page, { account, chainId: RIGHT, known: [RIGHT] });
  const pane = page.locator("#pane-convert");
  await page.goto("/app?tab=move&asset=AAPL");
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await pane.getByRole("radio", { name: /Coinbase/ }).click();
  await pane.getByLabel("Amount", { exact: true }).fill("100");
  await expect(pane.getByTestId("fee-breakdown").getByText(/2\.00\s*bps/)).toBeVisible();
  await expect(pane.getByTestId("you-keep")).toContainText("→");
  await pane.getByRole("button", { name: /^(approve and )?convert$/i }).click();
  await expect(pane.getByText(/^\s*Converted\b/)).toBeVisible({ timeout: 30000 });
  await tab(page, "Liquidity").click();
  await expect(page.getByText(/20(?:\.0+)?\s*%/).first()).toBeVisible(); // demo.spec expects 19% after its real fill
  await tab(page, "Move").click();
  await page.getByRole("tab", { name: "Dark Cross" }).click();
  await expect(page.locator("#pane-dark").getByText(/cross/i).first()).toBeVisible();
  await expect(page.locator("#pane-dark").getByText(/residual/i).first()).toBeVisible();
});

test("Recent fills: a Convert and a Dark Cross commit from this page are listed at once, above the indexed fills", async ({ page }) => {
  test.setTimeout(60000);
  const k = 5000;
  await page.clock.setFixedTime(batchTime(k, 1));
  await demo(page, "/app?tab=move&asset=AAPL");
  const c = convert(page);
  await c.getByRole("radio", { name: /Coinbase/ }).click();
  await c.getByLabel("Amount", { exact: true }).fill("100");
  await c.getByRole("button", { name: "Convert", exact: true }).click();
  await expect(c.getByText("Converted (mock)")).toBeVisible();
  await page.getByRole("tab", { name: "Dark Cross" }).click();
  const x = dark(page);
  await x.getByLabel("Size").fill("10");
  await x.getByRole("button", { name: `Commit sealed order · batch #${k}` }).click();
  await expect(x.getByRole("region", { name: "Your sealed order" })).toBeVisible();
  await tab(page, "Portfolio").click();
  const rows = panel(page, "portfolio").getByRole("region", { name: "Recent fills" }).locator("li");
  await expect(rows.nth(0)).toHaveAttribute("data-activity", "DARK-COMMIT");
  await expect(rows.nth(0)).toContainText(`Dark Cross commit · 10.13 AAPL sh mcbAAPL · batch #${k}`);
  await expect(rows.nth(1)).toHaveAttribute("data-activity", "PARITY");
  await expect(rows.nth(1)).toContainText("101.25 → 101.23 AAPL sh · mcbAAPL → mAAPLx");
  await expect(rows.nth(1)).toContainText("Convert (mock)");
  // Indexed fills still follow, up to eight rows in all.
  expect(await rows.count()).toBeGreaterThan(2);
  expect(await rows.count()).toBeLessThanOrEqual(8);
  // Kept for this address across a reload.
  await page.reload();
  await expect(panel(page, "portfolio").getByRole("region", { name: "Recent fills" }).locator("li[data-activity]")).toHaveCount(2);
});

for (const [width, height] of [
  [1440, 900],
  [1366, 768],
]) {
  test(`each tab fits one screen at ${width}×${height}: Move (Convert, Dark Cross), Send, Liquidity, Portfolio`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const [t, q] of [
      ["move", ""],
      ["move", "&mode=dark"],
      ["send", ""],
      ["liquidity", ""],
      ["portfolio", ""],
    ]) {
      await demo(page, `/app?asset=AAPL&tab=${t}${q}`);
      const p = panel(page, t);
      await expect(p.locator(".card").first()).toBeVisible();
      await page.waitForTimeout(500);
      const m = await p.evaluate((e) => ({ client: e.clientHeight, scroll: e.scrollHeight, main: document.querySelector("main")!.getBoundingClientRect().bottom }));
      expect(m.scroll, `${t}${q} content fits its panel`).toBeLessThanOrEqual(m.client + 1);
      expect(m.main, `${t}${q} panel ends at the bottom of the window`).toBeLessThanOrEqual(height + 1);
    }
  });
}

test("Convert receipt: In and Out in tokens (4 places) and shares (2, half-up), the multiplier under Out, fee as bps · shares, exact values on hover", async ({ page }) => {
  await demo(page, "/app?tab=move&asset=AAPL");
  const c = convert(page);
  await c.getByRole("radio", { name: /Coinbase/ }).click();
  await c.getByLabel("Amount", { exact: true }).fill("100");
  await c.getByRole("button", { name: "Convert", exact: true }).click();
  await expect(c.getByText("Converted (mock)")).toBeVisible();
  await expect(c.locator(".receipt-rows dt").first()).toHaveText("In");
  await expect(c.locator(".receipt-rows > div").first()).toContainText("100.0000 mcbAAPL · 101.25 sh");
  const out = c.getByTestId("receipt-out");
  await expect(out).toHaveText(/^101\.2298 mAAPLx · 101\.23 sh$/); // 101.22975 at multiplier 1: tokens 4 places and shares 2, both half-up
  await expect(c.getByTestId("receipt-multiplier")).toHaveText("1 xStocks (mock) token = 1.0000 sh (multiplier)");
  await expect(c.getByTestId("receipt-fee")).toHaveText("2.00 bps · 0.02 sh");
  // Every number carries its exact value.
  await expect(out.locator(".num").nth(1)).toHaveAttribute("title", "101.22975 shares (raw 101229750000000000000)");
  await expect(c.getByTestId("receipt-fee").locator(".num").first()).toHaveAttribute("title", /^200 pips/);
});

test("Convert all to xStocks: every Coinbase (mock) holding in one go; after-state with new holdings, tx links and the cost comparison", async ({ page }) => {
  await demo(page, "/app?tab=portfolio&asset=AAPL");
  const p = panel(page, "portfolio");
  await expect(p.getByRole("region", { name: "AAPL holdings" })).toContainText("Coinbase (mock)");
  const card = p.getByRole("region", { name: "Convert all to xStocks" });
  await expect(card).toContainText("shares across AAPL, NVDA, TSLA → xStocks (mock)");
  await card.getByRole("button", { name: "Convert all to xStocks" }).click();
  const done = p.getByRole("region", { name: "Converted all to xStocks" });
  await expect(done).toBeVisible({ timeout: 20000 });
  const legs = done.locator("table.all-legs tbody tr");
  await expect(legs).toHaveCount(3);
  await expect(legs.nth(0)).toContainText("AAPL");
  await expect(legs.nth(0)).toContainText("1 xStocks (mock) token = 1.0000 sh (multiplier)");
  await expect(legs.nth(1)).toContainText("1 xStocks (mock) token = 1.0050 sh (multiplier)"); // NVDA xStocks multiplier 1.005
  for (let i = 0; i < 3; i++) {
    await expect(legs.nth(i).locator("td").nth(3)).toHaveText(/^\d+\.\d\d bps · \d+\.\d\d sh$/);
    await expect(legs.nth(i).getByRole("button", { name: /Copy transaction hash/ })).toBeVisible();
  }
  // New holdings: nothing left on Coinbase (mock).
  const holdings = done.locator(".new-holdings li");
  await expect(holdings.filter({ hasText: "Coinbase (mock)" })).toHaveCount(3);
  for (const li of await holdings.filter({ hasText: "Coinbase (mock)" }).all()) await expect(li).toContainText("0.00 sh");
  // Cost comparison: the real fee vs. an illustrative sell + rebuy, and the saving.
  await expect(done.getByTestId("cost-unison")).toHaveText(/^\d+\.\d\d bps · \d+\.\d\d sh$/);
  await expect(done.getByTestId("cost-alt")).toHaveText(/^45\.00 bps · [\d,]+\.\d\d sh$/);
  await expect(done.getByTestId("cost-saved")).toHaveText(/^[\d,]+\.\d\d sh$/);
  await expect(done).toContainText("Illustrative, not a quote");
  await done.getByRole("button", { name: "Back to portfolio" }).click();
  await expect(p.getByRole("region", { name: "Convert all to xStocks" })).toContainText("Everything is already in xStocks (mock).");
  // Recent fills lists the three conversions at once.
  await expect(p.getByRole("region", { name: "Recent fills" }).locator('li[data-activity="PARITY"]')).toHaveCount(3);
});
