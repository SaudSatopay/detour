import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { BrainAnswer, BrainSource, BrainStep } from "../brain/types";
import {
  agencyChanges,
  agencySearch,
  alertsFor,
  ALERT_ID,
  complaintsAt,
  equipmentStatus,
  lineOutages,
  noticeChain,
  projectTrace,
  sinceOf,
  unitIds,
  type AgencyChangesData,
  type AgencyOptions,
  type AgencySearchData,
  type AlertsData,
  type ChainData,
  type ComplaintsData,
  type EquipmentData,
  type LineOutagesData,
  type ProjectData,
  type UnitFacts,
} from "../graph/agency-tools";
import { Tracer } from "../graph/trace";
import {
  maintainerList,
  searchKnowledge,
  traceDecision,
  whatsChanged,
  whoOwns,
  type ChangesData,
  type OwnsData,
  type SearchData,
  type TraceData,
} from "../graph/tools/brain";
import type { ToolContext, ToolResult } from "../graph/tools/types";
import { clip, recordEpisode } from "./catalog";
import { isRetryable } from "./models";
import { NoModelError, runAgent } from "./run";

export const BRAIN_INSTRUCTIONS = `You are the agency brain of the control center that runs New York City subway disruptions in Detour. Two graphs answer you. The shared agency graph holds the MTA's real records: every elevator and escalator with who maintains it (the MTA's asset inventory), every outage the MTA's feed has listed (current, planned and resolved, with times), the live service alerts, the archived alert updates, rider complaints about outages, accessibility capital projects with their milestones, and the MTA's published alternative routes. The visitor's graph holds the sample agency: teams and people, documents, maintenance tickets, chat messages and decisions.

Rules:
- Answer only from tool results in this conversation. Never invent a person, team, date, number or document.
- Every tool result lists numbered sources. Cite each claim with its source number in square brackets, like [2]. Use only the numbers you were given.
- Sources marked origin "mta" are real MTA records; quote their receipt text when it carries the answer. Sources marked "sample" are the sample agency: say so when you name its people or teams. Never present a sample person as real MTA staff.
- Pick the tool that fits: equipment_status for an elevator or escalator (status, return time, maintainer, the MTA's alternative route); line_outages for outages along a line; alerts_for for service alerts; notice_chain for an archived alert event's updates; agency_changes for what changed in the MTA's records since a time; project_trace for accessibility capital projects; complaints_at for rider complaints; who_owns for ownership and who knows a station, line or ticket best; trace_decision for why the sample agency decided something; whats_changed for the sample agency's recent changes; search_knowledge and agency_search for anything else.
- If the graph does not hold the answer, say so plainly.
- Reply in two to five short sentences of plain text: no headings, lists or markdown.`;

const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const moment = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

/** Numbers sources in the order an answer first meets them; citations are [n] into this list. */
export class SourceBook {
  readonly list: BrainSource[] = [];
  number(source: BrainSource): number {
    const at = this.list.findIndex((s) => s.id === source.id);
    if (at >= 0) return at + 1;
    this.list.push(source);
    return this.list.length;
  }
  cite(...ids: string[]): string {
    const ns = [...new Set(ids.map((id) => this.list.findIndex((s) => s.id === id) + 1).filter((n) => n > 0))];
    return ns.map((n) => `[${n}]`).join("");
  }
  get(id: string): BrainSource | undefined {
    return this.list.find((s) => s.id === id);
  }
}

type WithSources = { sources: BrainSource[] };

/** Timestamps (keys ending in Ms, and change times) as dates the model can read. */
function readable(value: unknown, key = ""): unknown {
  if (typeof value === "number" && (key.endsWith("Ms") || key === "at" || key === "since")) return moment(value);
  if (Array.isArray(value)) return value.map((v) => readable(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, readable(v, k)]));
  return value;
}

function forModel(r: ToolResult<WithSources>, book: SourceBook): unknown {
  const { sources, ...facts } = r.data;
  return {
    outcome: r.outcome,
    summary: r.summary,
    facts: readable(facts),
    sources: sources.map((s) => ({
      n: book.number(s),
      kind: s.kind,
      origin: s.origin ?? "sample",
      id: s.id,
      title: s.title,
      by: s.by,
      team: s.team,
      date: s.atMs ? day(s.atMs) : null,
      status: s.status,
      excerpt: s.snippet,
      receipt: s.receipt ? { source: s.receipt.source, fetched: s.receipt.fetchedMs ? moment(s.receipt.fetchedMs) : null, text: clip(s.receipt.quote, 400) } : undefined,
    })),
  };
}

