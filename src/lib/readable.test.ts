import { describe, expect, it } from "vitest";
import { readable } from "./readable";

describe("readable summaries", () => {
  it("says a resolved name once, drops graph ids and names the line", () => {
    expect(readable("Resolved: Bedford Av → Bedford Av (L) [120]; 14 St/8 Av → 14 St/8 Av (A,C,E,L) [618]; L → route L.")).toBe(
      "Found Bedford Av (L), 14 St/8 Av (A, C, E, L) and the L line.",
    );
  });

  it("keeps the arrow when the station's name differs from the one asked for", () => {
    expect(readable("Resolved: Grand Central → Grand Central-42 St (4,5,6,7,S) [610]; 4 → route 4; 5 → route 5. Ambiguous: Canal St; pick by route.")).toBe(
      "Found Grand Central → Grand Central-42 St (4, 5, 6, 7, S), the 4 line and the 5 line. Ambiguous: Canal St; pick by route.",
    );
  });

  it("says once and times instead of time(s)", () => {
    expect(readable('Playbook "L shuttle" used 1 time(s): close, bus.')).toBe('Playbook "L shuttle" used once: close, bus.');
    expect(readable("used 3 time(s)")).toBe("used 3 times");
  });

  it("leaves ordinary text alone", () => {
    expect(readable("23,445 riders an hour; 14 St/8 Av → 14 St/6 Av")).toBe("23,445 riders an hour; 14 St/8 Av → 14 St/6 Av");
    expect(readable("Aisha: about 33 min, 0 transfers, step-free: M Myrtle-Wyckoff Avs → 14 St/6 Av (11 stops).")).toBe(
      "Aisha: about 33 min, 0 transfers, step-free: M Myrtle-Wyckoff Avs → 14 St/6 Av (11 stops).",
    );
  });
});
