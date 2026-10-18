import { describe, expect, it } from "vitest";
import { concernsIncident, findingId, shuttleShare, type RememberedIncident } from "./memory";

const lClosure = { routes: ["L"], stretch: ["120", "119", "118", "602", "601", "618"] };

describe("concernsIncident", () => {
  it("links a finding that names a closed route or a station in the closed stretch", () => {
    expect(concernsIncident({ routes: ["G", "L"], stations: ["629"] }, lClosure)).toBe(true);
    expect(concernsIncident({ stations: ["120", "101"] }, lClosure)).toBe(true);
    expect(concernsIncident({ routes: ["l"] }, lClosure)).toBe(true);
  });

  it("leaves a finding about other lines and stations unlinked", () => {
    expect(concernsIncident({ routes: ["A", "C"], stations: ["636", "628"] }, lClosure)).toBe(false);
    expect(concernsIncident({}, lClosure)).toBe(false);
  });

  it("does not link anything when no incident is open", () => {
    expect(concernsIncident({ routes: ["L"] }, null)).toBe(false);
    expect(concernsIncident({ routes: ["L"] }, null, true)).toBe(false);
  });

  it("lets the caller decide", () => {
    expect(concernsIncident({ routes: ["A"] }, lClosure, true)).toBe(true);
    expect(concernsIncident({ routes: ["L"], stations: ["120"] }, lClosure, false)).toBe(false);
  });

  it("judges a platform elevator by its station alone", () => {
    // The L platform elevator at Myrtle-Wyckoff Avs is outside the closed Canarsie Tube stretch.
    expect(concernsIncident({ routes: ["L"], stations: ["630"] }, lClosure, "stations")).toBe(false);
    expect(concernsIncident({ routes: ["L"], stations: ["120"] }, lClosure, "stations")).toBe(true);
  });
});

describe("findingId", () => {
  it("stays unique for writers in the same millisecond", () => {
    const ids = new Set(Array.from({ length: 100 }, (_, i) => findingId(1_760_000_000_000, i / 100)));
    expect(ids.size).toBe(100);
    expect(findingId(1_760_000_000_000, 0)).toMatch(/^F-[0-9A-Z]+000$/);
  });
});

describe("shuttleShare", () => {
  const incident = (id: string, shuttles: RememberedIncident["shuttles"]): RememberedIncident => ({ id, title: id, openedMs: 0, example: null, shuttles });

  it("sizes the next plan at the lowest share of plan a recalled shuttle carried", () => {
    const share = shuttleShare([
      incident("INC-A", [{ from: "Bedford Av", to: "Marcy Av", bph: 30, planned: 2100, observed: 1650 }]),
      incident("INC-B", [{ from: "Jay St", to: "Fulton St", bph: 24, planned: 1680, observed: 1560 }]),
    ]);
    expect(share?.incident).toBe("INC-A");
    expect(share?.ratio).toBeCloseTo(1650 / 2100);
  });

  it("keeps nominal sizing when shuttles carried 97% of plan or more, or carried nothing on record", () => {
    expect(shuttleShare([incident("INC-A", [{ from: "a", to: "b", bph: 10, planned: 700, observed: 690 }])])).toBeNull();
    expect(shuttleShare([incident("INC-A", [{ from: "a", to: "b", bph: 10, planned: 700, observed: 0 }])])).toBeNull();
    expect(shuttleShare([])).toBeNull();
  });
});
