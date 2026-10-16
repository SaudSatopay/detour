/**
 * Graph agent against the same model without the graph, on data/eval/questions.json. For each question
 * the graph agent gets a fresh sandbox and the product's tool catalogue; the baseline gets the question
 * alone. Answers are graded against ground truth that does not come from FalkorDB (see build-questions.ts).
 * Writes data/eval/results.json, which the proof page shows.
 *
 *   FALKORDB_URL=... GOOGLE_GENERATIVE_AI_API_KEY=... pnpm tsx scripts/eval/run-eval.ts [--only id,id] [--pace 4]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateText } from "ai";
import { buildTools, type AgentEvent } from "../../src/lib/agent/catalog";
import { modelChain } from "../../src/lib/agent/models";
import { BASELINE_INSTRUCTIONS, EVAL_INSTRUCTIONS } from "../../src/lib/agent/prompts";
import { runAgent } from "../../src/lib/agent/run";
import { grade, finalAnswer, type Expect } from "../../src/lib/eval/grade";
import { ensureBaseGraphs } from "../../src/lib/graph/seed";
import { dropSandbox, ensureSandbox } from "../../src/lib/graph/tenancy";

interface Question {
  id: string;
  category: string;
  question: string;
  expect: Expect;
  source: string;
}

interface Attempt {
  answer: string;
  correct: boolean;
  model: string | null;
  ms: number;
  tools?: { tool: string; outcome: string | null }[];
  error?: string;
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const chain = modelChain();
  if (!chain.length) throw new Error("Set GOOGLE_GENERATIVE_AI_API_KEY or GROQ_API_KEY: the eval compares a model with and without the graph.");
  await ensureBaseGraphs((m) => console.log(`seed: ${m}`), false);

  const only = arg("only")?.split(",");
  const pace = Number(arg("pace") ?? 4) * 1000;
  const questions = (JSON.parse(readFileSync("data/eval/questions.json", "utf8")) as Question[]).filter((q) => !only || only.includes(q.id));
  const rows: { id: string; category: string; question: string; expect: Expect; source: string; graph: Attempt; baseline: Attempt }[] = [];

  for (const [i, q] of questions.entries()) {
    const visitor = `eval${i}${Date.now().toString(36)}`;
    const sandbox = await ensureSandbox(visitor);
    const tools: Attempt["tools"] = [];
    const emit = (e: AgentEvent) => {
      if (e.type === "tool-result") tools.push({ tool: e.result.tool, outcome: e.result.outcome });
      if (e.type === "tool-error") tools.push({ tool: e.tool, outcome: null });
    };

    let graph: Attempt;
    let started = performance.now();
    try {
      const out = await runAgent({
        agent: "controller",
        instructions: EVAL_INSTRUCTIONS,
        messages: [{ role: "user", content: q.question }],
        tools: buildTools({ visitorId: visitor, sandbox: sandbox.graph, agentId: "controller" }, emit, "controller"),
        emit,
        maxSteps: 8,
      });
      graph = { answer: out.text, correct: grade(out.text, q.expect), model: out.model, ms: Math.round(performance.now() - started), tools };
    } catch (error) {
      graph = { answer: "", correct: false, model: null, ms: Math.round(performance.now() - started), tools, error: String(error) };
    } finally {
      await dropSandbox(visitor).catch(() => undefined);
    }

    // Same model as the graph agent ended on, so the comparison is like for like.
    const model = chain.find((m) => m.id === graph.model) ?? chain[0];
    let baseline: Attempt;
    started = performance.now();
    try {
      const res = await generateText({ model: model.model, instructions: BASELINE_INSTRUCTIONS, prompt: q.question, maxRetries: 2 });
      baseline = { answer: res.text, correct: grade(res.text, q.expect), model: model.id, ms: Math.round(performance.now() - started) };
    } catch (error) {
      baseline = { answer: "", correct: false, model: model.id, ms: Math.round(performance.now() - started), error: String(error) };
    }

    rows.push({ id: q.id, category: q.category, question: q.question, expect: q.expect, source: q.source, graph, baseline });
    console.log(
      `${q.id.padEnd(22)} graph ${graph.correct ? "ok " : "MISS"} (${finalAnswer(graph.answer).slice(0, 50)})  baseline ${baseline.correct ? "ok " : "MISS"} (${finalAnswer(baseline.answer).slice(0, 50)})`,
    );
    if (i < questions.length - 1) await sleep(pace);
  }

  const tally = (pick: (r: (typeof rows)[number]) => Attempt) => {
    const byCategory: Record<string, { correct: number; total: number }> = {};
    for (const r of rows) {
      const c = (byCategory[r.category] ??= { correct: 0, total: 0 });
      c.total++;
      if (pick(r).correct) c.correct++;
    }
    return { correct: rows.filter((r) => pick(r).correct).length, total: rows.length, byCategory };
  };
  const summary = { graph: tally((r) => r.graph), baseline: tally((r) => r.baseline) };
  writeFileSync(
    "data/eval/results.json",
    JSON.stringify({ runAt: new Date().toISOString(), models: [...new Set(rows.flatMap((r) => [r.graph.model, r.baseline.model]))], summary, rows }, null, 1) + "\n",
  );
  console.log(`\ngraph agent ${summary.graph.correct}/${summary.graph.total} · same model without the graph ${summary.baseline.correct}/${summary.baseline.total}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
