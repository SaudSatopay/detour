import { describe, expect, it } from "vitest";
import { readTrip } from "./scripted-ask";

describe("reading a trip question without a model", () => {
  it("finds both ends in the usual phrasings", () => {
    expect(readTrip("How do I get from Bedford Av to Times Square?")).toMatchObject({ from: "Bedford Av", to: "Times Square", stepFree: false });
    expect(readTrip("I need to get to Jay St-MetroTech from Myrtle-Wyckoff Avs")).toMatchObject({ from: "Myrtle-Wyckoff Avs", to: "Jay St-MetroTech" });
    expect(readTrip("Route between Fulton St and Grand Central, step-free please")).toMatchObject({ from: "Fulton St", to: "Grand Central", stepFree: true });
  });

  it("knows remembered riders, step-free needs and lines to avoid", () => {
    expect(readTrip("Where should Aisha go now?")).toMatchObject({ riderId: "aisha" });
    expect(readTrip("Tomás uses a wheelchair, what now?")).toMatchObject({ riderId: "tomas", stepFree: true });
    expect(readTrip("from 1 Av to Court Sq avoiding the G train").avoid).toEqual(["G"]);
  });

  it("finds no trip in a question that has none", () => {
    expect(readTrip("Is the L running?")).toMatchObject({ riderId: undefined, from: undefined, to: undefined });
  });
});
