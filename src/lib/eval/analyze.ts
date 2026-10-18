import { ABSTAIN, rng, SEED, type Category, type EvalQuestion } from "./questions";
import type { Arm, ArmRecord, ToolCall } from "./runner";

/**
 * Turns per-question records into what the proof page states: accuracy per arm and category with seeded bootstrap
 * 95% intervals, abstention, whether the graph agent chose and ordered its tools right, how many of its answers are
 * grounded in a tool result, and the questions the model got right without the graph and wrong with it.
 */
export const BOOTSTRAP_SEED = 7;
export const BOOTSTRAP_ROUNDS = 2000;

export interface Interval {
  n: number;
  correct: number;
  rate: number;
  lo: number;
  hi: number;
}

/** Percentile bootstrap of a mean of 0/1 outcomes, resampling with a seeded generator so the numbers are stable. */
export function bootstrap(outcomes: boolean[], seed = BOOTSTRAP_SEED, rounds = BOOTSTRAP_ROUNDS): Interval {
  const n = outcomes.length;
  const correct = outcomes.filter(Boolean).length;
  if (!n) return { n, correct, rate: 0, lo: 0, hi: 0 };
  const random = rng(seed);
  const means: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let hits = 0;
    for (let i = 0; i < n; i++) if (outcomes[Math.floor(random() * n)]) hits++;
    means.push(hits / n);
  }
  means.sort((a, b) => a - b);
  return { n, correct, rate: correct / n, lo: means[Math.floor(0.025 * rounds)], hi: means[Math.ceil(0.975 * rounds) - 1] };
}

/** Paired bootstrap of the difference a − b over the same questions (both lists in question order). */
export function pairedDifference(a: boolean[], b: boolean[], seed = BOOTSTRAP_SEED, rounds = BOOTSTRAP_ROUNDS): { n: number; diff: number; lo: number; hi: number } {
  const n = Math.min(a.length, b.length);
  if (!n) return { n, diff: 0, lo: 0, hi: 0 };
  const d = Array.from({ length: n }, (_, i) => Number(a[i]) - Number(b[i]));
  const random = rng(seed);
  const means: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[Math.floor(random() * n)];
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  return { n, diff: d.reduce((s, x) => s + x, 0) / n, lo: means[Math.floor(0.025 * rounds)], hi: means[Math.ceil(0.975 * rounds) - 1] };
}

