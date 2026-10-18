import { readFileSync } from "node:fs";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../graph/db";
import { ensureBaseGraphs } from "../graph/seed";
import { dropSandbox, ensureSandbox } from "../graph/tenancy";
import { toolCheck } from "./analyze";
import { unavailable } from "./availability";
import type { EvalQuestion } from "./questions";
import {
  evalToolset,
  EVAL_VISITOR,
  modelReady,
  runBaselineArm,
  runBatch,
  runGraphArm,
  runOrder,
  runQuestion,
  type ArmRecord,
  type Halt,
  type RunnerDeps,
} from "./runner";
import { currentRun, doneKeys, finishRun, getResult, reopenRun, resultPage, saveResult, startRun } from "./store";

/*
 * Integration: the runner against a live FalkorDB (skipped when FALKORDB_URL is unset). The model is the AI SDK's
 * mock, scripted to call the real tools, so the plumbing is tested without a key; the rules arm needs no model.
 */
const mocks = vi.hoisted(() => ({ chain: [] as { id: string; model: unknown }[] }));
vi.mock("@/lib/agent/models", async (original) => ({ ...(await original<typeof import("@/lib/agent/models")>()), liveChain: async () => mocks.chain }));

const questions = JSON.parse(readFileSync("data/eval/questions.json", "utf8")) as EvalQuestion[];
const byId = (id: string) => questions.find((q) => q.id === id)!;

const usage = { inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 8, text: 8, reasoning: 0 } };
const toolStep = (toolName: string, input: object) =>
  convertArrayToReadableStream([
    { type: "stream-start" as const, warnings: [] },
    { type: "tool-call" as const, toolCallId: `${toolName}-call`, toolName, input: JSON.stringify(input) },
    { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage },
  ]);
const textStep = (text: string) =>
  convertArrayToReadableStream([
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "t" },
    { type: "text-delta" as const, id: "t", delta: text },
    { type: "text-end" as const, id: "t" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
  ]);

/** A model that resolves the L's ends, closes it, counts riders and answers from the tool's figure. */
function scriptedModel() {
  const steps = [
    toolStep("resolve_places", { names: ["Bedford Av", "14 St/8 Av"], route_hint: "L" }),
    toolStep("close_line", { routes: ["L"], from_station_id: "120", to_station_id: "618", report: "Eval" }),
    toolStep("affected_riders", { depth: 1 }),
    textStep("The closure is open and affected_riders counted the trips.\nAnswer: 23,445 riders an hour"),
  ];
  let i = 0;
  return new MockLanguageModelV4({ modelId: "scripted", doStream: async () => ({ stream: steps[Math.min(i++, steps.length - 1)] }) });
}

