import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end checks of the pages a judge clicks through. They pass with or without a database or a
 * model key: the control room then plays the recorded runs, and the assertions do not depend on the mode.
 * They ask for no model (the standard procedure, same tools), so testing a deployment never spends the free model
 * quota its visitors' live runs need; E2E_LIVE=1 lets them run live.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  // A deployment's free database holds a few visitors' graphs at once: test it two visitors at a time.
  workers: process.env.BASE_URL ? 2 : undefined,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    extraHTTPHeaders: process.env.E2E_LIVE === "1" ? {} : { "x-detour-no-model": "1" },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: process.env.BASE_URL ? undefined : { command: "pnpm dev", url: "http://localhost:3000", reuseExistingServer: true, timeout: 120_000 },
});
