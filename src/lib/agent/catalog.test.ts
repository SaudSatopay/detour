import { describe, expect, it } from "vitest";
import type { ToolResult } from "../graph/tools/types";
import { clip, forClient } from "./catalog";

describe("clip", () => {
  it("leaves short text alone", () => {
    expect(clip("Close the L.", 600)).toBe("Close the L.");
  });

  it("cuts at a word boundary and ends with an ellipsis", () => {
    const text = "Since Oct 14, 2026: the elevator is out | Since Jun 12, 2026: the shuttle carried 79% | Playbook used once in both directions";
    const out = clip(text, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
    expect(text.startsWith(out.slice(0, -1))).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });
});

describe("forClient", () => {
  it("drops per-edge flow lists from capacity data but keeps the highlight the map draws", () => {
    const flow = { kind: "RUNS" as const, id: 1, from: "a", to: "b", flow: 10 };
    const r: ToolResult = {
      tool: "measure_capacity",
      outcome: "answered",
      summary: "s",
      data: { reroute: { flows: [flow], overloaded: [{ id: 1 }] }, directions: [{ flows: [flow], required: 5, unmet: 1 }] },
      trace: [],
      highlight: { flows: [flow] },
    };
    const out = forClient(r) as ToolResult<{ reroute: { flows?: unknown; overloaded: unknown[] }; directions: { flows?: unknown; required: number }[] }>;
    expect(out.data.reroute.flows).toBeUndefined();
    expect(out.data.directions[0].flows).toBeUndefined();
    expect(out.data.reroute.overloaded).toHaveLength(1);
    expect(out.data.directions[0].required).toBe(5);
    expect(out.highlight?.flows).toHaveLength(1);
  });

  it("passes other tools through untouched", () => {
    const r: ToolResult = { tool: "resolve_places", outcome: "answered", summary: "s", data: { flows: 1 }, trace: [] };
    expect(forClient(r)).toBe(r);
  });
});