const takesStationIds = (c: ToolCall) =>
  c.tool === "close_line" || (c.tool === "route_rider" && /"(from|to)_station_id"/.test(c.input)) || (c.tool === "recall_memory" && /"station_ids":\["/.test(c.input));
const needsClosure = new Set(["affected_riders", "measure_capacity"]);

export interface ToolCheck {
  /** Every tool the question needs was called. */
  called: boolean;
  /** Names were resolved before ids were used, and a closure came before measuring it. */
  ordered: boolean;
}

export function toolCheck(q: Pick<EvalQuestion, "needs">, calls: ToolCall[]): ToolCheck {
  const names = new Set(calls.map((c) => c.tool));
  const called = q.needs.every((t) => names.has(t));
  let resolved = false;
  let closed = false;
  let ordered = true;
  for (const c of calls) {
    if (takesStationIds(c) && !resolved) ordered = false;
    if (needsClosure.has(c.tool) && !closed) ordered = false;
    if (c.tool === "resolve_places") resolved = true;
    if (c.tool === "close_line" && c.outcome === "answered") closed = true;
  }
  return { called, ordered };
}

type ArmSummary = { heldout: Interval; dev: Interval; all: Interval; errors: number; models: Record<string, number> };

export interface EvalSummary {
  status: "complete" | "partial" | "not-run";
  generatedAt: string;
  run: { id: string | null; startedAt: string | null; finishedAt: string | null };
  questions: { total: number; heldout: number; dev: number; seed: number; byCategory: Record<string, { dev: number; heldout: number }> };
  /** Results present per arm (a partial run has fewer). */
  coverage: Record<Arm, number>;
  arms: Record<Arm, ArmSummary>;
  /** Held-out accuracy per category and arm. */
  byCategory: { category: Category; n: number; graph: Interval; baseline: Interval; rules: Interval }[];
  /** Held-out graph minus baseline on the same questions, paired bootstrap. */
  graphVsBaseline: { n: number; diff: number; lo: number; hi: number };
  graphVsRules: { n: number; diff: number; lo: number; hi: number };
  /** On questions that should be declined: share declined. On the rest: share wrongly declined. */
  abstention: Record<Arm, { shouldDecline: Interval; falseDecline: Interval }>;
  depth: { pairs: number; graph: { depth1: Interval; depth4: Interval }; baseline: { depth1: Interval; depth4: Interval } };
  toolChoice: Record<"graph" | "rules", { n: number; called: number; ordered: number; both: number }>;
  grounding: Record<"graph" | "rules", { answers: number; withFigures: number; allGrounded: number }>;
  latency: Record<Arm, { medianMs: number; toolCalls: number }>;
  /** Held-out questions the baseline got right and the graph agent got wrong. */
  lost: { qid: string; category: Category; question: string; gold: string; graph: string; baseline: string; why: string }[];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function goldText(q: EvalQuestion): string {
  const e = q.expect;
  switch (e.kind) {
    case "number":
      return e.value.toLocaleString("en-US");
    case "yesno":
      return e.value;
    case "contains":
      return e.any.join(" or ");
    case "date":
      return e.iso;
    case "set":
      return e.items.join(", ");
    case "decline":
      return "decline: not in the graph";
  }
}

export function summarize(
  questions: EvalQuestion[],
  records: ArmRecord[],
  run: { id?: string | null; startedMs?: number | null; finishedMs?: number | null } = {},
  now = new Date(),
): EvalSummary {
  const arms: Arm[] = ["graph", "baseline", "rules"];
  const rec = new Map(records.map((r) => [`${r.qid}|${r.arm}`, r]));
  const get = (q: EvalQuestion, arm: Arm) => rec.get(`${q.id}|${arm}`);
  const has = (arm: Arm) => questions.filter((q) => get(q, arm));
  const outcomes = (qs: EvalQuestion[], arm: Arm) => qs.filter((q) => get(q, arm)).map((q) => get(q, arm)!.correct);
  const heldout = questions.filter((q) => q.split === "heldout");
  const dev = questions.filter((q) => q.split === "dev");

  const byCategoryCount: Record<string, { dev: number; heldout: number }> = {};
  for (const q of questions) (byCategoryCount[q.category] ??= { dev: 0, heldout: 0 })[q.split]++;

  const armSummary = (arm: Arm): ArmSummary => {
    const mine = records.filter((r) => r.arm === arm);
    const models: Record<string, number> = {};
    for (const r of mine) if (r.model) models[r.model] = (models[r.model] ?? 0) + 1;
    return {
      heldout: bootstrap(outcomes(heldout, arm)),
      dev: bootstrap(outcomes(dev, arm)),
      all: bootstrap(outcomes(questions, arm)),
      errors: mine.filter((r) => r.error).length,
      models,
    };
  };

  const categories = [...new Set(questions.map((q) => q.category))];
  const both = (a: Arm, b: Arm) => heldout.filter((q) => get(q, a) && get(q, b));
  const paired = (a: Arm, b: Arm) => {
    const qs = both(a, b);
    return pairedDifference(qs.map((q) => get(q, a)!.correct), qs.map((q) => get(q, b)!.correct));
  };

  const abstain = (arm: Arm) => {
    const should = heldout.filter((q) => ABSTAIN.includes(q.category) && q.expect.kind === "decline" && get(q, arm));
    const shouldNot = heldout.filter((q) => !ABSTAIN.includes(q.category) && get(q, arm));
    return { shouldDecline: bootstrap(should.map((q) => get(q, arm)!.correct)), falseDecline: bootstrap(shouldNot.map((q) => get(q, arm)!.declined)) };
  };

  const depthQs = (k: number) => heldout.filter((q) => q.depth === k);
  const tools = (arm: "graph" | "rules") => {
    const qs = heldout.filter((q) => get(q, arm) && !get(q, arm)!.error);
    const checks = qs.map((q) => toolCheck(q, get(q, arm)!.tools));
    return { n: qs.length, called: checks.filter((c) => c.called).length, ordered: checks.filter((c) => c.ordered).length, both: checks.filter((c) => c.called && c.ordered).length };
  };
  const grounding = (arm: "graph" | "rules") => {
    const rs = heldout.map((q) => get(q, arm)).filter((r): r is ArmRecord => Boolean(r?.grounding));
    const withFigures = rs.filter((r) => r.grounding!.checked > 0);
    return { answers: rs.length, withFigures: withFigures.length, allGrounded: withFigures.filter((r) => !r.grounding!.unmatched.length).length };
  };

  const lost = heldout
    .filter((q) => get(q, "baseline")?.correct && get(q, "graph") && !get(q, "graph")!.correct)
    .map((q) => {
      const g = get(q, "graph")!;
      const check = toolCheck(q, g.tools);
      const why = g.error
        ? `error: ${g.error}`
        : !check.called
          ? `did not call ${q.needs.filter((t) => !g.tools.some((c) => c.tool === t)).join(", ")}`
          : !check.ordered
            ? "used ids before resolving names, or measured before closing the line"
            : g.declined
              ? "declined an answerable question"
              : "called the right tools; the final answer did not match";
      return { qid: q.id, category: q.category, question: q.question, gold: goldText(q), graph: g.final || "(no answer)", baseline: get(q, "baseline")!.final, why };
    });

  const coverage = Object.fromEntries(arms.map((a) => [a, has(a).length])) as Record<Arm, number>;
  const complete = arms.every((a) => coverage[a] === questions.length);
  return {
    status: records.length === 0 ? "not-run" : complete ? "complete" : "partial",
    generatedAt: now.toISOString(),
    run: {
      id: run.id ?? null,
      startedAt: run.startedMs ? new Date(run.startedMs).toISOString() : null,
      finishedAt: run.finishedMs ? new Date(run.finishedMs).toISOString() : null,
    },
    questions: { total: questions.length, heldout: heldout.length, dev: dev.length, seed: SEED, byCategory: byCategoryCount },
    coverage,
    arms: Object.fromEntries(arms.map((a) => [a, armSummary(a)])) as Record<Arm, ArmSummary>,
    byCategory: categories.map((category) => {
      const qs = heldout.filter((q) => q.category === category);
      return { category, n: qs.length, graph: bootstrap(outcomes(qs, "graph")), baseline: bootstrap(outcomes(qs, "baseline")), rules: bootstrap(outcomes(qs, "rules")) };
    }),
    graphVsBaseline: paired("graph", "baseline"),
    graphVsRules: paired("graph", "rules"),
    abstention: Object.fromEntries(arms.map((a) => [a, abstain(a)])) as EvalSummary["abstention"],
    depth: {
      pairs: depthQs(1).length,
      graph: { depth1: bootstrap(outcomes(depthQs(1), "graph")), depth4: bootstrap(outcomes(depthQs(4), "graph")) },
      baseline: { depth1: bootstrap(outcomes(depthQs(1), "baseline")), depth4: bootstrap(outcomes(depthQs(4), "baseline")) },
    },
    toolChoice: { graph: tools("graph"), rules: tools("rules") },
    grounding: { graph: grounding("graph"), rules: grounding("rules") },
    latency: Object.fromEntries(
      arms.map((a) => {
        const rs = records.filter((r) => r.arm === a && !r.error);
        return [a, { medianMs: median(rs.map((r) => r.ms)), toolCalls: rs.reduce((s, r) => s + r.tools.length, 0) }];
      }),
    ) as EvalSummary["latency"],
    lost,
  };
}
