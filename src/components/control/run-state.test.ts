import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/agent/catalog";
import { capacityOf, impactOf, initialRun, lastDrawable, overlayAt, plansOf, recommendedPlan, reduce, ridersOf, type RunState } from "./run-state";

const events = (file: string) =>
  readFileSync(`data/replays/${file}`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { event: AgentEvent }).event);

const play = (state: RunState, file: string, scenarioId?: string) => events(file).reduce((s, event) => reduce(s, { type: "event", event, scenarioId }), state);

describe("control room state on the recorded L closure", () => {
  const control = play(reduce(initialRun, { type: "start", stage: "control" }), "l-canarsie-control.ndjson");

  it("finishes with a brief that is not repeated in the narration", () => {
    expect(control.status).toBe("done");
    // Recorded from a live model run on production (the replay route labels it as a recording when it plays).
    expect(control.mode).toBe("live");
    expect(control.brief).toMatch(/^\*\*What broke\*\*/);
    const said = control.items.filter((i) => i.kind === "say").map((i) => (i.kind === "say" ? i.text : ""));
    expect(said.some((t) => t.includes("**What broke**"))).toBe(false);
  });

  it("reads impact, capacity and the recommended plan from the tool results", () => {
    expect(impactOf(control.items)?.totalRiders).toBe(23445);
    expect(capacityOf(control.items)?.reroute.stranded).toBe(4689);
    const plans = plansOf(control.items);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    const rec = recommendedPlan(control.brief, plans);
    const chosen = plans.find((p) => p.id === rec);
    expect(chosen).toBeDefined();
    expect(chosen!.after.stranded).toBeLessThan(chosen!.before.stranded);
  });

  it("draws the closure with the latest step's evidence", () => {
    const { overlay, focus } = overlayAt(control.items, lastDrawable(control.items));
    expect(overlay.closedEids).toHaveLength(10);
    expect(focus).toContain("120");
    const capStep = control.items.findIndex((i) => i.kind === "tool" && i.tool === "measure_capacity");
    const atCap = overlayAt(control.items, capStep).overlay;
    expect(atCap.flows?.length).toBeGreaterThan(0);
    expect(atCap.overloaded?.[0].pct).toBe(244);
  });

  it("hands the map the same overlay for a step until that step or the closure in force changes", () => {
    const capStep = control.items.findIndex((i) => i.kind === "tool" && i.tool === "measure_capacity");
    const first = overlayAt(control.items, capStep);
    // More narration streams in: the items array is new, the step is not.
    const narrated = reduce(control, { type: "event", event: { type: "text", agent: "controller", delta: "More words." } });
    expect(narrated.items).not.toBe(control.items);
    expect(overlayAt(narrated.items, capStep)).toBe(first);
    // The step before it shows different evidence.
    expect(overlayAt(control.items, capStep - 1)).not.toBe(first);
  });

  it("hands off to the rider desk on approval and collects one advisory per affected rider", () => {
    const planId = recommendedPlan(control.brief, plansOf(control.items))!;
    const desk = play(reduce(control, { type: "start", stage: "desk", planId }), "l-canarsie-publish.ndjson");
    expect(desk.status).toBe("done");
    expect(desk.published).toBe(planId);
    expect(desk.items.some((i) => i.kind === "handoff")).toBe(true);
    const riders = ridersOf(desk);
    expect(riders.map((r) => r.profile.id).sort()).toEqual(["aisha", "dev", "maya", "tomas"]);
    const aisha = riders.find((r) => r.profile.id === "aisha")!;
    expect(aisha.advisory).toMatch(/step-free/);
    expect(aisha.answer?.legs.every((l) => l.route !== "L")).toBe(true);
    const shuttle = overlayAt(desk.items, desk.items.length - 1).overlay.shuttles;
    expect(shuttle?.[0]).toMatchObject({ from: expect.any(String), to: expect.any(String) });
  });
});

describe("control room state on a closure the network absorbs", () => {
  it("proposes steering instead of buses", () => {
    const control = play(reduce(initialRun, { type: "start", stage: "control" }), "lex-express-control.ndjson");
    const plans = plansOf(control.items);
    expect(plans).toHaveLength(1);
    expect(plans[0].kind).toBe("steer");
    expect(plans[0].vehicles).toBe(0);
  });
});

describe("a live run the database drops", () => {
  it("starts a clean trace when the recorded run takes over", () => {
    let s: RunState = reduce(initialRun, { type: "start", stage: "control" });
    const live: AgentEvent[] = [
      { type: "run", runId: "r1", agent: "controller", mode: "live" },
      { type: "tool-call", agent: "controller", id: "resolve_places-1", tool: "resolve_places", input: {} },
      { type: "tool-error", agent: "controller", id: "resolve_places-1", tool: "resolve_places", message: "Can't reach the graph database right now." },
    ];
    for (const event of live) s = reduce(s, { type: "event", event, scenarioId: "l-canarsie" });
    expect(s.items.length).toBeGreaterThan(0);
    s = reduce(s, { type: "event", event: { type: "run", runId: "r1", agent: "controller", mode: "replay", note: "recorded" }, scenarioId: "l-canarsie" });
    expect({ items: s.items.length, mode: s.mode, recorded: s.recorded, status: s.status }).toEqual({ items: 0, mode: "replay", recorded: "l-canarsie", status: "running" });
  });
});
