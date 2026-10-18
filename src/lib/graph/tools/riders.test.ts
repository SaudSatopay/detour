import { describe, expect, it } from "vitest";
import { crowdedLines, crowdingNote, legsOf, type PathRow, type RouteAnswer, type RouteLeg } from "./riders";

const answer = (minutes: number, legs: RouteLeg[]): RouteAnswer => ({ minutes, legs, stations: [], eids: [], transfers: legs.length - 1, stepFreeOk: true, blockedBy: [] });
const ride = (route: string, peakPct?: number, from = "a", to = "b"): RouteLeg => ({ kind: "RUNS", route, from, to, stops: 3, minutes: 6, ...(peakPct ? { peakPct } : {}) });
const names = (id: string) => ({ "629": "Metropolitan Av/Lorimer St", "606": "Court Sq-23 St", "636": "Jay St-MetroTech" })[id] ?? id;

describe("crowding on a route", () => {
  it("keeps the most crowded ride per line, worst first", () => {
    expect(crowdedLines([ride("G", 180), ride("J"), ride("G", 244, "629", "606"), ride("M", 130)])).toEqual([
      { route: "G", pct: 244, from: "629", to: "606" },
      { route: "M", pct: 130, from: "a", to: "b" },
    ]);
  });

  it("says which crowded ride the chosen route avoids, and what it costs", () => {
    const fastest = answer(31, [ride("G", 244, "629", "606"), ride("A")]);
    // Riding the G the other way, below capacity, still avoids the crowded stretch.
    const pick = answer(36, [ride("G", undefined, "629", "636"), ride("A")]);
    const note = crowdingNote(pick, fastest, names);
    expect(note.avoids).toEqual([{ route: "G", pct: 244, from: "629", to: "606" }]);
    expect(note.text).toBe("Avoids the G between Metropolitan Av/Lorimer St and Court Sq-23 St, running at 244% of capacity, for about 5 more minutes.");
  });

  it("says so when no reasonable route avoids a crowded ride", () => {
    const both = answer(31, [ride("G", 244, "629", "606")]);
    expect(crowdingNote(both, both, names)).toEqual({
      avoids: [],
      text: "Rides the G between Metropolitan Av/Lorimer St and Court Sq-23 St, running at 244% of capacity: no reasonable route avoids it.",
    });
  });

  it("says nothing when no line is over capacity", () => {
    expect(crowdingNote(answer(20, [ride("A")]), answer(20, [ride("A")]))).toEqual({ avoids: [], text: "" });
  });
});

describe("legsOf crowding", () => {
  it("records a ride's most crowded segment", () => {
    const row: PathRow = {
      nodes: [{ station: "A", route: null, platform: false }, { station: "A", route: "G", platform: true }, { station: "B", route: "G", platform: true }, { station: "C", route: "G", platform: true }, { station: "C", route: null, platform: false }],
      rels: [
        { t: "BOARD", eid: null, minutes: 5 },
        { t: "RIDE", eid: 1, minutes: 2, crowd: 180 },
        { t: "RIDE", eid: 2, minutes: 2, crowd: 244 },
        { t: "ALIGHT", eid: null, minutes: 0 },
      ],
      weight: 21,
    };
    expect(legsOf(row)).toEqual([{ kind: "RUNS", route: "G", from: "A", to: "C", stops: 2, minutes: 9, peakPct: 244 }]);
  });
});

const station = (id: string) => ({ station: id, route: null, platform: false });
const platform = (id: string, route: string) => ({ station: id, route, platform: true });

describe("legsOf (platform layer)", () => {
  it("turns board, ride, alight into one leg per train", () => {
    const row: PathRow = {
      nodes: [station("A"), platform("A", "M"), platform("B", "M"), platform("C", "M"), station("C"), station("D"), platform("D", "F"), platform("E", "F"), station("E")],
      rels: [
        { t: "BOARD", eid: null, minutes: 4 },
        { t: "RIDE", eid: 1, minutes: 2 },
        { t: "RIDE", eid: 2, minutes: 2 },
        { t: "ALIGHT", eid: null, minutes: 0 },
        { t: "WALK", eid: null, minutes: 5 },
        { t: "BOARD", eid: null, minutes: 6 },
        { t: "RIDE", eid: 3, minutes: 3 },
        { t: "ALIGHT", eid: null, minutes: 0 },
      ],
      weight: 22,
    };
    const legs = legsOf(row);
    expect(legs).toEqual([
      { kind: "RUNS", route: "M", from: "A", to: "C", stops: 2, minutes: 8 },
      { kind: "WALK", route: null, from: "C", to: "D", stops: 1, minutes: 5 },
      { kind: "RUNS", route: "F", from: "D", to: "E", stops: 1, minutes: 9 },
    ]);
  });

  it("keeps a shuttle bus as its own leg", () => {
    const row: PathRow = {
      nodes: [station("A"), station("B")],
      rels: [{ t: "BUS", eid: null, minutes: 7 }],
      weight: 7,
    };
    expect(legsOf(row)).toEqual([{ kind: "BUS", route: null, from: "A", to: "B", stops: 1, minutes: 7 }]);
  });
});
