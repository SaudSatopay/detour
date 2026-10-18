/**
 * data/eval/questions.json + data/eval/results.json → data/eval/summary.json, which the proof page's eval section
 * renders. Without results it writes a "not-run" summary that still describes the question set and its split.
 *
 *   pnpm eval:analyze
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { summarize } from "../../src/lib/eval/analyze";
import type { EvalQuestion } from "../../src/lib/eval/questions";
import type { ResultsFile } from "./run-eval";

const questions = JSON.parse(readFileSync("data/eval/questions.json", "utf8")) as EvalQuestion[];
const file: ResultsFile | null = existsSync("data/eval/results.json") ? JSON.parse(readFileSync("data/eval/results.json", "utf8")) : null;
const summary = summarize(questions, file?.results ?? [], file?.run ?? {});
writeFileSync("data/eval/summary.json", JSON.stringify(summary, null, 1) + "\n");

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`status ${summary.status}; held-out ${summary.questions.heldout}, dev ${summary.questions.dev}`);
for (const [arm, s] of Object.entries(summary.arms)) {
  if (!s.heldout.n) continue;
  console.log(`${arm.padEnd(8)} held-out ${s.heldout.correct}/${s.heldout.n} = ${pct(s.heldout.rate)} [${pct(s.heldout.lo)}, ${pct(s.heldout.hi)}]  models ${Object.keys(s.models).join(", ") || "none"}`);
}
if (summary.lost.length) console.log(`where the graph agent lost: ${summary.lost.map((l) => l.qid).join(", ")}`);
