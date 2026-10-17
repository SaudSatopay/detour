import { describe, expect, it } from "vitest";
import story from "../../../public/map/story-l-canarsie.json";
import { CHAPTERS, focusFor, mapLabelFor, overlayFor, storyFocus, worstOverload, type Story } from "./story";

const s = story as unknown as Story;

describe("the L closure story", () => {
  it("comes from one recorded run whose numbers agree with each other", () => {
    expect(s.impact.total).toBe(23445);
    // Each total is rounded on its own, so the difference may be off by one rider.
    expect(Math.abs(s.maxFlow.required - s.maxFlow.absorbed - s.maxFlow.unmet)).toBeLessThanOrEqual(1);
    expect(s.plan.before.absorbed).toBe(s.maxFlow.absorbed);
    expect(s.plan.after.stranded).toBeLessThan(s.plan.before.stranded);
    expect(s.impact.byDepth.map((d) => d.riders)).toEqual([...s.impact.byDepth.map((d) => d.riders)].sort((a, b) => a - b));
  });

  it("opens in three beats: the network, the closure, then the flow", () => {
    expect(overlayFor(s, "hero", 0)).toEqual({});
    expect(overlayFor(s, "hero", 1)).toEqual({ closedEids: s.closedEids });
    expect(overlayFor(s, "hero", 2).flows).toBe(s.reroute.flows);
  });

  it("keeps the closure on the map in every chapter after the opening", () => {
    for (const chapter of CHAPTERS.slice(1)) expect(overlayFor(s, chapter).closedEids).toBe(s.closedEids);
  });

  it("points at the worst overload, the stranded station and the shuttle's ends", () => {
    const worst = worstOverload(s);
    expect(overlayFor(s, "where").marks).toEqual([{ id: worst.from, label: `G at ${worst.pct}%`, tone: "crit" }]);
    expect(overlayFor(s, "cut").marks?.[0]).toMatchObject({ id: s.maxFlow.strandedAt[0].id, tone: "crit" });
    expect(overlayFor(s, "fix").marks?.map((m) => m.id)).toEqual(s.plan.shuttles.flatMap((x) => [x.from, x.to]));
  });

  it("frames each chapter on its own evidence, close up for the shuttle and the rider", () => {
    const fix = focusFor(s, "fix");
    for (const sh of s.plan.shuttles) expect(fix).toEqual(expect.arrayContaining([sh.from, sh.to]));
    expect(fix.length).toBeLessThan(storyFocus(s).length);
    expect(focusFor(s, "riders")).toEqual(s.riders.featured.path);
    expect(focusFor(s, "cut")).toContain(s.maxFlow.strandedAt[0].id);
    expect(focusFor(s, "where")).toEqual(expect.arrayContaining(s.reroute.overloaded.map((o) => o.from)));
    for (const chapter of CHAPTERS) expect(new Set(focusFor(s, chapter)).size).toBe(focusFor(s, chapter).length);
  });

  it("frames every station a chapter draws on, and names each map state in words", () => {
    const focus = new Set(storyFocus(s));
    for (const id of [...s.incident.stretch, ...s.riders.featured.path]) expect(focus.has(id)).toBe(true);
    for (const chapter of CHAPTERS) expect(mapLabelFor(s, chapter)).toMatch(/^Map of /);
  });
});
