import { existsSync, readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

test("Landing: Unison brand, proof from deployment, Launch app", async ({
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
  const proof = page.locator("#proof");
  await expect(proof.getByRole("heading")).toContainText(
    "Live on Unichain Sepolia",
  );
  if (d) {
    await expect(
      proof.getByRole("link", { name: "Uniscan ↗" }).first(),
    ).toHaveAttribute(
      "href",
      `https://sepolia.uniscan.xyz/address/${d.contracts.parityHook}`,
    );
    await expect(proof.getByRole("row")).toHaveCount(6);
  } else {
    await expect(
      proof.getByText("Deployment addresses are being published."),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: "Launch app" }).first().click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(
    page.getByRole("button", { name: "Convert", exact: true }),
  ).toBeVisible();
  await page.goto("/app?tab=pool");
  await expect(page.getByText("Total 20,250 canonical shares")).toBeVisible();
});

/** The target is scrolled to the top of the viewport, or the page is scrolled to its end. */
async function expectScrolledTo(page: Page, id: string) {
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const r = document.getElementById(id)!.getBoundingClientRect();
        const atEnd =
          Math.ceil(scrollY + innerHeight) >=
          document.documentElement.scrollHeight - 1;
        return r.top < innerHeight && (Math.abs(r.top) < 2 || atEnd);
      }, id),
    )
    .toBe(true);
}
async function expectAppTab(page: Page, tab: string) {
  await expect(page).toHaveURL(/\/app(\?tab=\w+)?$/);
  await expect(
    page.getByRole("button", { name: tab, exact: true }),
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
    for (const [name, id] of [
      ["How it works", "how-it-works"],
      ["Proof", "proof"],
      ["Developers", "developers"],
    ]) {
      await page.goto("/");
      await page.getByRole("link", { name, exact: true }).click();
      await expectScrolledTo(page, id);
    }
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
          ["Convert", (p) => expectAppTab(p, "Convert")],
          ["Pool", (p) => expectAppTab(p, "Pool")],
          ["Dark Cross", (p) => expectAppTab(p, "Dark Cross")],
        ],
      ],
      [
        "How it works",
        [
          ["01 Convert", (p) => expectScrolledTo(p, "how-convert")],
          ["02 Pool", (p) => expectScrolledTo(p, "how-pool")],
          ["03 Dark Cross", (p) => expectScrolledTo(p, "how-dark")],
        ],
      ],
      [
        "Proof",
        [["Deployed contracts", (p) => expectScrolledTo(p, "proof-contracts")]],
      ],
      [
        "Developers",
        [["Deployed contracts", (p) => expectScrolledTo(p, "proof-contracts")]],
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
      ["Proof", "Uniscan ↗", /sepolia\.uniscan\.xyz/],
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
    for (const where of ["header", ".hero-copy"]) {
      await page.goto("/");
      await page.locator(where).getByRole("link", { name: "Launch app" }).click();
      await expect(page).toHaveURL(/\/app$/);
      await expectAppTab(page, "Convert");
    }
    await page.goto("/");
    await page.getByRole("link", { name: "See it onchain →" }).click();
    await expectScrolledTo(page, "proof");
    for (const [i, tab] of ["Convert", "Pool", "Dark Cross"].entries()) {
      await page.goto("/");
      await page.getByRole("link", { name: "Try it →" }).nth(i).click();
      await expectAppTab(page, tab);
    }
    for (const name of ["Unison home", "unison"]) {
      await page.goto("/#proof");
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
    const explorer = page.locator("#proof-contracts").getByRole("link");
    for (let i = 0; i < (await explorer.count()); i++)
      await expectPopup(page, () => explorer.nth(i).click(), /uniscan\.xyz\/address\//);
  });

  test("architecture diagram: a Unichain node opens its explorer page", async ({
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
    const diagram = page.locator(".dg-wide");
    await expect(diagram).toBeVisible();
    for (const text of ["UNICHAIN SEPOLIA · UNISWAP v4", "SUI TESTNET · CONFIDENTIAL PAYMENTS", "ParityHook", "ShareVault"])
      await expect(diagram.getByText(text, { exact: true })).toBeVisible();
    await expect(diagram.getByText(/chainlink/i)).toHaveCount(0);
    const parity = diagram.locator('[data-node="parity"]');
    if (d?.contracts?.parityHook) {
      await expectPopup(
        page,
        () => parity.click(),
        new RegExp(`sepolia\\.uniscan\\.xyz/address/${d.contracts.parityHook}`, "i"),
      );
    } else {
      // No deployment yet: the node renders but is not a link.
      await expect(parity).toBeVisible();
      await expect(diagram.locator('a[data-node="parity"]')).toHaveCount(0);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".dg-stacked")).toBeVisible();
    await expect(diagram).toBeHidden();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

  test("mobile menu opens without chevrons and its items scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, id] of [
      ["How it works", "how-it-works"],
      ["Proof", "proof"],
      ["Developers", "developers"],
    ]) {
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
