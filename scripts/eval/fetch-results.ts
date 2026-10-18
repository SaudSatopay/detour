/**
 * Pages GET /api/eval on a deployment and writes data/eval/results.json, then data/eval/summary.json is one
 * `pnpm eval:analyze` away. Reads only: no key or secret is needed or sent.
 *
 *   pnpm tsx scripts/eval/fetch-results.ts https://detour.example.app
 */
import { writeFileSync } from "node:fs";
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
  const file: ResultsFile = {
    source: base,
    run: { id: first.run.id, startedMs: first.run.startedMs, finishedMs: first.run.finishedMs },
    fetchedAt: new Date().toISOString(),
    results,
  };
  writeFileSync("data/eval/results.json", JSON.stringify(file, null, 1) + "\n");
  console.log(`${results.length} of ${first.progress?.total ?? "?"} results from run ${first.run.id} (${first.run.status}) → data/eval/results.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
