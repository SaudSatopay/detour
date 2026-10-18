/**
 * Builds the eval set (data/eval/questions.json) with a fixed seed, already split into dev and held-out. Every
 * expected answer comes from a source that is not FalkorDB: plain TypeScript over data/nyc (src/lib/eval/gold.ts),
 * the NetworkX verifier's committed output and the seeded memory. Run it again and the file does not change.
 *
 *   pnpm eval:questions
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildQuestions, SEED, type Inputs, type VerifyOutput } from "../../src/lib/eval/questions";

const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const scenarios = read<Inputs["scenarios"]>("data/scenarios.json");
const inputs: Inputs = {
  network: read("data/nyc/network.json"),
  demand: read("data/nyc/demand.json"),
  scenarios,
  verify: Object.fromEntries(scenarios.map((s) => [s.id, read<VerifyOutput>(`data/nyc/verify/${s.id}.json`)])),
};

const questions = buildQuestions(inputs, SEED);
mkdirSync("data/eval", { recursive: true });
writeFileSync("data/eval/questions.json", JSON.stringify(questions, null, 1) + "\n");

const table: Record<string, { dev: number; heldout: number }> = {};
for (const q of questions) (table[q.category] ??= { dev: 0, heldout: 0 })[q.split]++;
console.log(`${questions.length} questions (seed ${SEED}):`);
console.table(table);
