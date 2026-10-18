/**
 * Runs the eval locally against a FalkorDB of your own, with the same runner the deployment's /api/eval uses. The
 * model keys live only in the deployment, so locally this is normally the rules-only arm (no model); the graph and
 * baseline arms run here too if a key happens to be set. Writes data/eval/results.json (merged with what is there,
 * so a local rules run and a fetched production run can sit together).
 *
 *   FALKORDB_URL=falkor://127.0.0.1:6380 pnpm tsx scripts/eval/run-eval.ts [--arms rules] [--only id,id] [--split heldout]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { liveChain } from "../../src/lib/agent/models";
import type { EvalQuestion } from "../../src/lib/eval/questions";
import { ARMS, evalToolset, EVAL_VISITOR, runQuestion, runOrder, type Arm, type ArmRecord } from "../../src/lib/eval/runner";
import { ensureBaseGraphs } from "../../src/lib/graph/seed";
import { dropSandbox, ensureSandbox } from "../../src/lib/graph/tenancy";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export interface ResultsFile {
  source: string;
  run: { id: string | null; startedMs: number | null; finishedMs: number | null };
  fetchedAt: string;
  results: ArmRecord[];
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const arms = (arg("arms")?.split(",") ?? ARMS) as Arm[];
  const only = arg("only")?.split(",");
  const split = arg("split");
  const questions = JSON.parse(readFileSync("data/eval/questions.json", "utf8")) as EvalQuestion[];
  const order = runOrder(questions).filter((id) => (!only || only.includes(id)) && (!split || questions.find((q) => q.id === id)!.split === split));
  if (arms.some((a) => a !== "rules") && !(await liveChain()).length) {
    throw new Error("The graph and baseline arms need a model key; locally run --arms rules, or run the eval on the deployment (POST /api/eval).");
  }

  await ensureBaseGraphs((m) => console.log(`seed: ${m}`), false);
  const sandbox = await ensureSandbox(EVAL_VISITOR);
  const base = { visitorId: EVAL_VISITOR, sandbox: sandbox.graph, agentId: "controller" };
  const deps = { base, toolset: (emit: Parameters<typeof evalToolset>[1]) => evalToolset(base, emit), chain: () => liveChain(), armTimeoutMs: 120_000 };

  const path = "data/eval/results.json";
  const previous: ResultsFile | null = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ResultsFile) : null;
  const records = new Map((previous?.results ?? []).map((r) => [`${r.qid}|${r.arm}`, r]));
  const started = Date.now();
  try {
    for (const id of order) {
      const q = questions.find((x) => x.id === id)!;
      const out = await runQuestion(q, deps, { arms, save: async (r) => void records.set(`${r.qid}|${r.arm}`, r) });
      console.log(`${q.id.padEnd(36)} ${out.map((r) => `${r.arm} ${r.correct ? "ok  " : "MISS"} ${r.final.slice(0, 40)}`).join(" | ")}`);
    }
  } finally {
    await dropSandbox(EVAL_VISITOR).catch(() => undefined);
  }

  const file: ResultsFile = {
    source: previous?.source && previous.source !== "local" ? `${previous.source} + local` : "local",
    run: previous?.run ?? { id: null, startedMs: started, finishedMs: Date.now() },
    fetchedAt: new Date().toISOString(),
    results: [...records.values()],
  };
  writeFileSync(path, JSON.stringify(file, null, 1) + "\n");
  const mine = file.results.filter((r) => arms.includes(r.arm) && order.includes(r.qid));
  for (const a of arms) {
    const rs = mine.filter((r) => r.arm === a);
    console.log(`${a}: ${rs.filter((r) => r.correct).length}/${rs.length}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
