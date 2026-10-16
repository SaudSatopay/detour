/**
 * Copies the harness output (ci-out/) into data/proof/ for the proof page: every tool result's
 * answer shape, summary and Cypher trace, without the bulky data arrays. bench.json is copied by hand
 * after a benchmark run because it names the engine it ran on.
 *
 *   node scripts/ci/trim-proof.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const scenarios = ["l-canarsie", "lex-express", "cranberry"];
mkdirSync("data/proof", { recursive: true });
for (const id of scenarios) {
  const full = JSON.parse(readFileSync(`ci-out/${id}.json`, "utf8"));
  const trimmed = Object.fromEntries(
    Object.entries(full).map(([step, r]) => [
      step,
      {
        tool: r.tool,
        outcome: r.outcome,
        summary: r.summary,
        trace: r.trace,
        // Small results the proof page compares with NetworkX.
        ...(r.tool === "affected_riders" && r.data ? { byDepth: r.data.byDepth } : {}),
      },
    ]),
  );
  writeFileSync(`data/proof/${id}.json`, JSON.stringify(trimmed) + "\n");
}
writeFileSync("data/proof/summary.json", readFileSync("ci-out/summary.json"));
console.log(`trimmed ${scenarios.length} scenarios into data/proof`);
