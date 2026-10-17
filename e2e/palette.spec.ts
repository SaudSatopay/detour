import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the command palette opens from the keyboard, finds a rider and goes there", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "A keyboard shortcut and a desktop header control; phones use the header links.");
  await page.goto("/proof");
  await page.keyboard.press("ControlOrMeta+K");
  const input = page.getByRole("combobox", { name: /Go to a closure/ });
  await expect(input).toBeFocused();

  const results = await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

  await input.fill("tomas");
  await expect(page.getByRole("option", { name: /Tomás's trip/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/riders\?rider=tomas/);
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("the palette's arrows move through the results and Escape closes it", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "A keyboard shortcut and a desktop header control; phones use the header links.");
  await page.goto("/");
  await page.getByRole("button", { name: /Search closures, riders and pages/ }).click();
  const input = page.getByRole("combobox", { name: /Go to a closure/ });
  await input.fill("closed");
  const first = await input.getAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowDown");
  expect(await input.getAttribute("aria-activedescendant")).not.toBe(first);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});
