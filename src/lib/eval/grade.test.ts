import { describe, expect, it } from "vitest";
import { finalAnswer, firstNumber, grade } from "./grade";

describe("eval grading", () => {
  it("reads the last Answer line", () => {
    expect(finalAnswer("Thinking...\nAnswer: 12\nmore\nAnswer: 23,445 riders")).toBe("23,445 riders");
    expect(finalAnswer("just text")).toBe("just text");
  });

  it("parses numbers with thousands separators", () => {
    expect(firstNumber("about 23,445 riders an hour")).toBe(23445);
    expect(firstNumber("79%")).toBe(79);
    expect(firstNumber("none")).toBeNull();
  });

  it("accepts numbers within tolerance and rejects the rest", () => {
    const e = { kind: "number" as const, value: 23445, tolerance: 0.03 };
    expect(grade("Answer: 23,445", e)).toBe(true);
    expect(grade("Answer: about 23,900 riders an hour", e)).toBe(true);
    expect(grade("Answer: 30,000", e)).toBe(false);
    expect(grade("Answer: I don't know", e)).toBe(false);
  });

  it("grades yes/no, names and declines", () => {
    expect(grade("Answer: No, 1,266 cannot move.", { kind: "yesno", value: "no" })).toBe(true);
    expect(grade("Answer: yes", { kind: "yesno", value: "no" })).toBe(false);
    expect(grade("Answer: 1 Av", { kind: "contains", any: ["1 Av"] })).toBe(true);
    expect(grade("Answer: unknown: Hogwarts Express is not in the graph", { kind: "decline" })).toBe(true);
    expect(grade("Answer: about 4,000 riders", { kind: "decline" })).toBe(false);
  });
});
