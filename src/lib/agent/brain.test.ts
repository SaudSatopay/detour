import { describe as group, expect, it } from "vitest";
import type { BrainSource } from "../brain/types";
import { routesIn, searchTerms } from "../graph/tools/brain";
import { BRAIN_SUGGESTIONS, FINDING_SOURCES, ORG_DECISIONS, ORG_DOCUMENTS, ORG_MESSAGES, ORG_PEOPLE, ORG_TEAMS, ORG_TICKETS } from "../graph/seed-org";
import { SEED_FINDINGS, SEED_INCIDENTS, SEED_PLAYBOOKS } from "../graph/seed-memory";
import { describe, listJoin, planQuestion, SourceBook } from "./brain";

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
    expect(BRAIN_SUGGESTIONS.map((q) => planQuestion(q).tool)).toEqual(["who_owns", "trace_decision", "who_owns", "whats_changed", "search_knowledge"]);
  });
  it("reads the window from 'last N days'", () => {
    expect(planQuestion("What changed in the last 30 days?")).toEqual({ tool: "whats_changed", input: { days: 30 } });
    expect(planQuestion("Anything new recently?")).toEqual({ tool: "whats_changed", input: { days: 7 } });
  });
  it("treats why-questions as decision traces", () => {
    expect(planQuestion("Why did we add two G trains?").tool).toBe("trace_decision");
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
