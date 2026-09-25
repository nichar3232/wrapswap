import { test, expect } from "@playwright/test";
test("all implemented tabs load against the fork without browser errors", async ({
  page,
  request,
}) => {
  const health = await request.get(
    "http://127.0.0.1:" + (process.env.API_PORT || 4000) + "/health",
  );
  expect(health.ok()).toBeTruthy();
  expect((await health.json()).ok).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Convert wrappers" }),
  ).toBeVisible();
  for (const [tab, title] of [
    ["Dark pool", "Sealed batch crossing"],
    ["Backing", "Canonical backing"],
    ["Metrics", "Protocol metrics"],
    ["Convert", "Convert wrappers"],
  ]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  }
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
