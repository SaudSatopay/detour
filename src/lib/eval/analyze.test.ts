import { describe, expect, it } from "vitest";
import { bootstrap, pairedDifference, summarize, toolCheck } from "./analyze";
import type { EvalQuestion } from "./questions";
import type { ArmRecord, ToolCall } from "./runner";

const call = (tool: string, input: object = {}, outcome = "answered"): ToolCall => ({ tool, input: JSON.stringify(input), outcome, ms: 3, rows: 1, queries: 1 });

describe("bootstrap intervals", () => {
  it("is seeded, brackets the rate and collapses when every outcome agrees", () => {
    const outcomes = Array.from({ length: 100 }, (_, i) => i % 4 !== 0);
    const a = bootstrap(outcomes);
    expect(bootstrap(outcomes)).toEqual(a);
    expect(a.rate).toBe(0.75);
    expect(a.lo).toBeLessThan(0.75);
    expect(a.hi).toBeGreaterThan(0.75);
    expect(a.hi - a.lo).toBeGreaterThan(0.1);
    expect(a.hi - a.lo).toBeLessThan(0.25);
    expect(bootstrap([true, true, true])).toMatchObject({ rate: 1, lo: 1, hi: 1 });
    expect(bootstrap([])).toMatchObject({ n: 0, rate: 0 });
  });

  it("narrows with more questions", () => {
    const small = bootstrap(Array.from({ length: 20 }, (_, i) => i % 2 === 0));
    const large = bootstrap(Array.from({ length: 400 }, (_, i) => i % 2 === 0));
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });

  it("pairs the difference question by question", () => {
    const a = [true, true, true, false, true, true, true, true, true, true];
    const b = [false, true, false, false, true, false, true, false, true, false];
    const d = pairedDifference(a, b);
    expect(d.diff).toBeCloseTo(0.5);
    expect(d.lo).toBeGreaterThan(0);
    expect(d.hi).toBeLessThanOrEqual(1);
    expect(pairedDifference(a, a)).toMatchObject({ diff: 0, lo: 0, hi: 0 });
  });
});

describe("tool choice", () => {
  const impact = { needs: ["resolve_places", "close_line", "affected_riders"] };

  it("accepts names resolved before ids and a closure before measuring", () => {
    const calls = [call("resolve_places", { names: ["Bedford Av"] }), call("close_line", { routes: ["L"], from_station_id: "120" }), call("affected_riders")];
    expect(toolCheck(impact, calls)).toEqual({ called: true, ordered: true });
  });

  it("flags an id used before any name was resolved", () => {
    const calls = [call("close_line", { routes: ["L"], from_station_id: "120" }), call("resolve_places"), call("affected_riders")];
    expect(toolCheck(impact, calls)).toEqual({ called: true, ordered: false });
  });

  it("flags measuring with no closure open, and a missing tool", () => {
    expect(toolCheck(impact, [call("resolve_places"), call("affected_riders"), call("close_line", { from_station_id: "120" })]).ordered).toBe(false);
    expect(toolCheck(impact, [call("resolve_places"), call("close_line", {}, "not_in_graph"), call("affected_riders")]).ordered).toBe(false);
    expect(toolCheck(impact, [call("resolve_places"), call("close_line", { from_station_id: "120" })]).called).toBe(false);
  });

  it("lets memory be read by route without resolving, but not by station id", () => {
    const memory = { needs: ["recall_memory"] };
    expect(toolCheck(memory, [call("recall_memory", { routes: ["L"] })]).ordered).toBe(true);
    expect(toolCheck(memory, [call("recall_memory", { station_ids: ["630"] })]).ordered).toBe(false);
  });
});

describe("summary", () => {
  const q = (id: string, split: "dev" | "heldout", category: EvalQuestion["category"], expect: EvalQuestion["expect"] = { kind: "number", value: 10, tolerance: 0 }): EvalQuestion => ({
    id,
    split,
    category,
    group: id,
    question: `question ${id}`,
    expect,
    source: "test",
    needs: ["resolve_places"],
  });
  const r = (qid: string, arm: ArmRecord["arm"], correct: boolean, extra: Partial<ArmRecord> = {}): ArmRecord => ({
    qid,
    arm,
    split: "heldout",
    category: "route",
    model: arm === "rules" ? null : "google:test",
    answer: "",
    final: correct ? "10" : "12",
    correct,
    declined: false,
    tools: arm === "baseline" ? [] : [call("resolve_places")],
    tokens: null,
    ms: 100,
    steps: 1,
    at: 0,
    ...extra,
  });
  const questions = [q("a", "heldout", "route"), q("b", "heldout", "route"), q("c", "heldout", "unknown_entity", { kind: "decline" }), q("d", "dev", "route")];
  const records = [
    r("a", "graph", true),
    r("a", "baseline", false),
    r("a", "rules", true),
    r("b", "graph", false, { final: "12" }),
    r("b", "baseline", true),
    r("b", "rules", true),
    r("c", "graph", true, { declined: true }),
    r("c", "baseline", true, { declined: true }),
    r("c", "rules", true, { declined: true }),
    r("d", "graph", true),
    r("d", "baseline", false),
    r("d", "rules", true),
  ];

  it("reports held-out accuracy per arm, and lists where the graph agent lost", () => {
    const s = summarize(questions, records, { id: "eval-x", startedMs: Date.UTC(2026, 9, 19) });
    expect(s.status).toBe("complete");
    expect(s.questions).toMatchObject({ total: 4, heldout: 3, dev: 1 });
    expect(s.arms.graph.heldout).toMatchObject({ n: 3, correct: 2 });
    expect(s.arms.baseline.heldout).toMatchObject({ n: 3, correct: 2 });
    expect(s.arms.graph.dev).toMatchObject({ n: 1, correct: 1 });
    expect(s.arms.graph.models).toEqual({ "google:test": 4 });
    expect(s.lost.map((l) => l.qid)).toEqual(["b"]);
    expect(s.lost[0].why).toMatch(/final answer did not match/);
    expect(s.abstention.graph.shouldDecline).toMatchObject({ n: 1, correct: 1 });
    expect(s.abstention.graph.falseDecline).toMatchObject({ n: 2, correct: 0 });
    expect(s.run.startedAt).toBe("2026-10-19T00:00:00.000Z");
  });

  it("leaves out arms that met a spent free quota, and counts any other error wrong", () => {
    const quota = r("a", "graph", false, { error: "No free model can answer right now: none is configured, or every one has spent its daily quota." });
    const timeout = r("d", "graph", false, { error: "took longer than 100 s" });
    const s = summarize(questions, [...records.filter((x) => !(x.arm === "graph" && ["a", "d"].includes(x.qid))), quota, timeout]);
    expect(s.leftOut).toBe(1);
    expect(s.coverage.graph).toBe(3);
    expect(s.arms.graph.heldout).toMatchObject({ n: 2, correct: 1 });
    expect(s.arms.graph.dev).toMatchObject({ n: 1, correct: 0 });
    expect(s.arms.graph.errors).toBe(1);
  });

  it("says when nothing has run", () => {
    expect(summarize(questions, []).status).toBe("not-run");
    expect(summarize(questions, records.filter((x) => x.arm === "rules")).status).toBe("partial");
  });
});
