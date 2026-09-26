import { existsSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

test("Landing: Unison brand, four products; no Developers page, contracts in the Verify footer", async ({
  page,
}) => {
  const file = new URL(
    "../../deployments/unichain-sepolia.resolved.json",
    import.meta.url,
  );
  const d = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : undefined;
  await page.goto("/");
  await expect(page).toHaveTitle("Unison");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Unison");
  await expect(page.getByText("WrapSwap", { exact: true })).toHaveCount(0);
  const how = page.locator("#how-it-works");
  await expect(how.locator(".steps4 p")).toHaveText([
    "Convert — Swap one issuer's AAPL wrapper for another's share-for-share, based on what each wrapper represents, not the market price. Fee: 2 bps + skew, to the LP.",
    "Dark Cross — On-chain dark pool. Orders are sealed until matched, cross at the 30-minute oracle midpoint for a 1 bp venue fee, residual routes through Convert.",
    "Send — Confidential payment on Sui. Amount hidden by Seal encryption; recipient withdraws into any issuer's wrapper.",
    "Liquidity — Supply both wrappers, earn every Convert fee. Skew fee rises against imbalance so inventory stays balanced.",
  ]);
  await expect(how).not.toContainText(/\b0[1-4]\b|Try it/);
  expect(await how.locator("h2").evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeLessThanOrEqual(32);
  expect(await how.locator(".steps4 p").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBe(14);
  // One row of four at desktop width.
  const tops = await how.locator(".steps4 li").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(page.locator("#proof, #developers, #architecture, #agents")).toHaveCount(0);
  await expect(page.getByText(/Live on|chain 1301/)).toHaveCount(0);
  if (!d) await expect(page.locator("#verify")).toContainText("Deployment addresses are being published.");
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: "Launch app" }).first().click();
  await expect(page).toHaveURL(/\/app(\?tab=portfolio)?$/);
  await expect(
    page.getByRole("button", { name: "Portfolio", exact: true }),
  ).toBeVisible();
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
  test("nav labels scroll to their sections", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "How it works", exact: true }).click();
    await expectScrolledTo(page, "how-it-works");
    await expect(page.locator("header").getByRole("link", { name: "Developers" })).toHaveCount(0);
    await page.goto("/");
    await page.evaluate(() => scrollTo(0, 40));
    await page.getByRole("link", { name: "Product", exact: true }).click();
    await expectScrolledTo(page, "product");
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  });

  test("every dropdown opens, closes, and each item navigates", async ({
    page,
  }) => {
    const menus: [string, [string, (p: Page) => Promise<void>][]][] = [
      [
        "Product",
        [
          ["Portfolio", (p) => expectAppTab(p, "Portfolio")],
          ["Move", (p) => expectAppTab(p, "Move")],
          ["Send", (p) => expectAppTab(p, "Send")],
          ["Liquidity", (p) => expectAppTab(p, "Liquidity")],
        ],
      ],
      [
        "How it works",
        [
          ["Convert", (p) => expectScrolledTo(p, "how-convert")],
          ["Dark Cross", (p) => expectScrolledTo(p, "how-dark")],
          ["Send", (p) => expectScrolledTo(p, "how-send")],
          ["Liquidity", (p) => expectScrolledTo(p, "how-liquidity")],
        ],
      ],
    ];
    for (const [menu, items] of menus) {
      await page.goto("/");
      const toggle = page.getByRole("button", { name: `${menu} menu` });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await page.locator("h1").click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      for (const [label, check] of items) {
        await page.goto("/");
        await page.getByRole("button", { name: `${menu} menu` }).click();
        await page
          .locator(`#menu-${menu === "How it works" ? "how-it-works" : menu.toLowerCase()}`)
          .getByRole("link", { name: label, exact: true })
          .click();
        await check(page);
      }
    }
  });

  test("CTAs, product cards, brand links, theme and footer", async ({
    page,
  }) => {
    for (const [where, name] of [
      ["header", "Launch app"],
      [".hero-copy", "Move your shares"],
    ]) {
      await page.goto("/");
      await page.locator(where).getByRole("link", { name }).click();
      await expectAppTab(page, "Portfolio");
    }
    await page.goto("/");
    await page.getByRole("link", { name: "See it onchain →" }).click();
    await expectScrolledTo(page, "verify");
    for (const [i, tab] of ["Move", "Move", "Send", "Liquidity"].entries()) {
      await page.goto("/");
      await page.locator("#how-it-works .steps4 a").nth(i).click();
      await expectAppTab(page, tab);
      if (i === 1) await expect(page.getByRole("tab", { name: "Dark Cross" })).toHaveAttribute("aria-selected", "true");
    }
    for (const name of ["Unison home", "unison"]) {
      await page.goto("/#verify");
      await page.getByRole("link", { name, exact: true }).first().click();
      await expect(page).toHaveURL(/\/$/);
    }
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle color theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Toggle color theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // "One price" chart: toggling collapses both pool lines onto NAV.
    const withUnison = page.getByRole("button", { name: "With Unison" });
    await withUnison.click();
    await expect(withUnison).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/Spread between issuers: 0/)).toBeVisible();
    await page.getByRole("button", { name: "Separate pools" }).click();
    await expect(page.getByText(/Peak spread between issuers/)).toBeVisible();
    await expect(page.locator("#one-price").getByText("Illustrative", { exact: true })).toBeVisible();
    await expectPopup(
      page,
      () => page.locator("footer").getByRole("link", { name: "GitHub ↗" }).click(),
      /github\.com\/nichar3232\/wrapswap/,
    );
    const explorer = page.locator("#verify [data-line=contracts]").getByRole("link");
    for (let i = 0; i < (await explorer.count()); i++)
      await expectPopup(page, () => explorer.nth(i).click(), /uniscan\.xyz\/address\/|suiscan\.xyz\/testnet\/object\//);
  });

  test("diagram: the Convert flow on the landing page", async ({ page }) => {
    const file = new URL("../../deployments/unichain-sepolia.resolved.json", import.meta.url);
    const d = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    await page.goto("/");
    const flow = page.locator("#flow .convert-flow");
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
    expect(await flow.locator("rect").evaluateAll((r) => r.map((x) => x.getAttribute("height")))).toEqual(["56", "56", "56", "56", "56"]);
    expect(await flow.evaluate((e) => e.getBoundingClientRect().width)).toBeLessThanOrEqual(720);
    expect(await flow.locator("svg").innerHTML()).not.toMatch(/Gradient/);
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
        const ids = ["product", "one-price", "how-it-works", "flow"];
        const boxes = await page.evaluate(
          (ids) =>
            [...ids.map((id) => document.getElementById(id)!), document.querySelector("footer#verify")!].map((e) => ({
              h: e.getBoundingClientRect().height,
              snap: getComputedStyle(e).scrollSnapAlign,
            })),
          ids,
        );
        for (const [i, b] of boxes.entries()) {
          expect(b.h, ids[i] ?? "footer").toBeGreaterThanOrEqual(height);
          expect(b.snap, ids[i] ?? "footer").toBe("start");
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

  test("Verify footer on / and /app: contracts from the manifests, MCP endpoint + command, GitHub; /developers lands on it", async ({ page }) => {
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
    for (const path of ["/", "/app?tab=move"]) {
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
    await page.goto("/developers");
    await expect(page).toHaveURL(/\/#verify$/);
    await expectScrolledTo(page, "verify");
  });

  test("landing MCP callout: one line plus the recorded run as prompt → tools chosen → tx", async ({ page }) => {
    // From the generated file (scripts/gen-mcp-demo.py), not typed values.
    const demo = JSON.parse(readFileSync(new URL("../../deployments/unichain-sepolia.mcp-demo.json", import.meta.url), "utf8"));
    await page.goto("/");
    const c = page.locator("#how-it-works .mcp-callout");
    await expect(c.locator("p")).toContainText("Agents can use Unison too");
    const run = c.getByRole("definition");
    await expect(run).toHaveText([`“${demo.prompt}”`, demo.steps.map((s: { tool: string }) => s.tool).join(" → "), /^0x[0-9a-f]{8}…[0-9a-f]{6} ↗$/]);
    await expect(run.nth(2).getByRole("link")).toHaveAttribute("href", `https://sepolia.uniscan.xyz/tx/${demo.tx}`);
    await c.getByRole("link", { name: "MCP endpoint →" }).click();
    await expectScrolledTo(page, "verify");
  });

  test("mobile menu opens without chevrons and its items scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, id] of [["How it works", "how-it-works"]]) {
      await page.goto("/");
      const menu = page.getByRole("button", { name: "Menu" });
      await menu.click();
      await expect(menu).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("button", { name: /menu$/i })).toHaveCount(1);
      await page.getByRole("link", { name, exact: true }).click();
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      await expectScrolledTo(page, id);
    }
  });
});
