import { describe, expect, it } from "vitest";
import { isDatabaseFull } from "./tenancy";

describe("isDatabaseFull", () => {
  it("recognizes FalkorDB at its memory limit", () => {
    expect(isDatabaseFull(new Error("OOM command not allowed when used memory > 'maxmemory'."))).toBe(true);
    expect(isDatabaseFull(new Error("GRAPH.COPY failed, could not fork"))).toBe(true);
  });
  it("leaves other errors alone", () => {
    expect(isDatabaseFull(new Error("Invalid input 'X': expected MATCH"))).toBe(false);
    expect(isDatabaseFull("connect ECONNREFUSED")).toBe(false);
  });
});
