/**
 * How strict the brief's figure check is: re-grounds the committed live runs' briefs, and counts how many random
 * figures and percentages would pass against the L run's tool results (a check that passes noise proves nothing).
 *
 *   pnpm tsx scripts/eval/grounding-check.ts
 */
import { readFileSync } from "node:fs";
import { ground } from "../../src/lib/agent/grounding";
import type { ToolResult } from "../../src/lib/graph/tools/types";

function run(file: string): { results: ToolResult[]; brief: string } {
  const events = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).event as { type: string; result?: ToolResult; text?: string });
  return { results: events.filter((e) => e.type === "tool-result").map((e) => e.result!), brief: events.find((e) => e.type === "done")?.text ?? "" };
}

function main() {
  for (const id of ["l-canarsie", "cranberry", "lex-express"]) {
    const { results, brief } = run(`data/replays/${id}-control.ndjson`);
    const g = ground(brief, results);
    console.log(`${id}: ${g.checked - g.unmatched.length} of ${g.checked} figures found${g.unmatched.length ? `; not found: ${g.unmatched.join(", ")}` : ""}`);
  }
  const { results } = run("data/replays/l-canarsie-control.ndjson");
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647);
  let figures = 0;
  for (let i = 0; i < 400; i++) if (!ground(`${(100 + (next() % 29_900)).toLocaleString("en-US")} riders`, results).unmatched.length) figures++;
  let shares = 0;
  for (let i = 0; i < 300; i++) if (!ground(`${1 + (next() % 300)}%`, results).unmatched.length) shares++;
  console.log(`random figures 100 to 30,000 that pass: ${figures} of 400; random percentages 1 to 300 that pass: ${shares} of 300`);
}

main();
