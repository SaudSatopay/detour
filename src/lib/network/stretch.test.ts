import { describe, expect, it } from "vitest";
import { stretchBetween } from "./stretch";
import type { Network } from "./types";

const network = {
  stations: [],
  segments: [],
  walks: [],
  routes: [
    { id: "L", short: "L", longName: "", color: "", textColor: "", trainCapacity: 1, sort: 1, patterns: [["618", "601", "602", "118", "119", "120", "629"], ["629", "120", "119", "118", "602", "601", "618"]] },
    { id: "4", short: "4", longName: "", color: "", textColor: "", trainCapacity: 1, sort: 2, patterns: [["610", "602", "622"]] },
  ],
} as unknown as Network;

describe("stretchBetween", () => {
  it("returns the stations between two stops in travel order", () => {
    expect(stretchBetween(network, ["L"], "120", "618")).toEqual(["120", "119", "118", "602", "601", "618"]);
  });

  it("works across several closed routes", () => {
    expect(stretchBetween(network, ["5", "4"], "610", "622")).toEqual(["610", "602", "622"]);
  });

  it("returns null when no pattern serves both stations", () => {
    expect(stretchBetween(network, ["4"], "610", "120")).toBeNull();
    expect(stretchBetween(network, ["L"], "120", "120")).toBeNull();
  });
});
