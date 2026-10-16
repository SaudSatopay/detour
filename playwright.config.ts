import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end checks of the pages a judge clicks through. They pass with or without a database or a
 * model key: the control room then plays the recorded runs, and the assertions do not depend on the mode.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: process.env.BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: process.env.BASE_URL ? undefined : { command: "pnpm dev", url: "http://localhost:3000", reuseExistingServer: true, timeout: 120_000 },
});
