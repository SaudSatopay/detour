/**
 * Pages GET /api/eval on a deployment and writes data/eval/results.json, then data/eval/summary.json is one
 * `pnpm eval:analyze` away. Reads only: no key or secret is needed or sent.
 *
 *   pnpm tsx scripts/eval/fetch-results.ts https://detour.example.app [--merge data/eval/results-earlier.json]
 *
 * --merge keeps an earlier run's records where the deployment's run has none yet (a run started with "skip" leaves out
 * questions the earlier one answered on every arm). A question's model arms always come from one run; its rules
 * answer, which needs no model, stands until the new run has its own.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ArmRecord } from "../../src/lib/eval/runner";
import type { ResultsFile } from "./run-eval";

interface Page {
  run: { id: string; startedMs: number; finishedMs: number | null; status: string; questions: number } | null;
  progress?: { stored: number; total: number };
  results: ArmRecord[];
  next: number | null;
  error?: string;
}

async function main() {
  const base = process.argv[2]?.replace(/\/+$/, "");
  if (!base || !/^https?:\/\//.test(base)) throw new Error("Usage: pnpm tsx scripts/eval/fetch-results.ts <base URL, e.g. https://detour.example.app>");
  const results: ArmRecord[] = [];
  let offset: number | null = 0;
  let first: Page | null = null;
  while (offset !== null) {
    const res = await fetch(`${base}/api/eval?offset=${offset}&limit=100`, { headers: { accept: "application/json" } });
    const page = (await res.json()) as Page;
    if (!res.ok || page.error) throw new Error(`GET /api/eval answered ${res.status}: ${page.error ?? "no body"}`);
    first ??= page;
    results.push(...page.results);
    offset = page.next;
  }
  if (!first?.run) throw new Error("The deployment has no eval run yet.");
  const at = process.argv.indexOf("--merge");
  const earlier = at > 0 ? (JSON.parse(readFileSync(process.argv[at + 1], "utf8")) as ResultsFile) : null;
  // A question's model arms come from one run (the baseline uses the model its graph arm ended on); a rules answer
  // needs no model, so the earlier one stands until the new run has its own.
  const have = new Set(results.map((r) => `${r.qid}|${r.arm}`));
  const rerun = new Set(results.filter((r) => r.arm !== "rules").map((r) => r.qid));
  const kept = earlier ? earlier.results.filter((r) => !have.has(`${r.qid}|${r.arm}`) && !(r.arm !== "rules" && rerun.has(r.qid))) : [];
  const file: ResultsFile = {
    source: base,
    run: {
      id: earlier ? `${earlier.run.id}+${first.run.id}` : first.run.id,
      startedMs: earlier?.run.startedMs ? Math.min(earlier.run.startedMs, first.run.startedMs) : first.run.startedMs,
      finishedMs: first.run.finishedMs,
    },
    fetchedAt: new Date().toISOString(),
    results: [...kept, ...results],
  };
  if (earlier) console.log(`kept ${kept.length} records of ${new Set(kept.map((r) => r.qid)).size} questions from ${earlier.run.id}`);
  writeFileSync("data/eval/results.json", JSON.stringify(file, null, 1) + "\n");
  console.log(`${results.length} of ${first.progress?.total ?? "?"} results from run ${first.run.id} (${first.run.status}) → data/eval/results.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
