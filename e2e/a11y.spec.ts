import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** axe on the states Lighthouse never sees: after a run and after an approval, on desktop and phone. */
const seen = (page: Page, text: string) => page.getByText(text).filter({ visible: true });

async function violations(page: Page) {
  // Cards fade in from transparent (.rise, 360 ms); axe would read their text colors mid-fade. Wait for every finite animation.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
  );
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.length} node(s)`);
}

test("every page has no serious accessibility violations at rest", async ({ page }) => {
  for (const path of ["/", "/riders", "/memory", "/brain", "/proof", "/control"]) {
    await page.goto(path, { waitUntil: "networkidle" });
    expect(await violations(page), path).toEqual([]);
  }
});

test("the control room stays accessible after a run and after approval", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/control?scenario=l-canarsie");
  await page.getByRole("button", { name: "Run the controller" }).click();
  await expect(seen(page, "Brief for the dispatcher")).toBeVisible({ timeout: 90_000 });
  expect(await violations(page), "after the run").toEqual([]);

  if (phone) await page.getByRole("tab", { name: "Impact" }).click();
  await page.getByRole("button", { name: "Approve and publish to riders" }).filter({ visible: true }).first().click();
  if (phone) await page.getByRole("tab", { name: "Riders" }).click();
  await expect(seen(page, "Routing on the graph…")).toHaveCount(0, { timeout: 60_000 });
  expect(await violations(page), "after approval").toEqual([]);
});

test.describe("in the dark theme", () => {
  test.use({ colorScheme: "dark" });

  test("pages and the finished run have no serious accessibility violations", async ({ page }) => {
    for (const path of ["/", "/memory", "/brain", "/proof"]) {
      await page.goto(path, { waitUntil: "networkidle" });
      expect(await violations(page), path).toEqual([]);
    }
    await page.goto("/control?scenario=l-canarsie");
    await page.getByRole("button", { name: "Run the controller" }).click();
    await expect(seen(page, "Brief for the dispatcher")).toBeVisible({ timeout: 90_000 });
    expect(await violations(page), "after the run").toEqual([]);
  });
});
