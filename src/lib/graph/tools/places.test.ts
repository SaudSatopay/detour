import { describe, expect, it } from "vitest";
import { normalizePlace } from "./places";

describe("reading a place the way people write it", () => {
  it("uses the MTA's short forms", () => {
    expect(normalizePlace("Times Square")).toBe("times sq");
    expect(normalizePlace("First Avenue")).toBe("1 av");
    expect(normalizePlace("42nd Street")).toBe("42 st");
    expect(normalizePlace("Jackson Heights-Roosevelt Avenue")).toBe("jackson hts roosevelt av");
  });

  it("knows names that share no word with the station's", () => {
    expect(normalizePlace("WTC")).toBe("world trade center");
    expect(normalizePlace("Yankee Stadium")).toBe("161 st yankee stadium");
  });

  it("leaves MTA names as they are", () => {
    expect(normalizePlace("Myrtle-Wyckoff Avs")).toBe("myrtle wyckoff avs");
    expect(normalizePlace("8 Av")).toBe("8 av");
  });
});
