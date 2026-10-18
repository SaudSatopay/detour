import { describe as group, expect, it } from "vitest";
import type { BrainSource } from "../brain/types";
import { routesIn, searchTerms } from "../graph/tools/brain";
import { BRAIN_SUGGESTIONS, FINDING_SOURCES, ORG_DECISIONS, ORG_DOCUMENTS, ORG_MESSAGES, ORG_PEOPLE, ORG_TEAMS, ORG_TICKETS } from "../graph/seed-org";
import { SEED_FINDINGS, SEED_INCIDENTS, SEED_PLAYBOOKS } from "../graph/seed-memory";
import { describe, entityOf, listJoin, planQuestion, resolveFollowUp, SourceBook } from "./brain";

const source = (over: Partial<BrainSource>): BrainSource => ({
  kind: "document",
  id: "DOC-AAR-0612",
  title: "After-action report",
  by: "Renee Alvarez",
  team: "Rail Control Center",
  atMs: 0,
  status: null,
  snippet: null,
  about: [],
  ...over,
});

group("planQuestion", () => {
  it("sends each suggested question to the tool that answers it", () => {
    expect(BRAIN_SUGGESTIONS.map((q) => planQuestion(q).tool)).toEqual(["who_owns", "trace_decision", "line_outages", "equipment_status", "project_trace", "whats_changed"]);
  });
  it("sends questions about the MTA's records to the agency graph's tools", () => {
    const now = Date.UTC(2026, 9, 18);
    expect(planQuestion("Is elevator EL382 in service right now?").tool).toBe("equipment_status");
    expect(planQuestion("Who maintains escalator ES236?").tool).toBe("equipment_status");
    expect(planQuestion("Is the elevator at Prospect Park working?").tool).toBe("equipment_status");
    expect(planQuestion("Which subway lines does MTA alert lmm:alert:272420 affect?").tool).toBe("alerts_for");
    expect(planQuestion("Any alerts on the Q?").tool).toBe("alerts_for");
    expect(planQuestion("How many updates did MTA subway alert event 262722 have?").tool).toBe("notice_chain");
    expect(planQuestion("What stage is MTA capital project 8356 in?").tool).toBe("project_trace");
    expect(planQuestion("How many rider complaints were filed for 1 Av in 2026 Q1?").tool).toBe("complaints_at");
    expect(planQuestion("Which elevator and escalator outages began since 2026-10-10 18:00?", now)).toEqual({ tool: "agency_changes", input: { sinceMs: Date.UTC(2026, 9, 10, 22) } });
    expect(planQuestion("What elevator outages changed in the last 2 days?", now)).toEqual({ tool: "agency_changes", input: { sinceMs: now - 2 * 86_400_000 } });
    expect(planQuestion("Why was DEC-0616-SIZE decided?").tool).toBe("trace_decision");
  });
  it("reads the window from 'last N days'", () => {
    expect(planQuestion("What changed in the last 30 days?")).toEqual({ tool: "whats_changed", input: { days: 30 } });
    expect(planQuestion("Anything new recently?")).toEqual({ tool: "whats_changed", input: { days: 7 } });
  });
  it("treats why-questions as decision traces", () => {
    expect(planQuestion("Why did we add two G trains?").tool).toBe("trace_decision");
  });
});

group("follow-up questions", () => {
  const prev = { cites: ["EL382@2026-10-18 15:36", "ASSET-EL382", "ALT-EL382", "DEC-1014-SF", "CP-8356", "lmm:alert:9"], stations: [{ id: "33", name: "Prospect Park" }] };
  it("names what a cited id is about", () => {
    expect(entityOf("EL382@2026-10-18 15:36")).toEqual({ kind: "unit", text: "EL382" });
    expect(entityOf("ALT-ES236")).toEqual({ kind: "unit", text: "ES236" });
    expect(entityOf("CP-8356-2-1")).toEqual({ kind: "project", text: "project 8356" });
    expect(entityOf("EV-262722")).toEqual({ kind: "event", text: "event 262722" });
    expect(entityOf("MSG-0612-1")).toBeNull();
  });
  it("reads 'it' as the unit the previous answer cited", () => {
    expect(resolveFollowUp("When will it be back?", prev)).toEqual({ question: "When will it be back? (EL382)", entity: "EL382", label: "EL382" });
    expect(planQuestion(resolveFollowUp("Who maintains it?", prev)!.question).tool).toBe("equipment_status");
  });
  it("lets the noun pick the kind: that decision, the project, that alert", () => {
    expect(resolveFollowUp("Who made that decision?", prev)?.entity).toBe("DEC-1014-SF");
    expect(resolveFollowUp("What stage is that project in?", prev)?.entity).toBe("project 8356");
    expect(resolveFollowUp("Which lines does that alert affect?", prev)?.entity).toBe("lmm:alert:9");
  });
  it("reads 'there' as the station the previous question named", () => {
    expect(resolveFollowUp("Any alerts there?", prev)).toEqual({ question: "Any alerts there? (at Prospect Park)", entity: "33", label: "Prospect Park" });
  });
  it("leaves a question alone when it names its own subject, refers to nothing, or has no previous turn", () => {
    expect(resolveFollowUp("Is EL293 working?", prev)).toBeNull();
    expect(resolveFollowUp("Which stations on the A have an elevator out of service?", prev, true)).toBeNull();
    expect(resolveFollowUp("Is there an elevator outage at 1 Av?", prev, true)).toBeNull();
    expect(resolveFollowUp("Which stations have elevators that are out?", prev)).toBeNull();
    expect(resolveFollowUp("When will it be back?", null)).toBeNull();
  });
});