/** The brain's tools as the model sees them. Each call is recorded as a step with its Cypher. */
export function buildBrainTools(base: Omit<ToolContext, "tracer">, book: SourceBook, steps: BrainStep[]): ToolSet {
  const wrap = <I>(name: string, fn: (ctx: ToolContext, input: I) => Promise<ToolResult<WithSources>>) => {
    return async (input: I) => {
      const ctx: ToolContext = { ...base, tracer: new Tracer() };
      try {
        const r = await fn(ctx, input);
        steps.push({ tool: r.tool, outcome: r.outcome, summary: r.summary, trace: r.trace });
        void recordEpisode(ctx, r);
        return forModel(r, book);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({ tool: name, outcome: "not_in_graph", summary: `The tool failed: ${message}`, trace: ctx.tracer.traces.splice(0) });
        return { outcome: "error", summary: `The tool failed: ${message}. Try another tool or say the graph does not hold it.` };
      }
    };
  };
  const text = z.string().min(2).max(300);
  const q = z.object({ query: text });
  return {
    who_owns: tool({
      description:
        "Who owns or maintains a station, line, ticket or playbook: the sample teams and their people, tickets about it (open first, with the assignee), who wrote, posted, filed or decided the most about it, and for a station the real MTA units there and who maintains them. Pass the question's place, line or ticket words.",
      inputSchema: z.object({ subject: text }),
      execute: wrap("who_owns", (ctx, i: { subject: string }) => whoOwns(ctx, i)),
    }),
    trace_decision: tool({
      description:
        "Find a recorded decision of the sample agency (by id like DEC-0616-SIZE or by words) and trace it back: who decided it and when, its rationale, what it rests on (documents, tickets, chats, findings, earlier decisions), where those findings came from, what it changed, and whether it is still in force.",
      inputSchema: q,
      execute: wrap("trace_decision", (ctx, i: { query: string }) => traceDecision(ctx, i)),
    }),
    whats_changed: tool({
      description:
        "What the sample agency's graph learned, closed, opened, resolved, decided, wrote or published in the last N days (default 7). For the MTA's own records use agency_changes.",
      inputSchema: z.object({ days: z.number().int().min(1).max(365).optional() }),
      execute: wrap("whats_changed", (ctx, i: { days?: number }) => whatsChanged(ctx, i)),
    }),
    search_knowledge: tool({
      description: "Search the sample agency's documents, tickets, chat messages, decisions, findings and playbooks for the question's words.",
      inputSchema: q,
      execute: wrap("search_knowledge", (ctx, i: { query: string }) => searchKnowledge(ctx, i)),
    }),
    equipment_status: tool({
      description:
        "Real MTA elevators and escalators by unit id (EL382, ES236) or by station: in service or out, the outage's reason, start and estimated return, planned and past outages, who maintains it (MTA asset inventory), the next accessible stations, and the MTA's published alternative route. Pass the unit ids or the station and line words.",
      inputSchema: q,
      execute: wrap("equipment_status", (ctx, i: { query: string }) => equipmentStatus(ctx, i)),
    }),
    line_outages: tool({
      description: "Stations on a subway line with a real elevator or escalator out of service now. Pass the line, and 'elevator' or 'escalator' to narrow it.",
      inputSchema: q,
      execute: wrap("line_outages", (ctx, i: { query: string }) => lineOutages(ctx, i)),
    }),
    alerts_for: tool({
      description: "The MTA's live service alerts: one by id (lmm:alert:272420), or those affecting a line or station now, with their text, lines, stations and active period.",
      inputSchema: q,
      execute: wrap("alerts_for", (ctx, i: { query: string }) => alertsFor(ctx, i)),
    }),
    notice_chain: tool({
      description: "Every update of one archived MTA subway alert event (by event number), in order, from the MTA's service alert archive.",
      inputSchema: q,
      execute: wrap("notice_chain", (ctx, i: { query: string }) => noticeChain(ctx, i)),
    }),
    agency_changes: tool({
      description: "What changed in the MTA's records since a time: outages that began, outages resolved (left the feed), alerts issued, archived alert updates. Pass days back, or an ISO time.",
      inputSchema: z.object({ days: z.number().min(0.01).max(365).optional(), since: z.string().max(40).optional() }),
      execute: wrap("agency_changes", (ctx, i: { days?: number; since?: string }) =>
        agencyChanges(ctx, { sinceMs: (i.since ? sinceOf(`since ${i.since}`) : null) ?? Date.now() - (i.days ?? 7) * 86_400_000 }),
      ),
    }),
    project_trace: tool({
      description: "A real MTA accessibility capital project by id or by station or title words: stage, schedule, lines, stations, and its dated milestones from the MTA's published project schedules.",
      inputSchema: q,
      execute: wrap("project_trace", (ctx, i: { query: string }) => projectTrace(ctx, i)),
    }),
    complaints_at: tool({
      description: "Rider complaints to the MTA about elevator or escalator outages at a station, by quarter (from the MTA's customer feedback data). Pass the station and an optional quarter like 2026 Q2.",
      inputSchema: q,
      execute: wrap("complaints_at", (ctx, i: { query: string }) => complaintsAt(ctx, i)),
    }),
    agency_search: tool({
      description: "Full-text search over every real MTA record in the agency graph: units, outages, alerts, alternative routes, projects, milestones and complaint counts.",
      inputSchema: q,
      execute: wrap("agency_search", (ctx, i: { query: string }) => agencySearch(ctx, i)),
    }),
  };
}

// ---------------------------------------------------------------- the standard procedure (no model)

export type BrainPlan =
  | { tool: "who_owns"; input: { subject: string } }
  | { tool: "trace_decision"; input: { query: string } }
  | { tool: "whats_changed"; input: { days: number } }
  | { tool: "search_knowledge"; input: { query: string } }
  | { tool: "equipment_status"; input: { query: string } }
  | { tool: "line_outages"; input: { query: string } }
  | { tool: "alerts_for"; input: { query: string } }
  | { tool: "notice_chain"; input: { query: string } }
  | { tool: "agency_changes"; input: { sinceMs: number } }
  | { tool: "project_trace"; input: { query: string } }
  | { tool: "complaints_at"; input: { query: string } }
  | { tool: "agency_search"; input: { query: string } };

const DEVICE = /\b(elevators?|escalators?|lifts?)\b/;
const REAL_WORDS = /\b(elevators?|escalators?|outages?|alerts?|mta)\b/;

