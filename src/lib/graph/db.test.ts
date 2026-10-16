import { describe, expect, it } from "vitest";
import { parseMetadata } from "./db";

describe("parseMetadata", () => {
  it("separates FalkorDB's internal execution time from write stats", () => {
    const { serverMs, stats } = parseMetadata([
      "Nodes created: 3",
      "Relationships created: 2",
      "Cached execution: 0",
      "Query internal execution time: 0.412 milliseconds",
    ]);
    expect(serverMs).toBeCloseTo(0.412);
    expect(stats).toEqual({ "Nodes created": 3, "Relationships created": 2, "Cached execution": 0 });
  });

  it("returns null time and empty stats for missing metadata", () => {
    expect(parseMetadata(undefined)).toEqual({ serverMs: null, stats: {} });
  });
});
