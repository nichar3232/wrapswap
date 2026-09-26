import { existsSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const read = (f: string) => {
  const u = new URL(`../../deployments/${f}`, import.meta.url);
  return existsSync(u) ? JSON.parse(readFileSync(u, "utf8")) : undefined;
};

test("Landing: Unison brand, four slides (hero, one price, flow, under the hood); header is logo, theme, Launch app", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Unison");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Unison");
  await expect(page.locator(".hero-copy p")).toHaveText(
    "One share is one share. Unison converts tokenized stocks across issuers at NAV parity, as a Uniswap v4 hook.",
  );
  await expect(page.getByText("WrapSwap", { exact: true })).toHaveCount(0);
  await expect(page.locator("body > #root > section")).toHaveCount(4);
  // Header: no section links, no dropdowns, no mobile menu.
  const header = page.locator("header.lnav");
  await expect(header.getByRole("link")).toHaveText(["", "unison", "Launch app"]);
  await expect(header.getByRole("link", { name: /Product|How it works|Developers/ })).toHaveCount(0);
  await expect(header.getByRole("button", { name: /menu/i })).toHaveCount(0);
  // How it works is the flow diagram alone: no heading, no product cards.
  const how = page.locator("#how-it-works");
  await expect(how.locator("h2, .steps4")).toHaveCount(0);
  await expect(how.locator(".convert-flow")).toHaveCount(1);
  // No Verify footer, no Developers page remnants.
  await expect(page.locator("#verify, footer, #proof, #developers, #architecture, #agents")).toHaveCount(0);
  await expect(page.getByText(/Live on|chain 1301/)).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/app?tab=pool"); // legacy link → Liquidity
  await expect(page).toHaveURL(/tab=liquidity/);
  await expect(page.getByText(/Inventory · skew/)).toBeVisible();
});

/**
 * The target is scrolled to the top of the viewport, or the page is scrolled to its end. On the landing deck a target
 * inside a slide (a How it works card) snaps to its slide: that slide is at the top and the target is fully in view.
 */
async function expectScrolledTo(page: Page, id: string) {
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return false; // not rendered yet
        const r = el.getBoundingClientRect();
        const atEnd =
          Math.ceil(scrollY + innerHeight) >=
          document.documentElement.scrollHeight - 1;
        const slide = el.closest("section");
        const inSlide =
          !!slide && slide !== el && Math.abs(slide.getBoundingClientRect().top) < 2 && r.top >= 0 && r.bottom <= innerHeight;
        return r.top < innerHeight && (Math.abs(r.top) < 2 || atEnd || inSlide);
      }, id),
    )
    .toBe(true);
}
async function expectAppTab(page: Page, tab: string) {
  await expect(page).toHaveURL(/\/app(\?tab=\w+(&mode=\w+)?)?$/);
  await expect(
    page.locator("header nav").getByRole("button", { name: tab, exact: true }),
  ).toHaveAttribute("aria-current", "page");
}
/** External links open a new tab; answer them locally so the check needs no network. */
async function expectPopup(page: Page, click: () => Promise<void>, url: RegExp) {
  await page
    .context()
    .route(/github\.com|uniscan\.xyz/, (r) => r.fulfill({ body: "ok" }));
  const [popup] = await Promise.all([page.waitForEvent("popup"), click()]);
  await expect(popup).toHaveURL(url);
  await popup.close();
}

