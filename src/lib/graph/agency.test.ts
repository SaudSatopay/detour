import { describe, expect, it } from "vitest";
import type { Alert, Outage } from "./agency-feeds";
import { planAlerts, planOutages } from "./agency";
import { sampleAssignee, sinceOf, unitIds } from "./agency-tools";
import { ORG_PEOPLE } from "./seed-org";

const outage = (id: string, upcoming = false) => ({ id, upcoming }) as Outage;
const alert = (id: string) => ({ id }) as Alert;

describe("planOutages", () => {
  it("upserts what the feed lists, resolves what it dropped, and notices what is new or came back", () => {
    const plan = planOutages(
      [
        { id: "EL1@a", status: "open" },
        { id: "EL2@b", status: "upcoming" },
        { id: "EL3@c", status: "resolved" },
        { id: "EL4@d", status: "open" },
      ],
      [outage("EL1@a"), outage("EL3@c"), outage("EL5@e", true)],
    );
    expect(plan.upsert.map((o) => [o.id, o.status])).toEqual([
      ["EL1@a", "open"],
      ["EL3@c", "open"],
      ["EL5@e", "upcoming"],
    ]);
    expect(plan.resolve).toEqual(["EL2@b", "EL4@d"]);
    expect(plan.opened).toEqual(["EL5@e"]);
    expect(plan.reopened).toEqual(["EL3@c"]);
  });
  it("changes nothing when the same capture is applied twice", () => {
    const known = [{ id: "EL1@a", status: "open" }];
    const plan = planOutages(known, [outage("EL1@a")]);
    expect(plan.resolve).toEqual([]);
    expect(plan.opened).toEqual([]);
    expect(plan.reopened).toEqual([]);
  });
  it("never resolves an outage twice", () => {
    expect(planOutages([{ id: "EL3@c", status: "resolved" }], []).resolve).toEqual([]);
  });
});

describe("planAlerts", () => {
  it("ends active alerts the feed dropped and counts new ones", () => {
    const plan = planAlerts(
      [
        { id: "a", status: "active" },
        { id: "b", status: "ended" },
        { id: "c", status: "active" },
      ],
      [alert("a"), alert("b"), alert("d")],
    );
    expect(plan.end).toEqual(["c"]);
    expect(plan.started).toEqual(["b", "d"]);
  });
});

describe("reading questions", () => {
  it("finds unit ids", () => {
    expect(unitIds("Is el382 or ES236 working? And EL290X?")).toEqual(["EL382", "ES236", "EL290X"]);
  });
  it("reads the time a question asks about, in New York time", () => {
    expect(new Date(sinceOf("What began since 2026-10-15 18:00?")!).toISOString()).toBe("2026-10-15T22:00:00.000Z");
    expect(sinceOf("in the last 3 days", 10 * 86_400_000)).toBe(7 * 86_400_000);
    expect(sinceOf("nothing here")).toBeNull();
  });
});

describe("sampleAssignee", () => {
  it("picks a person of the sample maintenance team, the same one every time", () => {
    const a = sampleAssignee("EL382@2026-10-18 15:36");
    expect(ORG_PEOPLE.filter((p) => p.team === "EE").map((p) => p.name)).toContain(a.name);
    expect(sampleAssignee("EL382@2026-10-18 15:36")).toEqual(a);
    expect(a.team).toBe("Elevator and Escalator Maintenance");
  });
});
