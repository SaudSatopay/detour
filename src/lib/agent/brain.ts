import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { BrainAnswer, BrainSource, BrainStep } from "../brain/types";
import { Tracer } from "../graph/trace";
import {
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
import { runAgent } from "./run";

export const BRAIN_INSTRUCTIONS = `You are the agency brain of the control center that runs New York City subway disruptions in Detour. The graph holds the agency's teams and people, its documents (after-action reports, playbooks, procedures, policies, notices), maintenance tickets, chat messages and decisions, connected to the same stations, routes, incidents and findings the control room uses. The agency side is sample data; the subway is real MTA data.

Rules:
- Answer only from tool results in this conversation. Never invent a person, team, date, number or document.
- Every tool result lists numbered sources. Cite each claim with its source number in square brackets, like [2]. Use only the numbers you were given.
- Pick the tool that fits: who_owns for ownership, responsibility, open tickets and who knows a station, line or ticket best; trace_decision for why something was decided; whats_changed for what is new or recent; search_knowledge for anything else. Call more than one when the question needs it.
- If the graph does not hold the answer, say so plainly.
- Reply in two to five short sentences of plain text: no headings, lists or markdown.`;

const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

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
  if (typeof value === "number" && (key.endsWith("Ms") || key === "at" || key === "since")) return day(value);
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
      id: s.id,
      title: s.title,
      by: s.by,
      team: s.team,
      date: s.atMs ? day(s.atMs) : null,
      status: s.status,
      excerpt: s.snippet,
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
  return {
    who_owns: tool({
      description:
        "Who owns or maintains a station, line, ticket or playbook: the teams and their people, tickets about it (open first, with the assignee), and who wrote, posted, filed or decided the most about it. Pass the question's place, line or ticket words.",
      inputSchema: z.object({ subject: text }),
      execute: wrap("who_owns", (ctx, i: { subject: string }) => whoOwns(ctx, i)),
    }),
    trace_decision: tool({
      description:
        "Find a recorded decision (by id like DEC-0616-SIZE or by words) and trace it back: who decided it and when, its rationale, what it rests on (documents, tickets, chats, findings, earlier decisions), where those findings came from, what it changed, and whether it is still in force.",
      inputSchema: z.object({ query: text }),
      execute: wrap("trace_decision", (ctx, i: { query: string }) => traceDecision(ctx, i)),
    }),
    whats_changed: tool({
      description:
        "What the graph learned, closed, opened, resolved, decided, wrote or published in the last N days (default 7): findings, tickets, decisions, documents, chat messages and plans. Falls back to the latest changes when nothing is that recent.",
      inputSchema: z.object({ days: z.number().int().min(1).max(365).optional() }),
      execute: wrap("whats_changed", (ctx, i: { days?: number }) => whatsChanged(ctx, i)),
    }),
    search_knowledge: tool({
      description: "Search the agency's documents, tickets, chat messages, decisions, findings and playbooks for the question's words.",
      inputSchema: z.object({ query: text }),
      execute: wrap("search_knowledge", (ctx, i: { query: string }) => searchKnowledge(ctx, i)),
    }),
  };
}

// ---------------------------------------------------------------- the standard procedure (no model)

export type BrainPlan =
  | { tool: "who_owns"; input: { subject: string } }
  | { tool: "trace_decision"; input: { query: string } }
  | { tool: "whats_changed"; input: { days: number } }
  | { tool: "search_knowledge"; input: { query: string } };

/** Picks the one tool a question needs, the way a person at the desk would. */
export function planQuestion(question: string): BrainPlan {
  const q = question.toLowerCase();
  const days = q.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/);
  if (days || /\bwhat(?:'s| has| have)?\s+changed\b|\bwhat'?s new\b|\brecent(?:ly)?\b|\bthis week\b|\blately\b/.test(q)) {
    return { tool: "whats_changed", input: { days: days ? Number(days[1]) : 7 } };
  }
  if (/\bwhy\b|\bdecid|\bdecision|\breason|\brationale|\bhow come\b/.test(q)) return { tool: "trace_decision", input: { query: question } };
  if (/\bwho\b|\bowner|\bresponsible\b|\bin charge\b|\bassigned\b|\bcontact\b/.test(q)) return { tool: "who_owns", input: { subject: question } };
  return { tool: "search_knowledge", input: { query: question } };
}

const KIND_WORD: Record<BrainSource["kind"], string> = {
  document: "document",
  ticket: "ticket",
  message: "chat message",
  decision: "decision",
  finding: "finding",
  playbook: "playbook",
};

const DOC_WORD: Record<string, string> = { "DOC-AAR": "after-action report", "DOC-PB": "playbook", "DOC-PROC": "procedure", "DOC-POLICY": "policy", "DOC-NOTICE": "notice" };

