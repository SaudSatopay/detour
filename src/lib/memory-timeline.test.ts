import { describe, expect, it } from "vitest";
import { factName, layoutTimeline, TIMELINE, type TimelineFact, type TimelineIncident } from "./memory-timeline";

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-10-17T16:00:00Z");

const fact = (over: Partial<TimelineFact> & Pick<TimelineFact, "id" | "validFromMs">): TimelineFact => ({
  text: `Fact ${over.id}`,
  kind: "observation",
  validToMs: null,
  example: true,
  about: ["L", "Bedford Av"],
  agent: "Scribe",
  supersedes: null,
  ...over,
});

const FACTS: TimelineFact[] = [
  fact({ id: "F-0612-1", validFromMs: at("2026-06-12T10:30:00Z"), about: ["L", "Bedford Av", "Marcy Av"], kind: "capacity" }),
  fact({ id: "F-0903-1", validFromMs: at("2026-09-03T10:00:00Z"), about: ["C", "A", "Jay St-MetroTech", "Fulton St"] }),
  fact({ id: "F-ELEV-1", validFromMs: at("2026-10-02T06:00:00Z"), validToMs: at("2026-10-09T15:20:00Z"), about: ["L", "14 St-Union Sq"] }),
  fact({ id: "F-ELEV-2", validFromMs: at("2026-10-14T05:45:00Z"), validToMs: at("2026-10-16T14:00:00Z"), about: ["L", "Myrtle-Wyckoff Avs"] }),
  fact({ id: "F-FIXED", validFromMs: at("2026-10-16T14:00:00Z"), about: ["L", "Myrtle-Wyckoff Avs"], supersedes: "F-ELEV-2" }),
  fact({ id: "F-0612-2", validFromMs: at("2026-06-12T10:30:00Z"), about: ["G", "Metropolitan Av/Lorimer St"] }),
];

const INCIDENTS: TimelineIncident[] = [
  { id: "INC-0612", title: "Smoke condition, Canarsie Tube", openedMs: at("2026-06-12T07:58:00Z") },
  { id: "INC-0903", title: "Water condition, Cranberry Street Tunnel", openedMs: at("2026-09-03T06:40:00Z") },
];

