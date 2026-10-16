/**
 * Seeds FalkorDB with the shared graphs (detour:demand, detour:template).
 *   pnpm seed            rebuild only what is missing or stale
 *   pnpm seed --force    rebuild both graphs
 */
import { existsSync } from "node:fs";
import { connect } from "../src/lib/graph/db";
import { ensureBaseGraphs } from "../src/lib/graph/seed";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const started = performance.now();
  await ensureBaseGraphs((msg) => console.log(msg), process.argv.includes("--force"));
  console.log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  await (await connect()).close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
