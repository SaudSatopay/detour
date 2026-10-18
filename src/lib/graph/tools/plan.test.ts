import { describe, expect, it } from "vitest";
import { appliedPlaybooks, learnedShuttles, parseCrowding, reviseSteps, sizingLesson, type PlanLeg } from "./plan";

const leg = (from: string, to: string, busesPerHour: number): PlanLeg => ({ from, to, busesPerHour, capacity: busesPerHour * 70, minutes: 9, meters: 1600 });

describe("learnedShuttles", () => {
  const legs = [leg("120", "101", 30), leg("619", "601", 20)];

  it("pairs each count with its published leg, in either direction", () => {
    const learned = learnedShuttles(legs, [
      { from: "101", to: "120", riders: 1650 },
      { from: "619", to: "601", riders: 1302.4 },
    ]);
    expect(learned).toEqual([
      { from: "120", to: "101", busesPerHour: 30, planned: 2100, observed: 1650, ratio: 1650 / 2100 },
      { from: "619", to: "601", busesPerHour: 20, planned: 1400, observed: 1302, ratio: 1302 / 1400 },
    ]);
  });

  it("leaves out legs nobody counted, unknown legs and impossible counts", () => {
    expect(learnedShuttles(legs, [])).toEqual([]);
    expect(learnedShuttles(legs, [{ from: "120", to: "602", riders: 900 }])).toEqual([]);
    expect(learnedShuttles(legs, [{ from: "120", to: "101", riders: 0 }])).toEqual([]);
    expect(learnedShuttles(legs, [{ from: "120", to: "101", riders: Number.NaN }])).toEqual([]);
  });
});

describe("appliedPlaybooks", () => {
  const tube = { id: "PB-L-TUBE", routes: ["L"], stations: ["120", "119", "118", "602", "601", "618"] };
  const generic = { id: "PB-A", routes: ["A", "C"], stations: null };

  it("applies a playbook whose stretch the closure overlaps", () => {
    expect(appliedPlaybooks([tube, generic], { routes: ["L"], stretch: ["119", "118", "602"] })).toEqual([tube]);
  });

  it("does not apply the Canarsie Tube playbook to an L closure in Canarsie", () => {
    expect(appliedPlaybooks([tube], { routes: ["L"], stretch: ["135", "136", "137", "138"] })).toEqual([]);
  });

  it("applies a playbook without a stretch to any closure on its routes", () => {
    expect(appliedPlaybooks([tube, generic], { routes: ["C"], stretch: ["173"] })).toEqual([generic]);
  });
});

describe("reviseSteps", () => {
  it("replaces the bus-sizing step and keeps the others", () => {
    const steps = ["Close the L.", "Measure the J/M/Z.", "Bridge Bedford Av to Marcy Av with buses.", "Add two G trains an hour."];
    expect(reviseSteps(steps, "Size at 79%.")).toEqual(["Close the L.", "Measure the J/M/Z.", "Size at 79%.", "Add two G trains an hour."]);
  });

  it("adds the lesson when no step is about buses", () => {
    expect(reviseSteps(["Close the 7."], "Size at 85%.")).toEqual(["Close the 7.", "Size at 85%."]);
  });
});

describe("sizingLesson", () => {
  const names = (id: string) => ({ "120": "Bedford Av", "101": "Marcy Av" })[id] ?? id;
  const at = Date.parse("2026-10-19T12:00:00Z");
  const learned = learnedShuttles([leg("120", "101", 30), leg("619", "601", 20)], [
    { from: "120", to: "101", riders: 1650 },
    { from: "619", to: "601", riders: 1380 },
  ]);

  it("names the shuttle that fell furthest short and the share the next plan sizes at", () => {
    const lesson = sizingLesson(learned, names, "INC-TEST", at, { ratio: 1650 / 2100, incident: "INC-TEST" });
    expect(lesson).toBe(
      "Bridge with buses sized at 79% of nominal capacity: on Oct 19, 2026 (INC-TEST) the Bedford Av ↔ Marcy Av shuttle carried 1,650 of 2,100 planned riders an hour, 79% of plan.",
    );
  });

  it("agrees with the controller when an earlier incident holds the lowest share", () => {
    const lesson = sizingLesson(learned, names, "INC-TEST", at, { ratio: 0.72, incident: "INC-0612" });
    expect(lesson).toMatch(/^Bridge with buses sized at 72% of nominal capacity, the lowest share on record for these lines \(INC-0612\); on Oct 19, 2026/);
  });

  it("keeps nominal capacity when the shuttles carried their plan, and says nothing without counts", () => {
    expect(sizingLesson(learned, names, "INC-TEST", at, null)).toMatch(/^Bridge with buses at nominal capacity: /);
    expect(sizingLesson([], names, "INC-TEST", at, null)).toBeNull();
  });
});

describe("parseCrowding", () => {
  it("reads what a simulated plan stored, and nothing else", () => {
    expect(parseCrowding('[{"eid":812,"pct":244}]')).toEqual([{ eid: 812, pct: 244 }]);
    expect(parseCrowding("[]")).toEqual([]);
    expect(parseCrowding(null)).toBeNull();
    expect(parseCrowding("not json")).toBeNull();
    expect(parseCrowding('[{"eid":"x"}]')).toEqual([]);
  });
});
