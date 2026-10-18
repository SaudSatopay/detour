import { expect, test, type Page } from "@playwright/test";

/** The company brain on the live stack: the directory loads, and answers cite the nodes they came from. */
const seen = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true });

test("the brain traces a decision back to its sources", async ({ page }) => {
  await page.goto("/brain");
  await expect(seen(page, "Rail Control Center").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Why do L tube bus bridges get 27% more buses?" }).first().click();
  await expect(seen(page, "DEC-0620-BUSES").first()).toBeVisible({ timeout: 90_000 });
  await expect(seen(page, /Tunde Okafor/).first()).toBeVisible();
});

test("the brain names who owns an open ticket", async ({ page }) => {
  await page.goto(`/brain?q=${encodeURIComponent("Who owns the Myrtle-Wyckoff elevator outage?")}`);
  await expect(seen(page, "EE-1207").first()).toBeVisible({ timeout: 90_000 });
  await expect(seen(page, /Gloria Méndez/).first()).toBeVisible();
});
