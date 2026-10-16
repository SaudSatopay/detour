/**
 * Renders the social card (/og-card) with the site's own fonts and map, and saves it as public/og.png.
 *
 *   pnpm dev   # in another terminal
 *   node scripts/og.mjs [base url]
 */
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: "light" });
await page.goto(`${base}/og-card`, { waitUntil: "networkidle" });
// The hero map closes the line, then draws the displaced riders' flow.
await page.waitForTimeout(2500);
await page.locator("#og").screenshot({ path: "public/og.png" });
await browser.close();
console.log("wrote public/og.png");
