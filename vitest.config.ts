import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration suites talk to a live FalkorDB and skip themselves when FALKORDB_URL is unset.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
