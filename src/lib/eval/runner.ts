import { generateText, type ToolSet } from "ai";
import { buildTools, type AgentEvent, type Emit } from "../agent/catalog";
import { ground, type Grounding } from "../agent/grounding";
import { mcpToolset } from "../agent/mcp-tools";
import { classify, type ChainedModel } from "../agent/models";
import { BASELINE_INSTRUCTIONS, EVAL_INSTRUCTIONS } from "../agent/prompts";
import { runAgent } from "../agent/run";
import { run } from "../graph/db";
import { dropForks } from "../graph/tenancy";
import type { ToolContext, ToolResult } from "../graph/tools/types";
import { NO_MODEL } from "./availability";
import { declines, finalAnswer, grade } from "./grade";
import type { EvalQuestion } from "./questions";
import { rulesAnswer } from "./rules";

/**
 * Runs one eval question through three arms on one dedicated sandbox graph:
 *   graph     the product's agent loop (runAgent, the free model chain) with Detour's tools, over MCP when the
 *             deployment's origin is known, in-process otherwise
 *   baseline  the same model the graph arm ended on, same question, no tools and no graph
 *   rules     no model: a deterministic router over the same tools (rules.ts)
 * The sandbox is put back to the template's state before each arm that can change it.
 */
export type Arm = "graph" | "baseline" | "rules";
export const ARMS: Arm[] = ["graph", "baseline", "rules"];

/** The eval's own visitor id: one sandbox graph, never a visitor's. */
export const EVAL_VISITOR = "evalrunner0001";

/** What the graph arm may call: the questions' tools, none that publish, plan, write memory or run the brain. */
export const EVAL_TOOLS = ["resolve_places", "recall_memory", "close_line", "affected_riders", "measure_capacity", "route_rider"];

export interface ToolCall {
  tool: string;
  /** The arguments, as JSON, shortened. */
  input: string;
  outcome: string | null;
  /** Summed query time and rows of the Cypher the tool ran. */
  ms: number;
  rows: number;
  queries: number;
}

export interface ArmRecord {
  qid: string;
  arm: Arm;
  split: EvalQuestion["split"];
  category: EvalQuestion["category"];
  model: string | null;
  answer: string;
  final: string;
  correct: boolean;
  declined: boolean;
  tools: ToolCall[];
  tokens: { input: number | null; output: number | null } | null;
  ms: number;
  steps: number | null;
  via?: "mcp" | "in-process";
  grounding?: Grounding;
  error?: string;
  at: number;
}

export interface Toolset {
  tools: ToolSet;
  via: "mcp" | "in-process";
  close: () => Promise<void>;
}

