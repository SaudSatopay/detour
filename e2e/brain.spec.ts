import AxeBuilder from "@axe-core/playwright";
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

test("real MTA records are labeled, dated and cited with the feed's own words", async ({ page }) => {
  await page.goto("/brain");
  const panel = page.getByRole("region", { name: "Real MTA records" });
  await expect(panel.getByText("Outages and alerts as of")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("button", { name: "Refresh from the MTA" })).toBeVisible();
  await page.getByRole("button", { name: "What is the MTA's alternative route when elevator EL293 is out?" }).first().click();
  const sources = page.getByRole("region", { name: "Sources" });
  await expect(sources.getByText("ALT-EL293")).toBeVisible({ timeout: 90_000 });
  await expect(sources.getByText("MTA record").first()).toBeVisible();
  await expect(sources.getByText(/^fetched /).first()).toBeVisible();
});

test("an answer with MTA receipts and the refreshed records have no serious accessibility violations", async ({ page }) => {
  await page.goto(`/brain?q=${encodeURIComponent("Which stations on the A have an elevator out of service?")}`);
  await expect(page.getByRole("region", { name: "Sources" }).getByText("MTA record").first()).toBeVisible({ timeout: 90_000 });
  const refresh = page.getByRole("button", { name: "Refresh from the MTA" });
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect(seen(page, /Read the MTA's live feeds|already running|refreshed several times|could not/).first()).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
});

test("a follow-up is read with what the previous answer cited", async ({ page }) => {
  await page.goto(`/brain?q=${encodeURIComponent("Who maintains elevator EL293?")}`);
  await expect(seen(page, "ASSET-EL293").first()).toBeVisible({ timeout: 90_000 });
  const box = page.getByLabel("Your question");
  await box.fill("Is it working right now?");
  await box.press("Enter");
  await expect(seen(page, /Read as a follow-up about/).first()).toBeVisible({ timeout: 90_000 });
  await expect(seen(page, /EL293 at 1 Av/).first()).toBeVisible();
});

test("with the database down, the brain answers its suggestions from a recording, labeled with its date", async ({ page }) => {
  await page.goto("/brain");
  await expect(page.getByRole("heading", { name: "Directory" })).toBeVisible();
  const banner = seen(page, /This is the directory as recorded on/);
  await expect(banner.or(seen(page, "Rail Control Center")).first()).toBeVisible({ timeout: 30_000 });
  test.skip(!(await banner.isVisible()), "The graph database is up, so the brain answers live.");

  await page.getByRole("button", { name: "Who owns the Myrtle-Wyckoff elevator outage?" }).first().click();
  await expect(seen(page, /^Recorded · /).first()).toBeVisible({ timeout: 30_000 });
  await expect(seen(page, "EE-1207").first()).toBeVisible();
  await expect(seen(page, /Adding needs the live graph database/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh from the MTA" })).toHaveCount(0);
});
