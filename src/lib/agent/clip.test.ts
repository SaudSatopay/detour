import { describe, expect, it } from "vitest";
import { clip } from "./catalog";

describe("clip", () => {
  it("leaves short text alone", () => {
    expect(clip("Close the L.", 600)).toBe("Close the L.");
  });

  it("cuts at a word boundary and ends with an ellipsis", () => {
    const text = "Since Oct 14, 2026: the elevator is out | Since Jun 12, 2026: the shuttle carried 79% | Playbook used once in both directions";
    const out = clip(text, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
    expect(text.startsWith(out.slice(0, -1))).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });
});