export interface RunnerDeps {
  /** The eval sandbox. */
  base: Omit<ToolContext, "tracer">;
  /** The graph arm's tools, wired to emit events (see evalToolset). */
  toolset: (emit: Emit) => Promise<Toolset>;
  /** The models both model arms may use, in order (the deployment's live chain, less what it leaves to visitors). */
  chain: () => Promise<ChainedModel[]>;
  /** How long until a model cooling off after a per-minute limit is back; null when none will be soon. */
  soonest?: () => Promise<number | null>;
  /** One question's cap per arm, so a stuck model cannot eat the batch. */
  armTimeoutMs?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function toolCall(tool: string, input: unknown, result: ToolResult | null): ToolCall {
  const trace = result?.trace ?? [];
  return {
    tool,
    input: clip(JSON.stringify(input ?? {}), 240),
    outcome: result?.outcome ?? null,
    ms: Math.round(trace.reduce((s, t) => s + t.ms, 0)),
    rows: trace.reduce((s, t) => s + t.rows, 0),
    queries: trace.length,
  };
}

/**
 * The graph arm's tools: the controller's and the rider desk's from the product's catalogue, cut down to
 * EVAL_TOOLS. With an origin they come from Detour's MCP server (one session per role, the same sandbox), as the
 * control room's agents get theirs; without one, or if the server is unreachable, they run in-process.
 */
export async function evalToolset(base: Omit<ToolContext, "tracer">, emit: Emit, origin?: string): Promise<Toolset> {
  const keep = (tools: ToolSet) => Object.fromEntries(Object.entries(tools).filter(([name]) => EVAL_TOOLS.includes(name)));
  if (origin) {
    const opened: { close: () => Promise<void> }[] = [];
    try {
      const tools: ToolSet = {};
      for (const role of ["controller", "rider-desk"] as const) {
        const set = await mcpToolset({ origin, visitorId: base.visitorId, role, emit, why: () => "" });
        opened.push(set);
        for (const [name, t] of Object.entries(keep(set.tools))) tools[name] ??= t;
      }
      return { tools, via: "mcp", close: async () => void (await Promise.all(opened.map((s) => s.close().catch(() => undefined)))) };
    } catch {
      await Promise.all(opened.map((s) => s.close().catch(() => undefined)));
    }
  }
  const tools: ToolSet = { ...keep(buildTools({ ...base, agentId: "rider-desk" }, emit, "rider-desk")), ...keep(buildTools({ ...base, agentId: "controller" }, emit, "controller")) };
  return { tools, via: "in-process", close: async () => undefined };
}

/** Puts the eval sandbox back to the template's state: no closure, no incident, episode or finding the eval made. */
export async function cleanSandbox(base: Omit<ToolContext, "tracer">): Promise<void> {
  const g = base.sandbox;
  await run(
    g,
    `MATCH ()-[r:RUNS {closed: true}]->()
     SET r.closed = false, r.minutes = r.baseMinutes, r.spare = CASE WHEN r.capacity > r.load THEN r.capacity - r.load ELSE 0 END`,
  );
  await run(g, "MATCH ()-[r:RIDE {closed: true}]->() SET r.closed = false, r.minutes = r.baseMinutes");
  await run(g, "MATCH (i:Incident) WHERE i.example IS NULL DETACH DELETE i");
  await run(g, "MATCH (f:Finding) WHERE f.example IS NULL DETACH DELETE f");
  await run(g, "MATCH (e:Episode) DETACH DELETE e");
  await dropForks(base.visitorId);
}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`took longer than ${Math.round(ms / 1000)} s`)), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function record(q: EvalQuestion, arm: Arm, fields: Partial<ArmRecord> & { answer: string; ms: number }): ArmRecord {
  return {
    qid: q.id,
    arm,
    split: q.split,
    category: q.category,
    model: null,
    tools: [],
    tokens: null,
    steps: null,
    ...fields,
    final: clip(finalAnswer(fields.answer), 300),
    correct: grade(fields.answer, q.expect),
    declined: declines(fields.answer),
    answer: clip(fields.answer, 1200),
    at: Date.now(),
  };
}

