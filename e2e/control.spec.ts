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
