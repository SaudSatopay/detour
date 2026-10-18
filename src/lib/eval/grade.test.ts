import { describe, expect, it } from "vitest";
import { declines, finalAnswer, firstNumber, grade, linesIn } from "./grade";

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

  it("holds counts to an exact value when asked, and reads none as zero", () => {
    const transfers = { kind: "number" as const, value: 1, tolerance: 0, abs: 0 };
    expect(grade("Answer: 1 transfer", transfers)).toBe(true);
    expect(grade("Answer: 2", transfers)).toBe(false);
    expect(grade("Answer: 0", transfers)).toBe(false);
    const zero = { kind: "number" as const, value: 0, tolerance: 0.05 };
    expect(grade("Answer: none, every rider can move", zero)).toBe(true);
    expect(grade("Answer: no transfers, it is direct", { kind: "number", value: 0, tolerance: 0, abs: 0 })).toBe(true);
  });

  it("grades yes/no, names and declines", () => {
    expect(grade("Answer: No, 1,266 cannot move.", { kind: "yesno", value: "no" })).toBe(true);
    expect(grade("Answer: yes", { kind: "yesno", value: "no" })).toBe(false);
    expect(grade("Answer: 1 Av", { kind: "contains", any: ["1 Av"] })).toBe(true);
    expect(grade("Answer: unknown: Hogwarts Express is not in the graph", { kind: "decline" })).toBe(true);
    expect(grade("Answer: The G does not serve Times Sq", { kind: "decline" })).toBe(true);
    expect(grade("Answer: No open path connects them", { kind: "decline" })).toBe(true);
    expect(grade("Answer: about 4,000 riders", { kind: "decline" })).toBe(false);
    expect(declines("Answer: 23,445")).toBe(false);
    expect(declines("Answer: unknown")).toBe(true);
  });

  it("grades dates in the ways people write them", () => {
    const e = { kind: "date" as const, iso: "2026-10-14" };
    for (const a of ["Oct 14, 2026", "October 14", "14 October 2026", "10/14/2026", "2026-10-14", "since Oct. 14th"]) expect(grade(`Answer: ${a}`, e)).toBe(true);
    for (const a of ["Oct 4", "October 15", "11/14", "2026-10-41"]) expect(grade(`Answer: ${a}`, e)).toBe(false);
  });

  it("grades a list of lines as a set", () => {
    const universe = ["A", "C", "E", "G", "L", "1", "2", "3", "4", "5", "6"];
    const e = { kind: "set" as const, items: ["A", "C", "G"], universe };
    expect(grade("Answer: A, C and G", e)).toBe(true);
    expect(grade("Answer: the G, A, C trains (3 lines)", e)).toBe(true);
    expect(grade("Answer: A, C", e)).toBe(false);
    expect(grade("Answer: A, C, E, G", e)).toBe(false);
    expect([...linesIn("a train and the L", universe)]).toEqual(["L"]);
  });
});
