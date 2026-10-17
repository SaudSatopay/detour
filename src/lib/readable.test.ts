import { describe, expect, it } from "vitest";
import { readable } from "./readable";

describe("readable summaries", () => {
  it("drops graph ids and the route echo", () => {
    expect(readable("Resolved: Bedford Av → Bedford Av [120] (L); L → route L.")).toBe("Resolved: Bedford Av → Bedford Av (L); the L line.");
  });

  it("says once and times instead of time(s)", () => {
    expect(readable('Playbook "L shuttle" used 1 time(s): close, bus.')).toBe('Playbook "L shuttle" used once: close, bus.');
    expect(readable("used 3 time(s)")).toBe("used 3 times");
  });

  it("leaves ordinary text alone", () => {
    expect(readable("23,445 riders an hour; 14 St/8 Av → 14 St/6 Av")).toBe("23,445 riders an hour; 14 St/8 Av → 14 St/6 Av");
  });
});