/** Picks the one tool a question needs, the way a person at the desk would. */
export function planQuestion(question: string, now = Date.now()): BrainPlan {
  const q = question.toLowerCase();
  if (/\bevent\s*(?:id\s*)?#?\s*\d{3,}/.test(q)) return { tool: "notice_chain", input: { query: question } };
  if (ALERT_ID.test(question)) return { tool: "alerts_for", input: { query: question } };
  if (/\bcapital project|\bproject\s*(?:id\s*)?#?\s*\d{3,}|\bmilestones?\b|\b(ada|accessibility) (project|upgrade|improvement)s?\b/.test(q)) return { tool: "project_trace", input: { query: question } };
  if (/\bcomplain/.test(q)) return { tool: "complaints_at", input: { query: question } };
  if (/\bdec-[a-z0-9-]{3,20}\b/.test(q)) return { tool: "trace_decision", input: { query: question } };
  if (unitIds(question).length) return { tool: "equipment_status", input: { query: question } };
  const explicitSince = /\bsince\s+\d{4}-\d{2}-\d{2}/.test(q) ? sinceOf(question, now) : null;
  if (explicitSince !== null) return { tool: "agency_changes", input: { sinceMs: explicitSince } };
  const days = q.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/);
  if (days || /\bwhat(?:'s| has| have)?\s+changed\b|\bwhat'?s new\b|\brecent(?:ly)?\b|\bthis week\b|\blately\b/.test(q)) {
    const n = days ? Number(days[1]) : 7;
    return REAL_WORDS.test(q) ? { tool: "agency_changes", input: { sinceMs: now - n * 86_400_000 } } : { tool: "whats_changed", input: { days: n } };
  }
  // "Which stations on the L", "which E stations", "on the Z, where are…": stations along a line, not one station.
  const alongLine = /\bwhich (?:[a-z0-9]{1,2} )?stations\b|\bstations (?:on|along)\b|\bwhere on the\b|^on the [a-z0-9]{1,2},? where\b/.test(q);
  if (alongLine && (DEVICE.test(q) || /\bout of service|outages?\b/.test(q))) return { tool: "line_outages", input: { query: question } };
  if (/\bwhy\b|\bdecid|\bdecision|\breason|\brationale|\bhow come\b/.test(q) && !DEVICE.test(q)) return { tool: "trace_decision", input: { query: question } };
  if (/\bwho\b|\bowner|\bresponsible\b|\bin charge\b|\bassigned\b|\bcontact\b/.test(q)) return { tool: "who_owns", input: { subject: question } };
  if (/\b(alerts?|service changes?|planned work|delays?|suspended)\b/.test(q)) return { tool: "alerts_for", input: { query: question } };
  if (DEVICE.test(q)) return { tool: "equipment_status", input: { query: question } };
  if (/\bwhy\b|\bdecid|\bdecision|\breason|\brationale|\bhow come\b/.test(q)) return { tool: "trace_decision", input: { query: question } };
  return { tool: "search_knowledge", input: { query: question } };
}

// ---------------------------------------------------------------- follow-up questions

/** What the previous turn was about: the ids its answer cited and the stations its question named. */
export interface PreviousTurn {
  cites: string[];
  stations: { id: string; name: string }[];
}

/** A pronoun, or a demonstrative with its noun ("that decision"), or one closing the question ("why that?"). "Is there" and "that are" are not references. */
const REFERS =
  /\b(it|its|it's|they|them|their|there)\b|\b(that|this|those|these|the same)\s+(decision|project|alert|event|elevator|escalator|unit|outage|ticket|one|station|line|update)s?\b|\b(that|this)\s*\?*$/i;
const NOT_REFERS = /\b(is|are|was|were)\s+there\b|\bthere\s+(is|are|was|were)\b/gi;

type Entity = { kind: "unit" | "decision" | "project" | "alert" | "event" | "ticket"; text: string };

/** A cited id as the thing it names: an outage, alternative route or asset line names its unit. */
export function entityOf(id: string): Entity | null {
  let m: RegExpMatchArray | null;
  if ((m = id.match(/^(?:ALT-|ASSET-)?(E[LS]\d{2,4}[A-Z]?)(?:@|$)/))) return { kind: "unit", text: m[1] };
  if (/^DEC-/.test(id)) return { kind: "decision", text: id };
  if ((m = id.match(/^CP-(\d+)(?:-|$)/))) return { kind: "project", text: `project ${m[1]}` };
  if ((m = id.match(/^EV-(\d+)$/))) return { kind: "event", text: `event ${m[1]}` };
  if (/^lmm:/.test(id)) return { kind: "alert", text: id };
  if (/^(EE|BUS)-\d/.test(id)) return { kind: "ticket", text: id };
  return null;
}

const NAMES_ITSELF = /\b(E[LS]\d{2,4}[A-Z]?|DEC-[A-Z0-9-]{3,20}|EE-\d{3,5}|BUS-\d{4}-\d{2}|lmm:[a-z_]+:\d+)\b|\bevent\s*#?\s*\d{3,}|\bproject\s*#?\s*\d{3,}/i;

/**
 * Reads a follow-up with what the previous answer was about: "When will it be back?" after an answer about EL382
 * becomes "When will it be back? (EL382)". The noun picks the kind ("that decision", "the project"); "there" is the
 * station the previous question named. A question that names its own subject, or refers to nothing, is left alone.
 */
export function resolveFollowUp(question: string, prev: PreviousTurn | null, namesPlace = false): { question: string; entity: string; label: string } | null {
  if (!prev || namesPlace || NAMES_ITSELF.test(question) || !REFERS.test(question.replace(NOT_REFERS, " "))) return null;
  const q = question.toLowerCase();
  const entities = prev.cites.map(entityOf).filter((e): e is Entity => Boolean(e));
  const want: Entity["kind"] | null = /\bdecision|\bdecid|\bwhy\b/.test(q)
    ? "decision"
    : /\bproject|\bmilestone/.test(q)
      ? "project"
      : /\bevent|\bupdates?\b/.test(q)
        ? "event"
        : /\balert/.test(q)
          ? "alert"
          : /\bticket|\bassigned\b/.test(q)
            ? "ticket"
            : /\belevator|\bescalator|\bunit|\boutage|\bback\b|\breturn|\bmaintain|\balternative|\bfixed|\bworking|\bin service/.test(q)
              ? "unit"
              : null;
  const pick = (want ? entities.find((e) => e.kind === want) : null) ?? (want && want !== "unit" ? null : entities[0]) ?? null;
  if (/\bthere\b/.test(q) && prev.stations[0] && (!pick || !/\b(it|that|this)\b/.test(q))) {
    const s = prev.stations[0];
    return { question: `${question} (at ${s.name})`, entity: s.id, label: s.name };
  }
  if (pick) return { question: `${question} (${pick.text})`, entity: pick.text, label: pick.text };
  if (prev.stations[0]) return { question: `${question} (at ${prev.stations[0].name})`, entity: prev.stations[0].id, label: prev.stations[0].name };
  return null;
}

// ---------------------------------------------------------------- wording

const KIND_WORD: Record<BrainSource["kind"], string> = {
  document: "document",
  ticket: "ticket",
  message: "chat message",
  decision: "decision",
  finding: "finding",
  playbook: "playbook",
  equipment: "MTA equipment record",
  asset: "MTA asset inventory record",
  outage: "MTA outage record",
  alert: "MTA alert",
  notice: "MTA alert update",
  complaints: "MTA complaint count",
  project: "MTA capital project",
  milestone: "MTA project milestone",
  alternative: "MTA alternative route",
};

const DOC_WORD: Record<string, string> = { "DOC-AAR": "after-action report", "DOC-PB": "playbook", "DOC-PROC": "procedure", "DOC-POLICY": "policy", "DOC-NOTICE": "notice" };

/** "Renee Alvarez's after-action report", "ticket BUS-0612-07", "finding F-0612-1". */
export function describe(s: BrainSource): string {
  if (s.kind === "ticket" || s.kind === "finding") return `${KIND_WORD[s.kind]} ${s.id}`;
  if (s.origin === "mta") return `${KIND_WORD[s.kind]} ${s.id}`;
  const word = s.kind === "document" ? (Object.entries(DOC_WORD).find(([prefix]) => s.id.startsWith(prefix))?.[1] ?? "document") : KIND_WORD[s.kind];
  if (s.kind === "decision") return `${s.by ? `${s.by}'s ` : ""}decision “${clip(s.title, 80)}”`;
  return s.by ? `${s.by}'s ${word}` : `${word} ${s.id}`;
}

export function listJoin(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const capital = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

function composeOwns(d: OwnsData, book: SourceBook, question: string): string {
  const parts: string[] = [];
  const open = d.tickets.find((k) => k.status === "open");
  const ticketSentence = open
    ? `Ticket ${open.id}, “${open.title}”, is open and assigned to ${open.assignee ? `${open.assignee}${open.role ? `, ${open.role}` : ""}${open.team ? ` (${open.team})` : ""}` : "nobody yet"} ${book.cite(open.id)}.`
    : null;
  const elevator = /elevator|escalator|accessib|step-free|wheelchair|outage|ticket|broken|fault/i.test(question);
  if (ticketSentence && elevator) parts.push(ticketSentence);
  if (d.real && elevator) parts.push(realUnitsSentence(d.real, book));
  // Sample records and the MTA's feed can disagree; say so rather than state both as true.
  if (open && elevator && d.real && /out of service|broken|stuck|outage|not working/i.test(open.title) && !d.real.units.some((u) => u.state === "out of service")) {
    parts.push(
      `The two disagree: sample ticket ${open.id} says an elevator here is out, while the MTA's latest feed lists none out at ${d.real.station?.name ?? "this station"}. The ticket is sample data; the feed is the MTA's.`,
    );
  }
  const owners = [...d.owners].sort((a, b) => (elevator ? Number(b.via.startsWith("maintains")) - Number(a.via.startsWith("maintains")) : 0));
  if (owners.length) {
    parts.push(capital(`${d.real ? "in the sample org, " : ""}${listJoin(owners.slice(0, 3).map((o) => `${o.name} ${o.via}${o.people.length ? ` (${o.people.map((p) => p.name).join(", ")})` : ""}`))}.`));
  }
  const [first, second] = d.knows;
  if (first) {
    const own = first.assigned.length
      ? `${first.assigned.length === 1 ? `ticket ${first.assigned[0]} is` : `${first.assigned.length} tickets about it are`} assigned to them${first.items ? ` and ${first.items} more record${first.items === 1 ? " is" : "s are"} theirs` : ""}`
      : `${first.items} record${first.items === 1 ? " about it is" : "s about it are"} theirs`;
    const next = second ? `; next is ${second.name}, ${second.role}` : "";
    parts.push(`${first.name}, ${first.role}, knows it best: ${own} ${book.cite(...first.assigned.slice(0, 1), ...first.ids.slice(0, 2))}${next}.`);
  }
  if (ticketSentence && !elevator) parts.push(ticketSentence);
  if (!open && (d.tickets.length || !d.real)) {
    const last = d.tickets[0];
    parts.push(last ? `No ticket about it is open; the latest, ${last.id}, is ${last.status} ${book.cite(last.id)}.` : "No ticket about it is open.");
  }
  if (d.real && !elevator) parts.push(realUnitsSentence(d.real, book));
  return parts.join(" ");
}

function realUnitsSentence(d: EquipmentData, book: SourceBook): string {
  const out = d.units.filter((u) => u.state === "out of service");
  const outs = out.map((u) => `${u.id} (${u.current?.reason ?? "no reason given"}) ${book.cite(u.current?.id ?? "", `ASSET-${u.id}`)}`);
  return `In the MTA's own records, ${d.station?.name ?? "the station"} has ${d.units.length} elevator${d.units.length === 1 ? "" : "s"} and escalators, maintained by ${maintainerList(d)} per the asset inventory${
    out.length ? `; out of service now: ${listJoin(outs)}` : `; none is out of service in the latest feed ${book.cite(...d.units.slice(0, 1).map((u) => `ASSET-${u.id}`))}`
  }.`;
}

function composeTrace(d: TraceData, book: SourceBook): string {
  const x = d.decision!;
  const parts = [`“${x.title}” was decided by ${x.by ?? "someone the graph does not record"}${x.role ? `, ${x.role}` : ""}, on ${day(x.decidedMs)} ${book.cite(x.id)}.`, x.rationale];
  const rests = d.basedOn.map((id) => book.get(id)).filter((s): s is BrainSource => Boolean(s));
  if (rests.length) parts.push(`It rests on ${listJoin(rests.map((s) => `${describe(s)} ${book.cite(s.id)}`))}.`);
  for (const f of d.deeper) {
    const from = f.sources.map((id) => book.get(id)).filter((s): s is BrainSource => Boolean(s));
    if (from.length) parts.push(`Finding ${f.finding} traces back to ${listJoin(from.map((s) => `${describe(s)} ${book.cite(s.id)}`))}.`);
  }
  if (d.changed.length) parts.push(`It changed ${listJoin(d.changed.map((c) => `“${c}”`))}.`);
  const later = d.later.map((id) => book.get(id)).filter((s): s is BrainSource => Boolean(s));
  if (later.length) parts.push(`${capital(listJoin(later.map((s) => `${describe(s)} ${book.cite(s.id)}`)))} builds on it.`);
  parts.push(x.status === "lifted" && x.liftedMs ? `It was lifted on ${day(x.liftedMs)}, when the ticket it rested on was resolved.` : "It is still in force.");
  return parts.join(" ");
}

function changePhrase(what: string, s: BrainSource | undefined, id: string): string {
  const title = s ? `“${clip(s.title, 90)}”` : id;
  switch (s?.kind) {
    case "ticket":
      return `ticket ${id} ${what} (${clip(s.title, 70)})`;
    case "finding":
      return `memory ${what === "closed" ? "closed the fact" : "learned"} ${title}`;
    case "decision":
      return what === "published" || what === "proposed" ? `plan ${id} ${what}` : what === "lifted" ? `decision ${title} lifted` : `${s.by ?? "someone"} decided ${title}`;
    case "message":
      return `${s.by ?? "someone"} posted ${title}`;
    case "document":
      return `${s.by ?? "someone"} wrote ${title}`;
    default:
      return `${id} ${what}`;
  }
}

function composeChanges(d: ChangesData, book: SourceBook): string {
  const lines = d.changes.slice(0, 6).map((c) => `${day(c.at)}: ${changePhrase(c.what, book.get(c.id), c.id)} ${book.cite(c.id)}`);
  return `${d.widened ? `Nothing changed in the last ${d.days} days. The latest changes were` : `In the last ${d.days} days`}: ${lines.join("; ")}.`;
}

function composeSearch(d: SearchData, book: SourceBook): string {
  const tickets = d.sources.filter((s) => s.kind === "ticket");
  const lead = tickets.map((t) => `Ticket ${t.id}, “${clip(t.title, 80)}”, is ${t.status ?? "on file"} ${book.cite(t.id)}.`);
  const top = d.sources
    .filter((s) => s.kind !== "ticket")
    .slice(0, 3)
    .map((s) => {
      const closed = s.kind === "finding" && s.status === "closed" ? ", no longer true" : "";
      return capital(`${describe(s)}${s.atMs ? ` (${day(s.atMs)}${closed})` : closed ? ` (${closed.slice(2)})` : ""}: “${clip(s.snippet ?? s.title, 110)}” ${book.cite(s.id)}`);
    });
  return [`${d.sources.length} record${d.sources.length === 1 ? "" : "s"} in the graph match.`, ...lead, top.length ? `${top.join(". ")}.` : ""].filter(Boolean).join(" ");
}

const word = (kind: string) => (kind === "escalator" ? "escalator" : "elevator");

function unitSentences(u: UnitFacts, book: SourceBook, question: string): string[] {
  const q = question.toLowerCase();
  const out: string[] = [];
  const at = `${word(u.kind)} ${u.id} at ${u.stationName}${u.serving ? ` (${clip(u.serving, 90)})` : ""}`;
  const askAlt = /\balternativ|\binstead\b|\bother way\b|\bdetour\b|\bget around\b/.test(q);
  const askWho = /\bmaintain|\bwho\b|\bservices?\b|\brepairs?\b|\bowns?\b/.test(q);
  const askWhen = /\bwhen\b|\bback\b|\breturn|\bhow long\b|\buntil\b/.test(q);
  if (u.current) {
    const c = u.current;
    out.push(
      capital(
        `${at} is out of service since ${c.sinceMs ? moment(c.sinceMs) : "a time the feed does not give"}, reason: ${c.reason} ${book.cite(c.id)}. ${
          c.estReturnMs ? `The MTA estimates it back in service ${moment(c.estReturnMs)}.` : "The MTA gives no estimated return."
        }`,
      ),
    );
  } else {
    out.push(capital(`${at} is in service: the MTA's outage feed lists no current outage for it ${book.cite(u.id)}.`));
    if (askWhen) out.push("So there is no return time to give.");
  }
  if (u.planned.length) {
    const p = u.planned[0];
    out.push(`A planned outage (${p.reason}) starts ${p.sinceMs ? moment(p.sinceMs) : "at a time not given"}${p.estReturnMs ? `, back ${moment(p.estReturnMs)}` : ""} ${book.cite(p.id)}.`);
  }
  if (askWho || !askAlt) {
    out.push(
      u.maintainedBy
        ? `The MTA's asset inventory says ${u.id} is maintained by ${u.maintainedBy}${u.installer ? ` (installed by ${u.installer})` : ""} ${book.cite(`ASSET-${u.id}`)}.`
        : `The MTA's asset inventory does not list ${u.id}, so who maintains it is not on record.`,
    );
    if (askWho && u.sampleAssignee) out.push(`In the sample org, the outage would sit with ${u.sampleAssignee.name}, ${u.sampleAssignee.role} (${u.sampleAssignee.team}): a sample assignment, not MTA staff.`);
  }
  if (askAlt || (u.current && u.altRoute && !askWho)) {
    out.push(u.altRoute ? `The MTA's alternative route: “${u.altRoute}” ${book.cite(`ALT-${u.id}`)}` : `The MTA publishes no alternative route for ${u.id}.`);
  }
  if (u.resolved.length && !askAlt) {
    const last = u.resolved[0];
    out.push(`Detour has seen ${u.resolved.length} earlier outage${u.resolved.length === 1 ? "" : "s"} of it leave the feed; the last by ${last.resolvedMs ? moment(last.resolvedMs) : "an unknown time"} ${book.cite(last.id)}.`);
  }
  return out;
}

function composeEquipment(d: EquipmentData, book: SourceBook, question: string): string {
  const parts: string[] = [];
  if (d.asked.length) {
    for (const u of d.units) parts.push(...unitSentences(u, book, question));
    if (d.unknown.length) parts.push(`The MTA's equipment list has no unit ${listJoin(d.unknown)}.`);
    return parts.join(" ");
  }
  const out = d.units.filter((u) => u.state === "out of service");
  parts.push(`The MTA lists ${d.units.length} ${d.units.every((u) => u.kind === "escalator") ? "escalator" : d.units.every((u) => u.kind === "elevator") ? "elevator" : "elevator and escalator"}${d.units.length === 1 ? "" : "s"} at ${d.station?.name}, maintained by ${maintainerList(d)}.`);
  if (out.length) for (const u of out.slice(0, 3)) parts.push(...unitSentences(u, book, question).slice(0, 2));
  else parts.push(`None is out of service in the latest feed ${book.cite(...d.units.slice(0, 2).map((u) => u.id))}.`);
  const alt = out.find((u) => u.altRoute);
  if (alt && !parts.some((p) => p.includes("alternative route"))) parts.push(`The MTA's alternative route: “${clip(alt.altRoute!, 300)}” ${book.cite(`ALT-${alt.id}`)}`);
  return parts.join(" ");
}

function composeLine(d: LineOutagesData, book: SourceBook): string {
  if (!d.stations.length) return `No ${d.kind ?? "elevator or escalator"} on the ${d.route} is out of service in the MTA's latest outage feed.`;
  const list = d.stations.map((s) => `${s.name} (${s.units.map((u) => `${u.id}${u.estReturnMs ? `, back ${day(u.estReturnMs)}` : ""}`).join("; ")}) ${book.cite(...d.sources.filter((x) => x.about.includes(s.name)).map((x) => x.id))}`);
  return `${d.stations.length} station${d.stations.length === 1 ? "" : "s"} on the ${d.route} ${d.stations.length === 1 ? "has" : "have"} ${d.kind ? `an ${d.kind}` : "an elevator or escalator"} out of service now: ${listJoin(list)}.`;
}

function composeAlerts(d: AlertsData, book: SourceBook): string {
  if (d.asked && d.alerts[0]) {
    const a = d.alerts[0];
    return `MTA alert ${a.id} (${a.status}) reads: “${clip(a.header, 220)}” ${book.cite(a.id)}. It affects ${a.routes.length ? `the ${listJoin(a.routes)}` : "no line"}${
      a.stations.length ? `, at ${a.stations.length} station${a.stations.length === 1 ? "" : "s"}: ${listJoin(a.stations.slice(0, 8).map((s) => s.name))}${a.stations.length > 8 ? " and more" : ""}` : ""
    }${a.startMs ? `, from ${moment(a.startMs)}` : ""}${a.endMs ? ` to ${moment(a.endMs)}` : ""}.${
      a.stations.some((s) => s.out.length)
        ? ` Step-free riders should know: ${listJoin(a.stations.filter((s) => s.out.length).map((s) => `${s.name} has ${listJoin(s.out)} out of service`))}.`
        : ""
    }`;
  }
  const where = listJoin([...d.stations.map((s) => s.name), ...d.routes.map((r) => `the ${r}`)]);
  if (!d.alerts.length) return `No active MTA alert affects ${where}.`;
  return `${d.alerts.length} active MTA alert${d.alerts.length === 1 ? "" : "s"} affect${d.alerts.length === 1 ? "s" : ""} ${where}: ${d.alerts
    .slice(0, 3)
    .map((a) => `“${clip(a.header, 140)}” ${book.cite(a.id)}`)
    .join("; ")}.`;
}

function composeChain(d: ChainData, book: SourceBook): string {
  const first = d.updates[0];
  const last = d.updates[d.updates.length - 1];
  return `The MTA's alert archive has ${d.updates.length} update${d.updates.length === 1 ? "" : "s"} for event ${d.event?.slice(3)}${d.routes.length ? ` on the ${listJoin(d.routes)}` : ""}, from ${moment(first.atMs)} to ${moment(last.atMs)}. The last (${last.status ?? "no status"}) reads: “${clip(last.header, 220)}” ${book.cite(last.id)}${
    d.updates.length > 1 ? ` The first read: “${clip(first.header, 160)}” ${book.cite(first.id)}` : ""
  }`;
}

function composeAgencyChanges(d: AgencyChangesData, book: SourceBook): string {
  const parts = [`Since ${moment(d.sinceMs)}, in the MTA's records:`];
  parts.push(
    d.opened.length
      ? `${d.opened.length} outage${d.opened.length === 1 ? "" : "s"} began (${listJoin(d.opened.slice(0, 5).map((o) => `${o.equipment} at ${o.stationName} ${book.cite(o.id)}`))}${d.opened.length > 5 ? " and more" : ""});`
      : "no new outage began;",
  );
  parts.push(
    d.resolved.length
      ? `${d.resolved.length} left the feed as resolved (${listJoin(d.resolved.slice(0, 5).map((o) => `${o.equipment} at ${o.stationName} ${book.cite(o.id)}`))}${d.resolved.length > 5 ? " and more" : ""});`
      : "none was resolved;",
  );
  parts.push(`${d.alerts.length} alert${d.alerts.length === 1 ? " was" : "s were"} issued${d.notices ? ` and the alert archive holds ${d.notices} update${d.notices === 1 ? "" : "s"}` : ""}.`);
  return parts.join(" ");
}

function composeProject(d: ProjectData, book: SourceBook, question: string): string {
  const p = d.project!;
  const parts = [`Capital project ${p.record}, “${p.title}”, is in ${p.stage ?? "an unrecorded stage"}${p.phase && p.phase !== p.stage ? ` (${p.phase})` : ""} ${book.cite(p.id)}.`];
  if (p.startMs || p.estimatedMs) parts.push(`It started ${p.startMs ? day(p.startMs) : "on a date not given"}${p.goalMs ? `, aimed to finish ${day(p.goalMs)}` : ""}${p.estimatedMs ? ` and is now estimated to finish ${day(p.estimatedMs)}` : ""}.`);
  const asked = d.milestones.filter((m) => m.title && question.toLowerCase().includes(m.title.toLowerCase()));
  const show = asked.length ? asked : d.milestones.filter((m) => m.atMs).slice(-3);
  if (show.length) parts.push(`Milestones: ${listJoin(show.map((m) => `${m.title ?? m.phase} (${m.state ?? "no state"})${m.atMs ? ` on ${day(m.atMs)}` : ""} ${book.cite(m.id)}`))}.`);
  if (d.stations.length) parts.push(`It names ${listJoin(d.stations)}.`);
  return parts.join(" ");
}

function composeComplaints(d: ComplaintsData, book: SourceBook): string {
  const cites = book.cite(...d.sources.map((s) => s.id));
  if (d.quarter) return `Riders filed ${d.total} complaint${d.total === 1 ? "" : "s"} with the MTA about elevator or escalator outages at ${d.station?.name} in ${d.quarter}${cites ? ` ${cites}` : ""}.`;
  const top = [...d.quarters].sort((a, b) => b.count - a.count)[0];
  return `Riders filed ${d.total} complaint${d.total === 1 ? "" : "s"} with the MTA about elevator or escalator outages at ${d.station?.name} from ${d.window.from} to ${d.window.to}${top ? `, the most (${top.count}) in ${top.quarter}` : ""}${cites ? ` ${cites}` : ""}.`;
}

function composeAgencySearch(d: AgencySearchData, book: SourceBook): string {
  return `${d.sources.length} MTA record${d.sources.length === 1 ? "" : "s"} match. ${d.sources
    .slice(0, 3)
    .map((s) => `${capital(describe(s))}: “${clip(s.receipt?.quote ?? s.title, 120)}” ${book.cite(s.id)}`)
    .join(". ")}.`;
}

export async function runPlan(ctx: ToolContext, plan: BrainPlan, opts: AgencyOptions = {}): Promise<ToolResult<WithSources>> {
  switch (plan.tool) {
    case "who_owns":
      return whoOwns(ctx, plan.input);
    case "trace_decision":
      return traceDecision(ctx, plan.input);
    case "whats_changed":
      return whatsChanged(ctx, plan.input);
    case "search_knowledge":
      return searchKnowledge(ctx, plan.input);
    case "equipment_status":
      return equipmentStatus(ctx, plan.input, opts);
    case "line_outages":
      return lineOutages(ctx, plan.input, opts);
    case "alerts_for":
      return alertsFor(ctx, plan.input, opts);
    case "notice_chain":
      return noticeChain(ctx, plan.input, opts);
    case "agency_changes":
      return agencyChanges(ctx, plan.input, opts);
    case "project_trace":
      return projectTrace(ctx, plan.input, opts);
    case "complaints_at":
      return complaintsAt(ctx, plan.input, opts);
    case "agency_search":
      return agencySearch(ctx, plan.input, opts);
  }
}

function compose(r: ToolResult<WithSources>, book: SourceBook, question: string): string {
  if (r.outcome !== "answered") return r.summary;
  switch (r.tool) {
    case "who_owns":
      return composeOwns(r.data as OwnsData, book, question);
    case "trace_decision":
      return composeTrace(r.data as TraceData, book);
    case "whats_changed":
      return composeChanges(r.data as ChangesData, book);
    case "equipment_status":
      return composeEquipment(r.data as EquipmentData, book, question);
    case "line_outages":
      return composeLine(r.data as LineOutagesData, book);
    case "alerts_for":
      return composeAlerts(r.data as AlertsData, book);
    case "notice_chain":
      return composeChain(r.data as ChainData, book);
    case "agency_changes":
      return composeAgencyChanges(r.data as AgencyChangesData, book);
    case "project_trace":
      return composeProject(r.data as ProjectData, book, question);
    case "complaints_at":
      return composeComplaints(r.data as ComplaintsData, book);
    case "agency_search":
      return composeAgencySearch(r.data as AgencySearchData, book);
    default:
      return composeSearch(r.data as SearchData, book);
  }
}

const SAMPLE_TOOLS = new Set(["who_owns", "trace_decision", "whats_changed"]);

/**
 * The standard procedure: one tool picked by the question's words, a fallback search (the sample agency's records,
 * then the MTA's) when it finds nothing, templated wording. "What changed" also reads the MTA's records.
 */
async function scripted(base: Omit<ToolContext, "tracer">, question: string, note: string | null, started: number): Promise<BrainAnswer> {
  const steps: BrainStep[] = [];
  const book = new SourceBook();
  const call = async (plan: BrainPlan): Promise<ToolResult<WithSources>> => {
    const ctx: ToolContext = { ...base, tracer: new Tracer() };
    let r: ToolResult<WithSources>;
    try {
      r = await runPlan(ctx, plan);
    } catch (error) {
      // The shared graph of MTA records can be missing or unreachable while the visitor's graph works: say so.
      if (SAMPLE_TOOLS.has(plan.tool) || plan.tool === "search_knowledge") throw error;
      const message = error instanceof Error ? error.message : String(error);
      r = { tool: plan.tool, outcome: "not_in_graph", summary: `The MTA's records could not be read just now (${message}).`, data: { sources: [] }, trace: ctx.tracer.traces.splice(0) };
    }
    steps.push({ tool: r.tool, outcome: r.outcome, summary: r.summary, trace: r.trace });
    void recordEpisode(ctx, r);
    return r;
  };
  const plan = planQuestion(question);
  let r = await call(plan);
  // The sample agency's tools fall back to a search; an MTA tool's refusal ("no unit EL999", "outside the data") stands.
  if (r.outcome !== "answered" && SAMPLE_TOOLS.has(plan.tool)) r = await call({ tool: "search_knowledge", input: { query: question } });
  if (r.outcome !== "answered" && r.tool === "search_knowledge") {
    const mta = await call({ tool: "agency_search", input: { query: question } });
    if (mta.outcome === "answered") r = mta;
  }
  for (const s of r.data.sources) book.number(s);
  let answer = compose(r, book, question);
  if (plan.tool === "whats_changed") {
    const mta = await call({ tool: "agency_changes", input: { sinceMs: Date.now() - plan.input.days * 86_400_000 } });
    if (mta.outcome === "answered") {
      for (const s of mta.data.sources) book.number(s);
      answer = `In the sample agency: ${answer.replace(/^./, (c) => c.toLowerCase())} ${compose(mta, book, question)}`;
    }
  }
  return { mode: "scripted", note, question, answer, sources: book.list, steps, model: null, ms: Date.now() - started };
}

/**
 * Answers one question about the agency from the visitor's graph and the shared agency graph. live: a free model
 * picks the tools and writes the answer with citations; when its quota runs out, or it answers without the graph,
 * the standard procedure answers instead and says so.
 */
export async function answerBrain(
  base: Omit<ToolContext, "tracer">,
  question: string,
  opts: { live: boolean; note?: string; abortSignal?: AbortSignal; history?: { role: "user" | "assistant"; content: string }[] },
): Promise<BrainAnswer> {
  const started = Date.now();
  if (!opts.live) return scripted(base, question, opts.note ?? null, started);
  const book = new SourceBook();
  const steps: BrainStep[] = [];
  try {
    const out = await runAgent({
      agent: base.agentId,
      instructions: BRAIN_INSTRUCTIONS,
      // Earlier turns come from the visitor's graph, so follow-up questions keep their context across sessions.
      messages: [...(opts.history ?? []), { role: "user", content: question }],
      tools: buildBrainTools(base, book, steps),
      emit: () => undefined,
      maxSteps: 5,
      abortSignal: opts.abortSignal,
    });
    const text = out.text.trim();
    if (text && steps.length && book.list.length) {
      return { mode: "live", note: null, question, answer: text, sources: book.list, steps, model: out.model, ms: Date.now() - started };
    }
    return scripted(base, question, "The model answered without checking the graph, so the standard procedure answered instead: the same graph tools, with templated wording.", started);
  } catch (error) {
    if (!isRetryable(error) && !(error instanceof NoModelError)) throw error;
    return scripted(base, question, "The free model's quota ran out, so the standard procedure answered instead: the same graph tools, with templated wording.", started);
  }
}
