import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/agent/catalog";
import { TOOL_TITLE } from "@/lib/tool-titles";
import { advance, initialRun, initialTimeline, reduce, stepView, type RunAction } from "./run-state";

const events = readFileSync("data/replays/l-canarsie-control.ndjson", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => (JSON.parse(l) as { event: AgentEvent }).event);
const actions: RunAction[] = [{ type: "start", stage: "control" }, ...events.map((event): RunAction => ({ type: "event", event }))];
const timeline = actions.reduce(advance, initialTimeline);
const calls = events.flatMap((e) => (e.type === "tool-call" ? [e] : []));

/** Index of the action that finished a tool call, found without the timeline. */
const finished = (id: string, agent: string) =>
  actions.findIndex((a) => a.type === "event" && (a.event.type === "tool-result" || a.event.type === "tool-error") && a.event.id === id && a.event.agent === agent);

describe("playback of the recorded L closure", () => {
  it("has one step per tool call, in call order, under the names the trace shows", () => {
    // The recording is a live model run, so the exact path is the model's; the order a closure needs is fixed.
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(timeline.steps).toHaveLength(calls.length);
    expect(timeline.ready).toBe(calls.length);
    const titles = timeline.steps.map((s) => s.title);
    expect(titles).toEqual(calls.map((c) => TOOL_TITLE[c.tool] ?? c.tool));
    const at = (title: string) => titles.indexOf(title);
    expect(at("Resolve names")).toBe(0);
    expect(at("Close the line")).toBeLessThan(at("Measure capacity"));
    expect(at("Measure capacity")).toBeLessThan(at("Simulate a plan"));
    expect(titles).toContain("Remember a finding");
  });

  it("holds, for every step k, the run reduced up to the event that finished step k", () => {
    for (let k = 1; k <= calls.length; k++) {
      const end = Math.max(...calls.slice(0, k).map((c) => finished(c.id, c.agent)));
      expect(end).toBeGreaterThan(0);
      const expected = actions.slice(0, end + 1).reduce(reduce, initialRun);
      expect(timeline.at[k - 1]).toEqual(expected);
    }
  });

  it("shows exactly k finished steps at step k, the same object each time it is asked", () => {
    for (let k = 1; k <= calls.length; k++) {
      const view = stepView(timeline.at[k - 1], k);
      const tools = view.items.filter((i) => i.kind === "tool");
      expect(tools).toHaveLength(k);
      expect(tools.every((i) => Boolean(i.result || i.error))).toBe(true);
      expect(stepView(timeline.at[k - 1], k)).toBe(view);
    }
  });

  it("keeps the live state equal to the plain reduction, brief included", () => {
    expect(timeline.run).toEqual(actions.reduce(reduce, initialRun));
    expect(timeline.run.brief).toMatch(/^\*\*What broke\*\*/);
    expect(timeline.at[calls.length - 1].brief).toBeNull();
  });

  it("starts over on a new controller run and keeps counting through an approval", () => {
    const again = advance(timeline, { type: "start", stage: "control" });
    expect(again.steps).toHaveLength(0);
    expect(again.ready).toBe(0);
    const desk = advance(timeline, { type: "start", stage: "desk", planId: "PLAN-X" });
    expect(desk.steps).toHaveLength(calls.length);
    expect(desk.at).toBe(timeline.at);
  });
});
