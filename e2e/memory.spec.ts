import { expect, test, type Page } from "@playwright/test";

const shots = process.env.SHOTS ? `${process.env.SHOTS}/` : null;
const seen = (page: Page, text: string | RegExp, exact = false) => page.getByText(text, { exact }).filter({ visible: true });

test("reporting the elevator fixed supersedes the outage fact and changes Aisha's route", async ({ page }, info) => {
  await page.goto("/riders?rider=aisha");
  const route = page.getByRole("button", { name: "Route Aisha now" });
  await expect(route).toBeVisible();
  // The seeded riders render before the sandbox loads; wait for it, then skip if the database is down.
  await expect(seen(page, /Loading your sandbox graph/)).toHaveCount(0, { timeout: 30_000 });
  test.skip(await route.isDisabled(), "Routing needs the graph database; this deployment is serving a recording.");

  await route.click();
  await expect(seen(page, /Skipped a faster path because memory says/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Report the L elevator fixed" }).click();
  await expect(seen(page, "Before the memory changed")).toBeVisible({ timeout: 30_000 });
  await expect(seen(page, /closing F-ELEV-2/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}riders-elevator-${info.project.name}.png`, fullPage: info.project.name === "phone" });

  await page.goto("/memory");
  await expect(seen(page, "No longer true")).toBeVisible();
  await expect(seen(page, /back in service/).first()).toBeVisible();

  // Put the fact back so the sandbox reads as seeded for the next run.
  await page.goto("/riders?rider=aisha");
  await page.getByRole("button", { name: "Report it out of service again" }).click();
  await expect(seen(page, /out of service again/).first()).toBeVisible({ timeout: 30_000 });
});

test("the memory page shows current and closed facts with their windows", async ({ page }, info) => {
  await page.goto("/memory");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Memory is part of the graph");
  await expect(seen(page, "Known now")).toBeVisible();
  await expect(seen(page, /Elevator to the L platform at 14 St-Union Sq out of service/).first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}memory-${info.project.name}.png`, fullPage: true });
});

test("the memory timeline draws every fact over its window and opens its details from the keyboard", async ({ page }) => {
  await page.goto("/memory");
  const bars = page.getByRole("list", { name: "Facts on the timeline" }).getByRole("button");
  await expect(bars.first()).toBeAttached({ timeout: 30_000 });
  expect(await bars.count()).toBeGreaterThanOrEqual(5);

  // The seeded elevator outage is closed: its bar names the fact, its window and that it is closed.
  const closed = page.getByRole("button", { name: "Elevator to the L platform at 14 St-Union Sq out of service, valid Oct 2, 2026 to Oct 9, 2026, closed" });
  await closed.focus();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("Oct 2, 2026 → Oct 9, 2026");
  await expect(card).toContainText("Rider desk");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // Tab moves to the next bar and its card opens.
  await page.keyboard.press("Tab");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Valid");

  // The chart scrolls inside its own box; the page never scrolls sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
