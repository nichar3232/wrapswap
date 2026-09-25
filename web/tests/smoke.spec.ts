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

test('demo burner approves and converts through the parity hook',async({page,request})=>{
 test.setTimeout(90000);
 const response=await request.get('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/deployments');const m=await response.json();
 test.skip(!m.demoMode||m.burners?.length!==3,'Requires seeded local burners');
 await page.goto('/');await page.getByLabel('Demo burner').selectOption(m.burners[0].address);
 await page.getByRole('combobox',{name:'From',exact:true}).selectOption(m.tokens.uAAPL.address);
 await page.getByRole('combobox',{name:'To',exact:true}).selectOption(m.tokens.issuer2.address);
 await page.getByLabel('Conversion amount').fill('0.01');
 const button=page.getByRole('button',{name:'Approve & convert',exact:true});await expect(button).toBeEnabled();
 await button.click();await expect(page.getByRole('button',{name:'Confirming…',exact:true})).toBeVisible();
 await expect(button).toBeEnabled({timeout:45000});await expect(page.getByRole('status')).toContainText('Confirmed 0x');
 await expect(page.getByRole('cell',{name:'Hook',exact:true}).first()).toBeVisible({timeout:15000});
});
