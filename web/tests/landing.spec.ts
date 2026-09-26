import { existsSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

test("Landing: Unison brand, three products; Developers page lists every contract from the manifest", async ({
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
  await expect(page.locator(".steps3 h3")).toHaveText(["Convert", "Dark Cross", "Send"]);
  await expect(page.locator(".steps3 p")).toHaveCount(3);
  await expect(page.locator("#proof, #developers")).toHaveCount(0); // moved to /developers
  await page.goto("/developers");
  const contracts = page.locator("#contracts");
  await expect(contracts.getByRole("heading")).toContainText("Contracts");
  for (const path of ["/", "/developers"]) {
    await page.goto(path);
    await expect(page.getByText(/Live on|chain 1301/)).toHaveCount(0);
  }
  await page.goto("/developers");
  if (d) {
    await expect(contracts.getByRole("link", { name: "Uniscan ↗" }).first()).toHaveAttribute(
      "href",
      `https://sepolia.uniscan.xyz/address/${d.contracts.parityHook}`,
    );
    for (const a of d.assets) {
      await expect(contracts.locator("caption", { hasText: a.symbol })).toBeVisible();
      await expect(contracts.locator(`a[href$="${a.darkCrossHook}"]`)).toHaveCount(1);
    }
    await expect(contracts.locator(`a[href$="${d.faucet}"]`)).toHaveCount(1);
  } else {
    await expect(contracts.getByText("Deployment addresses are being published.")).toBeVisible();
  }
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

/** The target is scrolled to the top of the viewport, or the page is scrolled to its end. */
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
        return r.top < innerHeight && (Math.abs(r.top) < 2 || atEnd);
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
    await page.getByRole("link", { name: "Developers", exact: true }).click();
    await expect(page).toHaveURL(/\/developers$/);
    await expect(page.locator("#architecture")).toBeVisible();
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
          ["01 Convert", (p) => expectScrolledTo(p, "how-convert")],
          ["02 Dark Cross", (p) => expectScrolledTo(p, "how-dark")],
          ["03 Send", (p) => expectScrolledTo(p, "how-send")],
        ],
      ],
      [
        "Developers",
        [
          ["Architecture", (p) => expectScrolledTo(p, "architecture")],
          ["Contracts", (p) => expectScrolledTo(p, "contracts")],
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
    for (const [menu, label, url] of [
      ["Developers", "GitHub ↗", /github\.com\/nichar3232\/wrapswap/],
    ] as const) {
      await page.goto("/");
      await page.getByRole("button", { name: `${menu} menu` }).click();
      await expectPopup(
        page,
        () =>
          page
            .locator(`#menu-${menu.toLowerCase()}`)
            .getByRole("link", { name: label })
            .click(),
        url,
      );
    }
  });

  test("CTAs, Try it links, brand links, theme and footer", async ({
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
    await expectScrolledTo(page, "contracts");
    for (const [i, tab] of ["Move", "Move", "Send"].entries()) {
      await page.goto("/");
      await page.getByRole("link", { name: "Try it →" }).nth(i).click();
      await expectAppTab(page, tab);
      if (i === 1) await expect(page.getByRole("tab", { name: "Dark Cross" })).toHaveAttribute("aria-selected", "true");
    }
    for (const name of ["Unison home", "unison"]) {
      await page.goto("/developers");
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
    await page.goto("/developers");
    await expect(page.locator("#contracts table").first()).toBeVisible();
    const explorer = page.locator("#contracts").getByRole("link");
    for (let i = 0; i < (await explorer.count()); i++)
      await expectPopup(page, () => explorer.nth(i).click(), /uniscan\.xyz\/address\//);
  });

  test("diagrams: simple flow, developer lanes in v4 call order, Unichain node opens its explorer page", async ({ page }) => {
    const file = new URL("../../deployments/unichain-sepolia.resolved.json", import.meta.url);
    const d = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    await page.goto("/");
    const simple = page.locator(".simple-flow");
    for (const text of ["AAPL on Coinbase", "Uniswap v4 hook · NAV parity", "AAPL on xStocks", "Dark Cross", "Send on Sui"])
      await expect(simple.getByText(text, { exact: false })).toBeVisible();
    await page.goto("/developers");
    const dev = page.locator(".dev-diagram");
    await expect(dev.locator(".lane-uniswap .dn-contract")).toHaveText(["your wallet", "WrapSwapRouter.swapExactIn", "PoolManager.swap", "ParityHook.beforeSwap", "PoolManager delta settled"]);
    await expect(dev.getByText("keeper batches every 90 s")).toBeVisible();
    expect(await dev.locator(".lane-sui").evaluate((e) => getComputedStyle(e).opacity)).toBe("0.7");
    await expect(dev.getByText(/chainlink/i)).toHaveCount(0);
    const parity = dev.locator('[data-node="parity"]');
    if (d?.contracts?.parityHook)
      await expectPopup(page, () => parity.click(), new RegExp(`sepolia\\.uniscan\\.xyz/address/${d.contracts.parityHook}`, "i"));
    else await expect(dev.locator('a[data-node="parity"]')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dev).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("landing sections are full height and snap (proximity)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    // Styles are injected by the module graph in dev; wait for the rendered landing before reading them.
    await expect(page.locator(".hero h1")).toHaveText("Unison");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType)).not.toBe("none");
    // "y" alone serializes proximity, the default strictness; mandatory would read "y mandatory".
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType)).toMatch(/^y( proximity)?$/);
    for (const id of ["product", "one-price", "how-it-works"]) {
      const box = await page.locator(`#${id}`).evaluate((e) => ({ h: e.getBoundingClientRect().height, snap: getComputedStyle(e).scrollSnapAlign }));
      expect(box.h, id).toBeGreaterThanOrEqual(900);
      expect(box.snap, id).toBe("start");
    }
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
