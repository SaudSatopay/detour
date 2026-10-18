import { describe, expect, it } from "vitest";
import { crowdFactor, crowdingOf } from "./incident";

describe("crowdFactor", () => {
  it("leaves rides within capacity at their minutes", () => {
    expect(crowdFactor(40)).toBe(1);
    expect(crowdFactor(100)).toBe(1);
    expect(crowdFactor(Number.NaN)).toBe(1);
  });

  it("weighs a ride up with how far it is over capacity, and caps it", () => {
    expect(crowdFactor(200)).toBeCloseTo(2.5);
    expect(crowdFactor(244)).toBeCloseTo(3.16);
    expect(crowdFactor(1000)).toBe(4);
  });
});

describe("crowdingOf", () => {
  it("keeps rail segments over capacity and drops shuttle legs", () => {
    const overloaded = [
      { kind: "RUNS", id: 812, pct: 244 },
      { kind: "BUS", id: 0, pct: 130 },
      { kind: "RUNS", id: 813, pct: 100 },
    ];
    expect(crowdingOf({ overloaded })).toEqual([{ eid: 812, pct: 244 }]);
  });
});
