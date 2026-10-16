import { describe, expect, it } from "vitest";
import { legsOf, type PathRow } from "./riders";

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