const layout = (width = 1000) => layoutTimeline({ findings: FACTS, incidents: INCIDENTS, episodes: [], nowMs: NOW, width });
const row = (l: ReturnType<typeof layout>, id: string) => {
  const r = l.rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

describe("time scale", () => {
  it("maps the range from the left pad to Today, the last three weeks drawn wider", () => {
    const l = layout(1000);
    expect(l.width).toBe(1000);
    expect(l.x(l.startMs)).toBe(TIMELINE.padL);
    expect(l.x(NOW)).toBe(1000 - TIMELINE.padR);
    expect(l.today.x).toBe(1000 - TIMELINE.padR);
    // Months of history: the recent zone starts three weeks back and takes about a third of the plot.
    expect(l.recent).not.toBeNull();
    const plot = 1000 - TIMELINE.padL - TIMELINE.padR;
    expect(l.recent!.ms).toBe(NOW - 21 * 24 * 3600 * 1000);
    expect(l.x(l.recent!.ms)).toBeCloseTo(TIMELINE.padL + plot * 0.68, 6);
    // Even and continuous on each side of the break.
    const a = l.startMs + (l.recent!.ms - l.startMs) / 2;
    expect(l.x(a)).toBeCloseTo((TIMELINE.padL + l.recent!.x) / 2, 6);
    const b = l.recent!.ms + (NOW - l.recent!.ms) / 2;
    expect(l.x(b)).toBeCloseTo((l.recent!.x + l.today.x) / 2, 6);
  });

  it("keeps an even scale when the history is short", () => {
    const recent = FACTS.filter((f) => f.validFromMs > NOW - 30 * 24 * 3600 * 1000);
    const l = layoutTimeline({ findings: recent, incidents: [], episodes: [], nowMs: NOW, width: 1000 });
    expect(l.recent).toBeNull();
    const mid = (l.startMs + NOW) / 2;
    expect(l.x(mid)).toBeCloseTo((TIMELINE.padL + 1000 - TIMELINE.padR) / 2, 6);
  });

  it("starts a little before the earliest fact or incident", () => {
    const l = layout();
    const earliest = INCIDENTS[0].openedMs;
    expect(l.startMs).toBeLessThan(earliest);
    expect(earliest - l.startMs).toBeGreaterThanOrEqual(5 * 86_400_000);
    expect(l.x(earliest)).toBeGreaterThan(TIMELINE.padL);
  });

  it("never draws narrower than the minimum width, so phones scroll instead of squashing", () => {
    expect(layout(300).width).toBe(TIMELINE.minWidth);
  });

  it("puts month ticks on the first of the month in New York time", () => {
    const l = layout();
    const july = l.ticks.find((t) => t.ms === at("2026-07-01T04:00:00Z"));
    expect(july).toBeDefined();
    expect(l.ticks.map((t) => t.label)).toContain("Jul 2026");
    expect(l.ticks.map((t) => t.label)).toContain("Aug");
    for (const t of l.ticks) expect(t.ms).toBeGreaterThanOrEqual(l.startMs);
  });
});

describe("bars", () => {
  it("runs a fact that is still true to Today and marks it open", () => {
    const l = layout();
    const r = row(l, "F-0612-1");
    expect(r.open).toBe(true);
    expect(r.x1).toBeCloseTo(l.x(at("2026-06-12T10:30:00Z")), 6);
    expect(r.x2).toBe(l.today.x);
  });

  it("ends a closed fact at its validToMs", () => {
    const l = layout();
    const r = row(l, "F-ELEV-1");
    expect(r.open).toBe(false);
    expect(r.x2).toBeCloseTo(l.x(at("2026-10-09T15:20:00Z")), 6);
    expect(r.x2).toBeLessThan(l.today.x);
  });

  it("gives every bar a hit area wide enough to tap", () => {
    for (const r of layout().rows) expect(r.hit.w).toBeGreaterThanOrEqual(24);
  });

  it("links a finding to the incident it was written during", () => {
    const l = layout();
    expect(row(l, "F-0612-1").incident?.id).toBe("INC-0612");
    expect(row(l, "F-0903-1").incident?.id).toBe("INC-0903");
    expect(row(l, "F-ELEV-1").incident).toBeNull();
  });
});

describe("rows", () => {
  it("groups facts by the routes they are about, with readable labels", () => {
    const l = layout();
    const labels = l.groups.map((g) => g.label);
    expect(labels).toEqual(["L train", "G train", "A and C trains"]);
    const lGroup = l.groups[0];
    expect(lGroup.rows).toEqual(["F-0612-1", "F-ELEV-1", "F-ELEV-2", "F-FIXED"]);
    expect(row(l, "F-0903-1").label).toBe("Jay St-MetroTech, Fulton St");
  });

  it("stacks rows without overlap, one per finding", () => {
    const l = layout();
    expect(l.rows).toHaveLength(FACTS.length);
    const tops = l.rows.map((r) => r.y).sort((a, b) => a - b);
    for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeGreaterThanOrEqual(TIMELINE.rowH);
    expect(l.bodyBottom).toBeLessThanOrEqual(l.height);
  });

  it("puts a replacement fact directly under the fact it closed", () => {
    const shuffled = [FACTS[4], ...FACTS.slice(0, 4), FACTS[5]];
    const l = layoutTimeline({ findings: shuffled, incidents: [], episodes: [], nowMs: NOW, width: 1000 });
    const ids = l.groups[0].rows;
    expect(ids.indexOf("F-FIXED")).toBe(ids.indexOf("F-ELEV-2") + 1);
  });
});

describe("supersedes links", () => {
  it("connects the closing point of the old fact to the start of its replacement", () => {
    const l = layout();
    expect(l.links).toHaveLength(1);
    const [link] = l.links;
    const old = row(l, "F-ELEV-2");
    const next = row(l, "F-FIXED");
    expect(link.from).toBe("F-ELEV-2");
    expect(link.to).toBe("F-FIXED");
    expect(link.y1).toBe(old.cy);
    expect(link.y2).toBe(next.cy);
    expect(link.x1).toBeCloseTo(old.x2, 6);
    expect(link.x2).toBeCloseTo(next.x1, 6);
    expect(link.d.startsWith(`M${link.x1.toFixed(1)} ${link.y1.toFixed(1)}`)).toBe(true);
  });

  it("bends a link to the right when the replacement starts the moment the old fact closed", () => {
    const [link] = layout().links;
    expect(link.x1).toBeCloseTo(link.x2, 6);
    expect(link.labelX).toBeGreaterThan(link.x1 + 10);
    expect(link.labelY).toBeGreaterThan(link.y1);
    expect(link.labelY).toBeLessThan(link.y2);
  });

  it("skips a link whose old fact is not in the graph", () => {
    const l = layoutTimeline({ findings: [FACTS[4]], incidents: [], episodes: [], nowMs: NOW, width: 1000 });
    expect(l.links).toEqual([]);
  });
});

describe("incidents and episodes", () => {
  it("labels incidents with a short date and name", () => {
    const l = layout();
    expect(l.incidents.map((i) => i.label)).toEqual(["Jun 12 · Canarsie Tube smoke", "Sep 3 · Cranberry Street Tunnel water"]);
  });

  it("places episode ticks at their time", () => {
    const atMs = at("2026-10-16T17:54:30Z");
    const l = layoutTimeline({ findings: FACTS, incidents: [], episodes: [{ atMs }], nowMs: NOW, width: 1000 });
    expect(l.episodes[0].x).toBeCloseTo(l.x(atMs), 6);
    expect(l.episodeLane).not.toBeNull();
  });
});

describe("accessible names", () => {
  it("reads the fact, its window and whether it is closed", () => {
    const f = FACTS[3];
    expect(factName({ ...f, text: "Elevator to the L platform at Myrtle-Wyckoff Avs out of service" })).toBe(
      "Elevator to the L platform at Myrtle-Wyckoff Avs out of service, valid Oct 14, 2026 to Oct 16, 2026, closed",
    );
    expect(factName(FACTS[0])).toBe("Fact F-0612-1, valid since Jun 12, 2026, still true");
    expect(factName({ ...FACTS[2], text: "Elevator to the L platform at 14 St-Union Sq out of service." })).toBe(
      "Elevator to the L platform at 14 St-Union Sq out of service, valid Oct 2, 2026 to Oct 9, 2026, closed",
    );
  });
});