test.describe("Landing controls all navigate or scroll", () => {
  test("CTAs: Launch app (header and last slide), Move your shares, See it onchain; brand links; the chart toggle", async ({ page }) => {
    for (const [where, name] of [
      ["header", "Launch app"],
      [".hero-copy", "Move your shares"],
      ["#tech", "Launch app"],
    ]) {
      await page.goto("/");
      await page.locator(where).getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(/\/app(\?tab=\w+)?$/);
      await expect(page.locator("header nav").getByRole("button", { name: "Portfolio", exact: true })).toBeVisible();
    }
    await page.goto("/");
    await page.getByRole("link", { name: "See it onchain →" }).click();
    await expectScrolledTo(page, "tech");
    for (const name of ["Unison home", "unison"]) {
      await page.goto("/#tech");
      await page.getByRole("link", { name, exact: true }).first().click();
      await expect(page).toHaveURL(/\/$/);
    }
    await page.goto("/developers"); // retired: old links land on the technical slide
    await expect(page).toHaveURL(/\/#tech$/);
    await expectScrolledTo(page, "tech");
    // "One price" chart: toggling collapses both pool lines onto NAV.
    await page.goto("/");
    const withUnison = page.getByRole("button", { name: "With Unison" });
    await withUnison.click();
    await expect(withUnison).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/Spread between issuers: 0/)).toBeVisible();
    await page.getByRole("button", { name: "Separate pools" }).click();
    await expect(page.getByText(/Peak spread between issuers/)).toBeVisible();
    await expect(page.locator("#one-price").getByText("Illustrative", { exact: true })).toBeVisible();
    // The xStocks line and its legend key are pink.
    const pink = "rgb(255, 126, 185)";
    await expect(page.locator(".op-line.op-x")).toHaveCSS("stroke", pink);
    await expect(page.locator(".op-key.op-x")).toHaveCSS("background-color", pink);
  });

  test("flow diagram: five nodes in one colour, dots moving along every arrow", async ({ page }) => {
    await page.goto("/");
    const flow = page.locator("#how-it-works .convert-flow");
    const nodes = [
      ["Oracle · peg guard", "Stops trade if gap > 50 bps"],
      ["User sends", "100 mcbAAPL, issuer A"],
      ["ParityHook, in the v4 pool", "Share for share, minus fee"],
      ["User receives", "101.08 mAAPLx, issuer B"],
      ["LP inventory", "Takes the other side, earns fee"],
    ];
    await expect(flow.locator(".cf-title")).toHaveText(nodes.map((n) => n[0]));
    await expect(flow.locator(".cf-sub")).toHaveText(nodes.map((n) => n[1]));
    await expect(flow.locator(".cf-caption")).toHaveText("Exchange A price · Exchange B price feed only this");
    await expect(flow.locator("figcaption")).toHaveText("Exchange prices never enter the conversion. Only the multipliers do.");
    const rects = flow.locator(".cf-node rect");
    expect(await rects.evaluateAll((r) => r.map((x) => x.getAttribute("height")))).toEqual(["56", "56", "56", "56", "56"]);
    const colours = await rects.evaluateAll((r) => r.map((x) => `${getComputedStyle(x).fill} ${getComputedStyle(x).stroke}`));
    expect(new Set(colours).size).toBe(1);
    // Two dots per arrow, each riding its arrow's path, and actually moving.
    const arrows = await flow.locator(".cf-arrow").evaluateAll((p) => p.map((x) => x.getAttribute("d")));
    expect(arrows).toHaveLength(4);
    const paths = await flow.locator(".cf-dot animateMotion").evaluateAll((m) => m.map((x) => x.getAttribute("path")));
    expect(paths).toHaveLength(8);
    expect(new Set(paths)).toEqual(new Set(arrows));
    const at = () =>
      flow
        .locator(".cf-dot")
        .first()
        .evaluate((c) => {
          const r = c.getBoundingClientRect();
          return `${Math.round(r.x)},${Math.round(r.y)}`;
        });
    const first = await at();
    await expect.poll(at, { timeout: 3000 }).not.toBe(first);
    expect(await flow.evaluate((e) => e.getBoundingClientRect().width)).toBeLessThanOrEqual(720);
    expect(await flow.locator("svg").innerHTML()).not.toMatch(/Gradient/);
    // Reduced motion hides the dots.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(flow.locator(".cf-dot").first()).toHaveCSS("display", "none");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("last slide: the technical essentials, the recorded agent run, Launch app, ParityHook and GitHub links", async ({ page }) => {
    const d = read("unichain-sepolia.resolved.json");
    // From the generated file (scripts/gen-mcp-demo.py), not typed values.
    const demo = read("unichain-sepolia.mcp-demo.json");
    await page.goto("/#tech");
    const t = page.locator("#tech");
    await expect(t.getByRole("heading", { level: 2 })).toHaveText("Under the hood");
    await expect(t.locator(".tech-list li strong")).toHaveText(["Uniswap v4 hook.", "Fees.", "Dark Cross.", "Send.", "Agents."]);
    await expect(t).toContainText("https://nichars-mac-mini.tail43cacc.ts.net/mcp");
    if (demo) await expect(t.getByRole("link", { name: /^0x[0-9a-f]{8}…[0-9a-f]{6} ↗$/ })).toHaveAttribute("href", `https://sepolia.uniscan.xyz/tx/${demo.tx}`);
    await expect(t.getByRole("link", { name: "Launch app", exact: true })).toHaveAttribute("href", "/app");
    if (d)
      await expectPopup(page, () => t.getByRole("link", { name: "ParityHook on Uniscan ↗" }).click(), new RegExp(`uniscan\\.xyz/address/${d.contracts.parityHook}`, "i"));
    await expectPopup(page, () => t.getByRole("link", { name: "GitHub ↗" }).click(), /github\.com\/nichar3232\/wrapswap/);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const mobile = width < 600;
    test.describe(`${width}×${height}`, () => {
      test.use({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile });
      test("landing is a snap deck: full-height sections, hero fits, one scroll lands on the next", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.goto("/");
        // Styles are injected by the module graph in dev; wait for the rendered landing before reading them.
        await expect(page.locator(".hero h1")).toHaveText("Unison");
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType)).toBe("y mandatory");
        const ids = ["product", "one-price", "how-it-works", "tech"];
        const boxes = await page.evaluate(
          (ids) =>
            ids.map((id) => document.getElementById(id)!).map((e) => ({
              h: e.getBoundingClientRect().height,
              snap: getComputedStyle(e).scrollSnapAlign,
            })),
          ids,
        );
        for (const [i, b] of boxes.entries()) {
          expect(b.h, ids[i]).toBeGreaterThanOrEqual(height);
          expect(b.snap, ids[i]).toBe("start");
        }
        expect(boxes[0].h, "hero fits in one viewport").toBe(height);
        // One scroll from the top lands the second section flush with the viewport top: a single arrow step (~40 px,
        // directional snap) on desktop; on mobile one touch swipe across 60% of the screen, with no fling so the
        // result is deterministic (a fling's distance varies run to run). Synthetic pixel wheel events snap to the
        // nearest section, unlike a notched wheel, so they can't stand in for one.
        if (mobile) {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Input.synthesizeScrollGesture", {
            x: width / 2,
            y: height * 0.8,
            yDistance: -Math.round(height * 0.6),
            speed: 1500,
            gestureSourceType: "touch",
            preventFling: true,
          });
        } else {
          await page.locator(".hero h1").click();
          await page.keyboard.press("ArrowDown");
        }
        await expect
          .poll(() => page.evaluate(() => Math.round(document.getElementById("one-price")!.getBoundingClientRect().top)), { timeout: 5000 })
          .toBe(0);
      });
    });
  }

  test("Verify footer in the app (not on the landing page): contracts from the manifests, MCP endpoint + command, GitHub", async ({ page }) => {
    const read = (f: string) => {
      const u = new URL(`../../deployments/${f}`, import.meta.url);
      return existsSync(u) ? JSON.parse(readFileSync(u, "utf8")) : undefined;
    };
    const d = read("unichain-sepolia.resolved.json"),
      sui = read("sui-testnet.json");
    const uni = (a: string) => `https://sepolia.uniscan.xyz/address/${a}`;
    const expected: [string, string][] = d
      ? [
          ["ParityHook", uni(d.contracts.parityHook)],
          ...d.assets.map((a: { symbol: string; darkCrossHook: string }) => [`DarkCross ${a.symbol}`, uni(a.darkCrossHook)] as [string, string]),
          ["Router", uni(d.contracts.wrapSwapRouter)],
          ["ShareVault", uni(d.send.shareVault)],
          ...(sui ? [["Sui package", `https://suiscan.xyz/testnet/object/${sui.sui.packageId}`] as [string, string]] : []),
        ]
      : [];
    const cmd = "claude mcp add unison --transport http https://nichars-mac-mini.tail43cacc.ts.net/mcp";
    for (const path of ["/app?tab=move"]) {
      await page.goto(path);
      const v = page.locator("footer#verify");
      await expect(v.getByRole("heading", { name: "Verify" })).toBeAttached();
      await expect(v.locator(".verify-line")).toHaveCount(3);
      const links = v.locator("[data-line=contracts] a");
      await expect(links).toHaveCount(expected.length);
      for (const [i, [name, href]] of expected.entries()) {
        await expect(links.nth(i)).toContainText(name);
        await expect(links.nth(i)).toHaveAttribute("href", href);
      }
      await expect(v.locator("[data-line=mcp] code")).toHaveText(["https://nichars-mac-mini.tail43cacc.ts.net/mcp", cmd]);
      await expect(v.locator("[data-line=source] a")).toHaveAttribute("href", "https://github.com/nichar3232/wrapswap");
    }
    await page.goto("/");
    await expect(page.locator("#verify")).toHaveCount(0);
  });

});