describe("eval pacing on free models", () => {
  const q = byId("impact-l-canarsie-total");
  const base = { visitorId: EVAL_VISITOR, sandbox: "unused", agentId: "controller" };
  const toolset = async () => ({ tools: {}, via: "in-process" as const, close: async () => undefined });

  it("runs held-out questions first, one category at a time, so a run cut short covers every kind", () => {
    const order = runOrder(questions);
    const heldout = questions.filter((x) => x.split === "heldout");
    expect(new Set(order).size).toBe(questions.length);
    expect(order.slice(0, heldout.length).every((id) => byId(id).split === "heldout")).toBe(true);
    const categories = new Set(heldout.map((x) => x.category));
    expect(new Set(order.slice(0, categories.size).map((id) => byId(id).category)).size).toBe(categories.size);
  });

  it("pauses without recording anything when no model will be free soon", async () => {
    const saved: ArmRecord[] = [];
    const halt: { value: Halt | null } = { value: null };
    const deps: RunnerDeps = { base, toolset, chain: async () => [], soonest: async () => null };
    expect(await runQuestion(q, deps, { arms: ["graph", "baseline"], save: async (r) => void saved.push(r), halt })).toEqual([]);
    expect([saved.length, halt.value]).toEqual([0, "paused"]);
  });

  it("waits out a short cool-down, and leaves a longer one to the next batch", async () => {
    let calls = 0;
    const deps: RunnerDeps = { base, toolset, chain: async () => (calls++ ? [{ id: "mock:x", model: {} as never }] : []), soonest: async () => 30 };
    expect(await modelReady(deps)).toBe("ready");
    expect(calls).toBe(2);
    expect(await modelReady({ ...deps, chain: async () => [], soonest: async () => 60_000 }, Date.now() + 1_000)).toBe("later");
  });

  it("gives the baseline the graph arm's model, waiting out its short cool-down instead of switching", async () => {
    const plain = (id: string) =>
      new MockLanguageModelV4({
        modelId: id,
        doGenerate: async () => ({ content: [{ type: "text", text: "Answer: 10" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
      });
    const other = { id: "mock:other", model: plain("other") };
    const same = { id: "mock:same", model: plain("same") };
    let calls = 0;
    const deps: RunnerDeps = { base, toolset, chain: async () => (calls++ ? [other, same] : [other]), cooling: (id) => (id === "mock:same" ? 40 : 0) };
    const r = await runBaselineArm(q, "mock:same", deps);
    expect(r.model).toBe("mock:same");
    expect(calls).toBe(2);
  });

  it("runs again only the arms that met the free models' limits", () => {
    expect(unavailable("No free model can answer right now: none is configured, or every one has spent its daily quota.")).toBe(true);
    expect(unavailable("The model `qwen/qwen3-32b` does not exist or you do not have access to it.")).toBe(true);
    expect(unavailable("The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.")).toBe(true);
    expect(unavailable("You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 PerDay")).toBe(true);
    expect(unavailable("Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000")).toBe(true);
    expect(unavailable("took longer than 100 s")).toBe(false);
    expect(unavailable("Can't reach the graph database right now.")).toBe(false);
  });
});

describe.skipIf(!process.env.FALKORDB_URL)("eval runner on a live FalkorDB", () => {
  let deps: RunnerDeps;

  beforeAll(async () => {
    await ensureBaseGraphs(() => undefined, false);
    const sandbox = await ensureSandbox(EVAL_VISITOR);
    const base = { visitorId: EVAL_VISITOR, sandbox: sandbox.graph, agentId: "controller" };
    deps = { base, toolset: (emit) => evalToolset(base, emit), chain: async () => mocks.chain as never, armTimeoutMs: 60_000 };
  }, 180_000);

  afterAll(async () => {
    await dropSandbox(EVAL_VISITOR).catch(() => undefined);
  });

  it("answers known questions with the rules-only arm, recording each tool's time and rows", async () => {
    const ids = [
      "impact-l-canarsie-total",
      "impact-l-canarsie-depth1",
      "cutoff-l-canarsie-119",
      "route-125-119-transfers",
      "stepfree-630-601-minutes",
      "lines-602",
      "memory-myrtle-elevator-since",
      "memory-june-share",
      "memory-playbook-bus-share",
      "bottleneck-l-canarsie-cut",
      "unk-lines-1",
      "nig-reach-507-224",
    ];
    const saved: ArmRecord[] = [];
    for (const id of ids) await runQuestion(byId(id), deps, { arms: ["rules"], save: async (r) => void saved.push(r) });
    for (const r of saved) {
      expect({ qid: r.qid, correct: r.correct, error: r.error }).toEqual({ qid: r.qid, correct: true, error: undefined });
      expect(r.tools.length).toBeGreaterThan(0);
      expect(r.tools.every((t) => t.queries > 0 && t.ms >= 0)).toBe(true);
      expect(toolCheck(byId(r.qid), r.tools).ordered).toBe(true);
    }
    // The sandbox is back to the template's state: no closure, no incident the eval made.
    const open = await run<{ n: number }>(deps.base.sandbox, "MATCH ()-[r:RUNS {closed: true}]->() RETURN count(r) AS n");
    const made = await run<{ n: number }>(deps.base.sandbox, "MATCH (i:Incident) WHERE i.example IS NULL RETURN count(i) AS n");
    expect([open.rows[0].n, made.rows[0].n]).toEqual([0, 0]);
  }, 240_000);

  it("runs the graph arm through the product's agent loop and tools, graded and grounded", async () => {
    mocks.chain = [{ id: "mock:scripted", model: scriptedModel() }];
    const q = byId("impact-l-canarsie-total");
    const r = await runGraphArm(q, deps);
    expect(r.error).toBeUndefined();
    expect(r.model).toBe("mock:scripted");
    expect(r.via).toBe("in-process");
    expect(r.tools.map((t) => t.tool)).toEqual(["resolve_places", "close_line", "affected_riders"]);
    expect(r.tools.every((t) => t.outcome === "answered" && t.rows > 0)).toBe(true);
    expect(r.correct).toBe(true);
    expect(r.grounding).toEqual({ checked: 1, unmatched: [] });
    expect(toolCheck(q, r.tools)).toEqual({ called: true, ordered: true });
  }, 120_000);

  it("gives the baseline the same model with no tools, and records its tokens", async () => {
    const model = new MockLanguageModelV4({
      modelId: "plain",
      doGenerate: async () => ({ content: [{ type: "text", text: "Roughly.\nAnswer: 20,000" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
    });
    mocks.chain = [{ id: "mock:other", model: scriptedModel() }, { id: "mock:plain", model }];
    const r = await runBaselineArm(byId("impact-l-canarsie-total"), "mock:plain", deps);
    expect(r).toMatchObject({ arm: "baseline", model: "mock:plain", correct: false, final: "20,000", tokens: { input: 40, output: 8 }, tools: [] });
    expect(model.doGenerateCalls[0].tools ?? []).toEqual([]);
  });

  it("stores results in the eval graph and resumes where a batch stopped", async () => {
    const order = runOrder(questions).slice(0, 2);
    await startRun({ id: "eval-test", startedMs: Date.now(), finishedMs: null, order, status: "running" });
    expect((await currentRun())?.order).toEqual(order);

    // Out of time before the first arm: nothing runs, everything remains.
    const none = await runBatch({ questions, order, deps, done: new Set(), save: (r) => saveResult("eval-test", r), graphModel: async () => null, until: Date.now(), arms: ["rules"] });
    expect(none).toEqual({ ran: [], remaining: 2, paused: false });

    const batch = await runBatch({ questions, order, deps, done: await doneKeys("eval-test"), save: (r) => saveResult("eval-test", r), graphModel: async () => null, until: Date.now() + 200_000, arms: ["rules"] });
    expect(batch.remaining).toBe(0);
    expect(await doneKeys("eval-test")).toEqual(new Set(order.map((id) => `${id}|rules`)));
    expect((await resultPage("eval-test", 0, 10)).map((r) => r.qid).sort()).toEqual([...order].sort());
    expect((await getResult("eval-test", order[0], "rules"))?.arm).toBe("rules");
    await finishRun("eval-test");
    expect((await currentRun())?.status).toBe("done");

    // Reopening runs again only the arms that met the free models' limits; a timeout stays a wrong answer.
    const rec = (await getResult("eval-test", order[0], "rules"))!;
    await saveResult("eval-test", { ...rec, arm: "graph", error: "No free model can answer right now." });
    await saveResult("eval-test", { ...rec, qid: order[1], arm: "graph", error: "took longer than 100 s" });
    expect(await reopenRun("eval-test", order, unavailable)).toBe(1);
    expect((await currentRun())?.status).toBe("running");
    const keys = await doneKeys("eval-test");
    expect([keys.has(`${order[0]}|graph`), keys.has(`${order[1]}|graph`), keys.has(`${order[0]}|rules`)]).toEqual([false, true, true]);
    await finishRun("eval-test");
  }, 240_000);
});