group("searchTerms", () => {
  it("drops stop words and stems plurals", () => {
    expect(searchTerms("Why do L tube bus bridges get 27% more buses?")).toEqual(["tube", "bus", "bridge", "27"]);
  });
  it("keeps place words", () => {
    expect(searchTerms("Who owns the Myrtle-Wyckoff elevator outage?")).toEqual(["myrtle", "wyckoff", "elevator", "outage"]);
  });
});

group("routesIn", () => {
  const known = ["A", "C", "G", "L", "M", "4", "SI"];
  it("finds lines written as lines", () => {
    expect(routesIn("Who knows the most about the G at Metropolitan Av?", known)).toEqual(["G"]);
    expect(routesIn("Who owns the L train?", known)).toEqual(["L"]);
    expect(routesIn("the 4 line and the A", known)).toEqual(["4", "A"]);
  });
  it("ignores capitalized words and a sentence-initial A", () => {
    expect(routesIn("A question about Myrtle-Wyckoff", known)).toEqual([]);
  });
});

group("SourceBook", () => {
  it("numbers sources once, in first-seen order, and cites them", () => {
    const book = new SourceBook();
    expect(book.number(source({ id: "EE-1207", kind: "ticket" }))).toBe(1);
    expect(book.number(source({ id: "DOC-AAR-0612" }))).toBe(2);
    expect(book.number(source({ id: "EE-1207", kind: "ticket" }))).toBe(1);
    expect(book.cite("DOC-AAR-0612", "EE-1207", "missing")).toBe("[2][1]");
  });
});

group("wording", () => {
  it("describes sources the way a person would", () => {
    expect(describe(source({}))).toBe("Renee Alvarez's after-action report");
    expect(describe(source({ kind: "ticket", id: "EE-1207" }))).toBe("ticket EE-1207");
    expect(describe(source({ kind: "message", id: "MSG-0612-3", by: "Tunde Okafor" }))).toBe("Tunde Okafor's chat message");
  });
  it("joins lists with commas and a final and", () => {
    expect(listJoin(["a"])).toBe("a");
    expect(listJoin(["a", "b"])).toBe("a and b");
    expect(listJoin(["a", "b", "c"])).toBe("a, b and c");
  });
});

group("the org sample data", () => {
  const people = new Set(ORG_PEOPLE.map((p) => p.id));
  const known = new Set([
    ...ORG_DOCUMENTS.map((d) => d.id),
    ...ORG_TICKETS.map((t) => t.id),
    ...ORG_MESSAGES.map((m) => m.id),
    ...ORG_DECISIONS.map((d) => d.id),
    ...SEED_FINDINGS.map((f) => f.id),
    ...SEED_PLAYBOOKS.map((p) => p.id),
  ]);
  it("has unique ids", () => {
    const ids = [...ORG_DOCUMENTS, ...ORG_TICKETS, ...ORG_MESSAGES, ...ORG_DECISIONS, ...ORG_PEOPLE, ...ORG_TEAMS].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("names only people and teams that exist", () => {
    const teams = new Set(ORG_TEAMS.map((t) => t.id));
    expect(ORG_PEOPLE.every((p) => teams.has(p.team))).toBe(true);
    const named = [...ORG_DOCUMENTS.map((d) => d.author), ...ORG_TICKETS.flatMap((t) => [t.filedBy, t.assignedTo]), ...ORG_MESSAGES.map((m) => m.author), ...ORG_DECISIONS.map((d) => d.decidedBy)];
    expect(named.filter((id) => !people.has(id))).toEqual([]);
  });
  it("traces every decision and finding to records that exist", () => {
    expect(ORG_DECISIONS.flatMap((d) => [...d.basedOn, ...d.changed]).filter((id) => !known.has(id))).toEqual([]);
    expect(Object.values(FINDING_SOURCES).flat().filter((id) => !known.has(id))).toEqual([]);
    expect(Object.keys(FINDING_SOURCES).filter((id) => !known.has(id))).toEqual([]);
    expect(ORG_DECISIONS.filter((d) => d.until).every((d) => ORG_TICKETS.some((t) => t.id === d.until))).toBe(true);
  });
  it("mentions only seeded incidents and playbooks", () => {
    const incidents = new Set(SEED_INCIDENTS.map((i) => i.id));
    const mentioned = [...ORG_DOCUMENTS, ...ORG_TICKETS, ...ORG_MESSAGES, ...ORG_DECISIONS].flatMap((x) => x.mentions.incidents ?? []);
    expect(mentioned.filter((id) => !incidents.has(id))).toEqual([]);
    expect(ORG_TEAMS.flatMap((t) => t.playbooks).every((id) => SEED_PLAYBOOKS.some((p) => p.id === id))).toBe(true);
  });
});