/** "Renee Alvarez's after-action report", "ticket BUS-0612-07", "finding F-0612-1". */
export function describe(s: BrainSource): string {
  if (s.kind === "ticket" || s.kind === "finding") return `${KIND_WORD[s.kind]} ${s.id}`;
  const word = s.kind === "document" ? (Object.entries(DOC_WORD).find(([prefix]) => s.id.startsWith(prefix))?.[1] ?? "document") : KIND_WORD[s.kind];
  if (s.kind === "decision") return `${s.by ? `${s.by}'s ` : ""}decision “${clip(s.title, 80)}”`;
  return s.by ? `${s.by}'s ${word}` : `${word} ${s.id}`;
}

export function listJoin(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function composeOwns(d: OwnsData, book: SourceBook, question: string): string {
  const parts: string[] = [];
  const open = d.tickets.find((k) => k.status === "open");
  const ticketSentence = open
    ? `Ticket ${open.id}, “${open.title}”, is open and assigned to ${open.assignee ? `${open.assignee}${open.role ? `, ${open.role}` : ""}${open.team ? ` (${open.team})` : ""}` : "nobody yet"} ${book.cite(open.id)}.`
    : null;
  const elevator = /elevator|escalator|accessib|step-free|wheelchair|outage|ticket|broken|fault/i.test(question);
  if (ticketSentence && elevator) parts.push(ticketSentence);
  const owners = [...d.owners].sort((a, b) => (elevator ? Number(b.via.startsWith("maintains")) - Number(a.via.startsWith("maintains")) : 0));
  if (owners.length) {
    parts.push(capital(`${listJoin(owners.slice(0, 3).map((o) => `${o.name} ${o.via}${o.people.length ? ` (${o.people.map((p) => p.name).join(", ")})` : ""}`))}.`));
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
  if (!open) {
    const last = d.tickets[0];
    parts.push(last ? `No ticket about it is open; the latest, ${last.id}, is ${last.status} ${book.cite(last.id)}.` : "No ticket about it is open.");
  }
  return parts.join(" ");
}

const capital = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

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

async function runPlan(ctx: ToolContext, plan: BrainPlan): Promise<ToolResult<WithSources>> {
  switch (plan.tool) {
    case "who_owns":
      return whoOwns(ctx, plan.input);
    case "trace_decision":
      return traceDecision(ctx, plan.input);
    case "whats_changed":
      return whatsChanged(ctx, plan.input);
    case "search_knowledge":
      return searchKnowledge(ctx, plan.input);
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
    default:
      return composeSearch(r.data as SearchData, book);
  }
}

/** The standard procedure: one tool picked by the question's words, a fallback search when it finds nothing, templated wording. */
async function scripted(base: Omit<ToolContext, "tracer">, question: string, note: string | null, started: number): Promise<BrainAnswer> {
  const steps: BrainStep[] = [];
  const book = new SourceBook();
  const call = async (plan: BrainPlan) => {
    const ctx: ToolContext = { ...base, tracer: new Tracer() };
    const r = await runPlan(ctx, plan);
    steps.push({ tool: r.tool, outcome: r.outcome, summary: r.summary, trace: r.trace });
    void recordEpisode(ctx, r);
    return r;
  };
  const plan = planQuestion(question);
  let r = await call(plan);
  if (r.outcome !== "answered" && plan.tool !== "search_knowledge") r = await call({ tool: "search_knowledge", input: { query: question } });
  for (const s of r.data.sources) book.number(s);
  return { mode: "scripted", note, question, answer: compose(r, book, question), sources: book.list, steps, model: null, ms: Date.now() - started };
}

/**
 * Answers one question about the agency from the visitor's graph. live: a free model picks the tools and
 * writes the answer with citations; when its quota runs out, or it answers without the graph, the
 * standard procedure answers instead and says so.
 */
export async function answerBrain(
  base: Omit<ToolContext, "tracer">,
  question: string,
  opts: { live: boolean; note?: string; abortSignal?: AbortSignal },
): Promise<BrainAnswer> {
  const started = Date.now();
  if (!opts.live) return scripted(base, question, opts.note ?? null, started);
  const book = new SourceBook();
  const steps: BrainStep[] = [];
  try {
    const out = await runAgent({
      agent: base.agentId,
      instructions: BRAIN_INSTRUCTIONS,
      messages: [{ role: "user", content: question }],
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
    if (!isRetryable(error)) throw error;
    return scripted(base, question, "The free model's quota ran out, so the standard procedure answered instead: the same graph tools, with templated wording.", started);
  }
}
