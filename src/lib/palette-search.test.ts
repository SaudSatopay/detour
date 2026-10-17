import { describe, expect, it } from "vitest";
import { paletteItems } from "./palette";
import { fold, searchPalette } from "./palette-search";

const items = paletteItems();

describe("the command palette", () => {
  it("offers every closure, every remembered rider, every page, the story and the proof", () => {
    const groups = new Set(items.map((i) => i.group));
    expect([...groups].sort()).toEqual(["Closures", "Pages", "Proof", "Riders", "Story"]);
    expect(items.filter((i) => i.group === "Closures").map((i) => i.href)).toContain("/control?scenario=l-canarsie&run=1");
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("ignores accents and case", () => {
    expect(fold("Tomás")).toBe("tomas");
    expect(searchPalette(items, "TOMAS")[0].href).toBe("/riders?rider=tomas");
  });

  it("matches every word, and puts a label that starts with the query first", () => {
    expect(searchPalette(items, "canarsie")[0].href).toBe("/control?scenario=l-canarsie&run=1");
    expect(searchPalette(items, "memory")[0].label).toBe("Memory");
    expect(searchPalette(items, "max flow").map((i) => i.id)).toContain("story-carry");
    expect(searchPalette(items, "no such place")).toEqual([]);
  });

  it("lists everything when nothing is typed", () => {
    expect(searchPalette(items, "  ")).toHaveLength(items.length);
  });
});
