import { describe, expect, it } from "vitest";
import { figuresIn, ground } from "./grounding";
import type { ToolResult } from "../graph/tools/types";

const result = (summary: string, data: unknown): ToolResult => ({ tool: "measure_capacity", outcome: "answered", summary, data, trace: [] });

describe("checking a brief against the tool results", () => {
  it("picks out the figures worth checking, not stops, legs or dates", () => {
    const f = figuresIn("Closing the L hits 23,445 riders an hour, 4 stops out; the G runs at 244% (since Oct 14, 2026).");
    expect(f.map((x) => x.raw)).toEqual(["23,445", "244%"]);
  });

  it("passes figures a tool returned, rounded or as a share of two of them", () => {
    const g = ground("23,445 riders; 17,167 of 18,432 can move (93%); the G at 244%.", [
      result("Displaced 23,445.2 riders", { required: 18432.1, absorbed: 17166.7, overloaded: [{ pct: 244 }] }),
    ]);
    expect(g).toEqual({ checked: 5, unmatched: [] });
  });

  it("flags a figure no tool returned", () => {
    const g = ground("The shuttle moves 5,000 riders an hour, 61% of the gap.", [result("Displaced 23,445 riders", { required: 18432 })]);
    expect(g.unmatched).toEqual(["5,000", "61%"]);
  });
});
