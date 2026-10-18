import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Demand, Network } from "../network/types";
import { closeLine, fastestTrip, impact, platformGraph, reachable, stepFreeRule, transfersOf } from "./gold";
import { ABSTAIN, buildQuestions, couldResolve, SEED, type Inputs, type VerifyOutput } from "./questions";

const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const network = read<Network>("data/nyc/network.json");
const demand = read<Demand>("data/nyc/demand.json");
const scenarios = read<Inputs["scenarios"]>("data/scenarios.json");
const verify = Object.fromEntries(scenarios.map((s) => [s.id, read<VerifyOutput>(`data/nyc/verify/${s.id}.json`)]));
const inputs: Inputs = { network, demand, scenarios, verify };

describe("gold answers without FalkorDB", () => {
  const graph = platformGraph(network);
  const L = closeLine(network, ["L"], "120", "618")!;

  it("counts the L closure's displaced riders and depth the way the NetworkX verifier does", () => {
    const imp = impact(network, demand.pairs, L);
    expect(L.closedEids).toEqual(read<{ closedEids: number[] }>("data/nyc/verify/l-canarsie.json").closedEids);
    expect(imp.total).toBe(23445);
    expect(imp.byDepth[1]).toBe(10142);
    for (const s of scenarios) {
      const c = closeLine(network, s.routes, s.stations[0], s.stations[s.stations.length - 1])!;
      const byDepth = impact(network, demand.pairs, c).byDepth;
      for (const d of verify[s.id].depthCounts) expect(Math.abs(byDepth[d.k] - d.riders)).toBeLessThanOrEqual(1);
    }
  });

  it("prices trips like route_rider: Dev's commute during the L closure is 41 min with two transfers", () => {
    const dev = fastestTrip(graph, "120", "618", { closedEids: L.closedEids })!;
    expect(dev.minutes).toBeCloseTo(40.8, 1);
    expect(transfersOf(dev.minBoardings)).toBe(2);
    expect(dev.minBoardings).toBe(dev.maxBoardings);
    // Sam's trip with the 4 and 5 suspended: the 6, no transfer (both recorded from FalkorDB in data/proof).
    const lex = closeLine(network, ["4", "5"], "610", "622")!;
    const sam = fastestTrip(graph, "610", "622", { closedEids: lex.closedEids })!;
    expect(Math.round(sam.minutes)).toBe(19);
    expect(transfersOf(sam.minBoardings)).toBe(0);
  });

  it("routes step-free around the Myrtle-Wyckoff L elevator outage, and finds no path from Staten Island", () => {
    const stepOk = stepFreeRule(network, [{ station: "630", routes: ["L"] }]);
    expect(Math.round(fastestTrip(graph, "630", "601", { stepOk })!.minutes)).toBe(33);
    expect(fastestTrip(graph, "630", "601")!.minutes).toBeLessThan(33);
    const stGeorge = network.stations.find((s) => s.name === "St George")!;
    expect(fastestTrip(graph, stGeorge.id, "611")).toBeNull();
    expect(reachable(network, stGeorge.id).has("611")).toBe(false);
  });

  it("cuts 1 Av off when the L is closed", () => {
    expect(reachable(network, "119", L.closedEids).size).toBeLessThan(5);
    expect(reachable(network, "119").has("611")).toBe(true);
  });
});

describe("the eval set", () => {
  const questions = buildQuestions(inputs, SEED);

  it("is deterministic for a seed", () => {
    expect(buildQuestions(inputs, SEED)).toEqual(questions);
    expect(buildQuestions(inputs, SEED + 1).map((q) => q.id)).not.toEqual(questions.map((q) => q.id));
  });

  it("matches the committed file, so the split was fixed before any run", () => {
    expect(read("data/eval/questions.json")).toEqual(questions);
  });

  it("has at least 120 questions, about 30% dev, and no group across the split", () => {
    expect(questions.length).toBeGreaterThanOrEqual(120);
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    const dev = questions.filter((q) => q.split === "dev").length / questions.length;
    expect(dev).toBeGreaterThan(0.25);
    expect(dev).toBeLessThan(0.35);
    const splitOf = new Map<string, string>();
    for (const q of questions) {
      expect(splitOf.get(q.group) ?? q.split).toBe(q.split);
      splitOf.set(q.group, q.split);
    }
  });

  it("covers every kind of question, with about a fifth to decline", () => {
    const categories = new Set(questions.map((q) => q.category));
    for (const c of ["impact", "capacity", "bottleneck", "route", "step_free", "lines", "cut_off", "memory", "not_in_graph", "unknown_entity"]) {
      expect(categories.has(c as never)).toBe(true);
    }
    const abstain = questions.filter((q) => ABSTAIN.includes(q.category)).length / questions.length;
    expect(abstain).toBeGreaterThan(0.15);
    expect(abstain).toBeLessThan(0.25);
    // Depth 1 and depth 4 of the same closure, as the organisers ask.
    const d1 = questions.filter((q) => q.depth === 1).map((q) => q.group);
    expect(d1.length).toBeGreaterThanOrEqual(10);
    for (const g of d1) expect(questions.some((q) => q.group === g && q.depth === 4)).toBe(true);
  });

  it("asks closures beyond the three presets, and max flow only for the presets", () => {
    const closureGroups = new Set(questions.filter((q) => q.category === "impact").map((q) => q.group));
    expect(closureGroups.size).toBeGreaterThanOrEqual(12);
    const presets = new Set(scenarios.map((s) => `closure-${s.id}`));
    for (const q of questions.filter((q) => q.category === "capacity" || q.category === "bottleneck")) expect(presets.has(q.group)).toBe(true);
  });

  it("carries known gold answers", () => {
    const byId = new Map(questions.map((q) => [q.id, q]));
    expect(byId.get("impact-l-canarsie-total")!.expect).toMatchObject({ kind: "number", value: 23445 });
    expect(byId.get("impact-l-canarsie-depth1")!.expect).toMatchObject({ kind: "number", value: 10142 });
    expect(byId.get("capacity-l-canarsie-unmet")!.expect).toMatchObject({ kind: "number", value: 1266 });
    expect(byId.get("bottleneck-l-canarsie-cut")!.expect).toEqual({ kind: "contains", any: ["1 Av"] });
    expect(byId.get("memory-myrtle-elevator-since")!.expect).toEqual({ kind: "date", iso: "2026-10-14" });
    expect(byId.get("memory-june-share")!.expect).toMatchObject({ value: 79 });
    expect(byId.get("stepfree-630-601-minutes")!.expect).toMatchObject({ value: 33.3 });
  });

  it("uses made-up names that no station could match", () => {
    expect(couldResolve("Bedford Av", network)).toBe(true);
    expect(couldResolve("Times Square", network)).toBe(true);
    expect(couldResolve("Hogsmeade", network)).toBe(false);
    for (const q of questions.filter((q) => q.category === "unknown_entity")) expect(q.expect.kind).toBe("decline");
  });
});
