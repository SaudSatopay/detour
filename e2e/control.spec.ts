import { expect, test, type Page } from "@playwright/test";

const shots = process.env.SHOTS ? `${process.env.SHOTS}/` : null;
// Desktop and phone lay the same panels out differently, so look only at what is on screen.
const seen = (page: Page, text: string | RegExp, exact = false) => page.getByText(text, { exact }).filter({ visible: true });

test("the landing page states the claim and links to the control room", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("When a subway line breaks");
  await expect(page.getByRole("link", { name: /Break the L train/i })).toHaveAttribute("href", /\/control\?scenario=l-canarsie/);
  if (shots) await page.screenshot({ path: `${shots}home-${test.info().project.name}.png`, fullPage: true });
});

test("playback steps back through a finished run and opens a linked step", async ({ page }, info) => {
  const steps = page.locator(info.project.name === "phone" ? "#run-tabpanel [data-step]" : '[aria-label="Agent trace"] [data-step]');
  const slider = page.getByRole("slider", { name: "Run step" });
  await page.goto("/control?scenario=l-canarsie&run=1");
  await expect(seen(page, "Brief for the dispatcher")).toBeVisible({ timeout: 90_000 });
  const total = await steps.count();
  expect(total).toBeGreaterThan(3);
  await expect(slider).toHaveAttribute("aria-valuenow", String(total));

  const previous = page.getByRole("button", { name: "Previous step" });
  await previous.click();
  await previous.click();
  await expect(steps).toHaveCount(total - 2);
  await expect(page).toHaveURL(new RegExp(`[?&]step=${total - 2}(&|$)`));
  await expect(page.getByRole("button", { name: "Back to latest" })).toBeVisible();

  await slider.focus();
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", new RegExp(`^Step 1 of ${total}: `));
  await expect(steps).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(steps).toHaveCount(total);
  await expect(page.getByRole("button", { name: "Back to latest" })).toHaveCount(0);

  await page.goto("/control?scenario=l-canarsie&run=1&step=3");
  await expect(slider).toHaveAttribute("aria-valuenow", "3", { timeout: 60_000 });
  await expect(steps).toHaveCount(3);
});

test("the controller measures the L closure and the rider desk advises riders after approval", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/control?scenario=l-canarsie");
  await page.getByRole("button", { name: "Run the controller" }).click();
  await expect(seen(page, "Brief for the dispatcher")).toBeVisible({ timeout: 90_000 });
  await expect(seen(page, /23,445 riders an hour had trips crossing/).first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}control-brief-${info.project.name}.png`, fullPage: phone });

  if (phone) await page.getByRole("tab", { name: "Impact" }).click();
  const approve = page.getByRole("button", { name: "Approve and publish to riders" }).filter({ visible: true }).first();
  await approve.scrollIntoViewIfNeeded();
  await approve.click();
  if (phone) await page.getByRole("tab", { name: "Riders" }).click();
  await expect(seen(page, "Aisha", true).first()).toBeVisible({ timeout: 60_000 });
  await expect(seen(page, "Routing on the graph…")).toHaveCount(0, { timeout: 60_000 });
  if (phone) await page.getByRole("tab", { name: "Impact" }).click();
  await expect(seen(page, "Published to riders").first()).toBeVisible();
  if (phone) await page.getByRole("tab", { name: "Riders" }).click();
  if (shots) await page.screenshot({ path: `${shots}control-riders-${info.project.name}.png`, fullPage: phone });
});
