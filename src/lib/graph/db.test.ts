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

describe("a dropped connection", () => {
  it("is told apart from a query error", async () => {
    const { isConnectionError } = await import("./db");
    expect(isConnectionError(new Error("connect ECONNREFUSED 10.0.0.1:6379"))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("The client is closed"), { name: "ClientClosedError" }))).toBe(true);
    expect(isConnectionError(new Error("Socket closed unexpectedly"))).toBe(true);
    expect(isConnectionError(new Error("errMsg: Invalid input 'X': expected MATCH"))).toBe(false);
    expect(isConnectionError(new Error("OOM command not allowed when used memory > 'maxmemory'."))).toBe(false);
  });

  it("is logged without the database credentials", async () => {
    const { redact } = await import("./db");
    expect(redact(new Error("connect to falkors://falkordb:s3cret@r-6jissuruar.instance-z7.example:6379 failed"))).toBe(
      "Error: connect to falkors://<credentials>@r-6jissuruar.instance-z7.example:6379 failed",
    );
  });
});
