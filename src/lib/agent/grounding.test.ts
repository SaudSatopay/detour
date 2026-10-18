import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { figuresIn, ground } from "./grounding";
import type { ToolResult } from "../graph/tools/types";

const result = (summary: string, data: unknown): ToolResult => ({ tool: "measure_capacity", outcome: "answered", summary, data, trace: [] });

/** The tool results and brief of the committed live run of the L closure. */
function recordedRun(): { results: ToolResult[]; brief: string } {
  const events = readFileSync("data/replays/l-canarsie-control.ndjson", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).event as { type: string; result?: ToolResult; text?: string });
  return {
    results: events.filter((e) => e.type === "tool-result").map((e) => e.result!),
    brief: events.find((e) => e.type === "done")?.text ?? "",
  };
}

describe("checking a brief against the tool results", () => {
  it("picks out the figures worth checking, not stops, legs or dates", () => {
    const f = figuresIn("Closing the L hits 23,445 riders an hour, 4 stops out; the G runs at 244% (since Oct 14, 2026), 46 buses an hour.");
    expect(f.map((x) => x.raw)).toEqual(["23,445", "244%", "46"]);
  });

  it("passes figures a tool returned, to the precision written, and percentages a tool stated", () => {
    const g = ground("23,445 riders; 17,167 of 18,432 can move (93%); the G at 244%; 33.3 min.", [
      result("Displaced 23,445.2 riders; the G at 244%", { required: 18432.1, absorbed: 17166.7, minutes: 33.3 }),
    ]);
    expect(g).toEqual({ checked: 6, unmatched: [] });
  });

  it("flags a figure no tool returned, and a percentage that is only a count elsewhere", () => {
    const g = ground("The shuttle moves 5,000 riders an hour, 61% of the gap; 93% can move.", [result("Displaced 23,445 riders; 93 stations", { required: 18432 })]);
    expect(g.unmatched).toEqual(["5,000", "61%", "93%"]);
  });

  it("does not let station ids or segment ids vouch for a figure", () => {
    const g = ground("618 riders an hour.", [result("Closed segment", { from: "618", eids: [618], stationId: 618 })]);
    expect(g.unmatched).toEqual(["618"]);
  });

  it("rejects almost every random figure against a real run's results, while passing its brief", () => {
    const { results, brief } = recordedRun();
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647);
    const randoms = Array.from({ length: 400 }, () => 100 + (next() % 29_900));
    const passed = randoms.filter((n) => ground(`${n.toLocaleString("en-US")} riders`, results).unmatched.length === 0).length;
    const pcts = Array.from({ length: 300 }, () => 1 + (next() % 300));
    const pctPassed = pcts.filter((n) => ground(`${n}%`, results).unmatched.length === 0).length;
    expect(passed / randoms.length).toBeLessThan(0.05);
    expect(pctPassed / pcts.length).toBeLessThan(0.05);
    const g = ground(brief, results);
    expect(g.checked).toBeGreaterThan(15);
  });
});