export async function runGraphArm(q: EvalQuestion, deps: RunnerDeps): Promise<ArmRecord> {
  const calls = new Map<string, { tool: string; input: unknown; result: ToolResult | null }>();
  const results: ToolResult[] = [];
  const emit: Emit = (e: AgentEvent) => {
    if (e.type === "tool-call") calls.set(e.id, { tool: e.tool, input: e.input, result: null });
    if (e.type === "tool-result") {
      const c = calls.get(e.id);
      if (c) c.result = e.result;
      results.push(e.result);
    }
  };
  const started = performance.now();
  const timeout = withTimeout(deps.armTimeoutMs ?? 120_000);
  let set: Toolset | null = null;
  try {
    set = await deps.toolset(emit);
    const out = await runAgent({
      agent: "controller",
      instructions: EVAL_INSTRUCTIONS,
      messages: [{ role: "user", content: q.question }],
      tools: set.tools,
      emit,
      maxSteps: 8,
      abortSignal: timeout.signal,
      chain: await deps.chain(),
    });
    return record(q, "graph", {
      answer: out.text,
      model: out.model,
      steps: out.steps,
      via: set.via,
      tools: [...calls.values()].map((c) => toolCall(c.tool, c.input, c.result)),
      grounding: ground(out.text, results),
      ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    return record(q, "graph", {
      answer: "",
      via: set?.via,
      tools: [...calls.values()].map((c) => toolCall(c.tool, c.input, c.result)),
      error: clip(error instanceof Error ? error.message : String(error), 300),
      ms: Math.round(performance.now() - started),
    });
  } finally {
    timeout.clear();
    await set?.close().catch(() => undefined);
  }
}

/** The same model the graph arm ended on (the next ones in the chain only if it is rate limited), no tools. */
export async function runBaselineArm(q: EvalQuestion, modelId: string | null, deps: RunnerDeps): Promise<ArmRecord> {
  const chain = await deps.chain();
  const start = Math.max(0, chain.findIndex((m) => m.id === modelId));
  const started = performance.now();
  let lastError: unknown = null;
  for (const m of chain.slice(start)) {
    const timeout = withTimeout(deps.armTimeoutMs ?? 120_000);
    try {
      const res = await generateText({ model: m.model, instructions: BASELINE_INSTRUCTIONS, prompt: q.question, maxRetries: 2, abortSignal: timeout.signal });
      return record(q, "baseline", {
        answer: res.text,
        model: m.id,
        steps: 1,
        tokens: { input: res.usage.inputTokens ?? null, output: res.usage.outputTokens ?? null },
        ms: Math.round(performance.now() - started),
      });
    } catch (error) {
      lastError = error;
      if (classify(error) === "other") break;
    } finally {
      timeout.clear();
    }
  }
  return record(q, "baseline", {
    answer: "",
    model: chain[start]?.id ?? null,
    error: clip(lastError ? (lastError instanceof Error ? lastError.message : String(lastError)) : "No model is configured.", 300),
    ms: Math.round(performance.now() - started),
  });
}

export async function runRulesArm(q: EvalQuestion, deps: Pick<RunnerDeps, "base">): Promise<ArmRecord> {
  const started = performance.now();
  try {
    const out = await rulesAnswer(deps.base, q.question);
    return record(q, "rules", {
      answer: out.text,
      steps: out.calls.length,
      tools: out.calls.map((c) => toolCall(c.tool, c.input, c.result)),
      grounding: ground(out.text, out.calls.map((c) => c.result)),
      ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    return record(q, "rules", { answer: "", error: clip(error instanceof Error ? error.message : String(error), 300), ms: Math.round(performance.now() - started) });
  }
}

/** Why a batch stopped before its time was up. */
export type Halt = "paused" | "time";

/**
 * Whether a model arm can start: "ready" when a model can answer, after waiting out a per-minute cool-down if one
 * ends in time; "later" when one will be back, but not before `until`; "none" when every model is out for longer
 * (spent daily quotas), so the run pauses until the quotas recover.
 */
export async function modelReady(deps: RunnerDeps, until?: number): Promise<"ready" | "later" | "none"> {
  const room = (deps.armTimeoutMs ?? 120_000) + 10_000;
  for (let tries = 0; tries < 8; tries++) {
    if ((await deps.chain()).length) return "ready";
    const wait = (await deps.soonest?.()) ?? null;
    if (wait === null) return "none";
    if (until !== undefined && Date.now() + wait + room > until) return "later";
    await new Promise((resolve) => setTimeout(resolve, wait + 250));
  }
  return "none";
}

/**
 * The arms of one question that have no result yet, graph first (the baseline uses its model), each on a clean
 * sandbox. `save` stores each record as soon as it exists, so a batch cut short loses at most one arm. A model arm
 * that finds no model is not recorded: it sets `halt` ("paused" until the quotas recover, "time" when a cooling
 * model is back only after `until`) and runs in a later batch.
 */
export async function runQuestion(
  q: EvalQuestion,
  deps: RunnerDeps,
  o: {
    arms?: Arm[];
    done?: Set<string>;
    /** Set when a model arm cannot run now: the batch stops there. */
    halt?: { value: Halt | null };
    save: (r: ArmRecord) => Promise<void>;
    /** The model a graph arm from an earlier batch ended on. */
    graphModel?: () => Promise<string | null>;
    /** Epoch ms: an arm starts only if its timeout still fits before this. */
    until?: number;
  },
): Promise<ArmRecord[]> {
  const todo = (o.arms ?? ARMS).filter((a) => !o.done?.has(`${q.id}|${a}`));
  const out: ArmRecord[] = [];
  const room = (deps.armTimeoutMs ?? 120_000) + 10_000;
  let model: string | null | undefined;
  for (const arm of todo) {
    if (o.until !== undefined && Date.now() + room > o.until) break;
    if (arm !== "rules") {
      const ready = await modelReady(deps, o.until);
      if (ready !== "ready") {
        if (o.halt) o.halt.value = ready === "none" ? "paused" : "time";
        break;
      }
    }
    if (arm !== "baseline") await cleanSandbox(deps.base);
    if (arm === "baseline" && model === undefined) model = (await o.graphModel?.()) ?? null;
    const r = arm === "graph" ? await runGraphArm(q, deps) : arm === "baseline" ? await runBaselineArm(q, model ?? null, deps) : await runRulesArm(q, deps);
    if (arm !== "rules" && r.error && NO_MODEL.test(r.error)) {
      if (o.halt) o.halt.value = "paused";
      break;
    }
    if (arm === "graph") model = r.model;
    await o.save(r);
    o.done?.add(`${q.id}|${arm}`);
    out.push(r);
  }
  if (out.some((r) => r.arm !== "baseline")) await cleanSandbox(deps.base);
  return out;
}

/**
 * Questions in run order until the time is up: each question's missing arms, one question at a time. Returns how
 * many arms ran and how many are still missing.
 */
export async function runBatch(o: {
  questions: EvalQuestion[];
  order: string[];
  deps: RunnerDeps;
  done: Set<string>;
  save: (r: ArmRecord) => Promise<void>;
  graphModel: (qid: string) => Promise<string | null>;
  until: number;
  arms?: Arm[];
}): Promise<{ ran: ArmRecord[]; remaining: number; paused: boolean }> {
  const arms = o.arms ?? ARMS;
  const byId = new Map(o.questions.map((q) => [q.id, q]));
  const ran: ArmRecord[] = [];
  const halt: { value: Halt | null } = { value: null };
  for (const id of o.order) {
    const q = byId.get(id);
    if (!q || arms.every((a) => o.done.has(`${id}|${a}`))) continue;
    if (Date.now() + (o.deps.armTimeoutMs ?? 120_000) + 10_000 > o.until) break;
    ran.push(...(await runQuestion(q, o.deps, { arms, done: o.done, save: o.save, graphModel: () => o.graphModel(id), until: o.until, halt })));
    if (halt.value) break;
  }
  const remaining = o.order.reduce((n, id) => n + arms.filter((a) => !o.done.has(`${id}|${a}`)).length, 0);
  return { ran, remaining, paused: halt.value === "paused" };
}

/**
 * Held-out questions first, then dev, taking one question from each category in turn: a run cut short (a spent free
 * quota) still has its headline, across every kind of question rather than the first category in the file.
 */
export function runOrder(questions: EvalQuestion[]): string[] {
  const interleave = (qs: EvalQuestion[]) => {
    const byCategory = new Map<string, EvalQuestion[]>();
    for (const q of qs) byCategory.set(q.category, [...(byCategory.get(q.category) ?? []), q]);
    const queues = [...byCategory.values()];
    const out: string[] = [];
    while (queues.some((list) => list.length)) for (const list of queues) if (list.length) out.push(list.shift()!.id);
    return out;
  };
  return [...interleave(questions.filter((q) => q.split === "heldout")), ...interleave(questions.filter((q) => q.split === "dev"))];
}
