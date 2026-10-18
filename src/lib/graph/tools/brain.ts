import type { BrainDirectory, BrainOwned, BrainPerson, BrainSource, BrainTeam, SourceKind } from "../../brain/types";
import { loadNetwork } from "../../network/data";
import { BRAIN_SUGGESTIONS } from "../seed-org";
import { result, type ToolContext, type ToolResult } from "./types";

/**
 * The agency brain's graph tools. Every answer is a set of nodes in the visitor's graph (documents,
 * tickets, chat messages, decisions, findings, playbooks) returned as sources, with who wrote each one,
 * their team, and when.
 */

const KIND: Record<string, SourceKind> = {
  Document: "document",
  Ticket: "ticket",
  Message: "message",
  Decision: "decision",
  Plan: "decision",
  Finding: "finding",
  Playbook: "playbook",
};

const SOURCE_NODE = "(x:Document OR x:Ticket OR x:Message OR x:Decision OR x:Finding OR x:Playbook OR x:Plan)";

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

const STOP = new Set(
  "the a an and or of to in on at for by with from about into over is are was were be been being do does did has have had who whom whose what which when where why how many much most more less than then that this these those it its it's we our you your they them their i me my can could should would will just any all some there here also not no yes get gets got make made know knows known own owns owned owner owners decide decided decision decisions changed change changes recent recently last days day week weeks tell show find give".split(
    " ",
  ),
);

/** The words worth searching for: lowercase, no stop words, plural "buses" and "-es"/"-s" trimmed to their stem. */
export function searchTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w) && (w.length >= 3 || /^\d{2,}$/.test(w)));
  const stem = (w: string) => (w === "buses" ? "bus" : w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  return [...new Set(words.map(stem))].slice(0, 8);
}

interface SourceRow {
  label: string;
  id: string;
  title: string | null;
  text: string | null;
  by: string | null;
  team: string | null;
  atMs: number | null;
  status: string | null;
  validToMs: number | null;
  about: string[];
}

function toSource(r: SourceRow): BrainSource {
  const kind = KIND[r.label] ?? "document";
  const status = r.label === "Finding" ? (r.validToMs === null || r.validToMs === undefined ? "current" : "closed") : (r.status ?? null);
  const text = r.text ?? "";
  return {
    kind,
    id: r.id,
    title: r.title ?? clip(text, 160),
    by: r.by,
    team: r.team,
    atMs: r.atMs,
    status,
    snippet: r.title && text ? clip(text, 240) : null,
    about: (r.about ?? []).filter(Boolean),
  };
}

/** The given nodes as sources, in the order asked, with author, team, date, status and what they are about. */
export async function sourcesFor(ctx: ToolContext, ids: string[]): Promise<BrainSource[]> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return [];
  const res = await ctx.tracer.run<SourceRow>(
    "the sources, with who wrote them and when",
    ctx.sandbox,
    `UNWIND $ids AS sid
     MATCH (x) WHERE x.id = sid AND ${SOURCE_NODE}
     OPTIONAL MATCH (p:Person)-[:AUTHORED|POSTED|FILED|DECIDED]->(x)
     OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
     OPTIONAL MATCH (ag:Agent)-[:WROTE]->(x)
     OPTIONAL MATCH (x)-[:MENTIONS|ABOUT]->(m) WHERE m:Station OR m:Route
     RETURN labels(x)[0] AS label, x.id AS id, coalesce(x.title, x.label) AS title, coalesce(x.text, x.rationale) AS text,
            coalesce(p.name, ag.name, x.approvedBy) AS by, t.name AS team,
            coalesce(x.decidedMs, x.openedMs, x.publishedMs, x.createdMs, x.atMs, x.validFromMs, x.lastUsedMs) AS atMs,
            x.status AS status, x.validToMs AS validToMs,
            collect(DISTINCT CASE WHEN hasLabels(m, ['Route']) THEN m.id ELSE m.name END) AS about`,
    { ids: wanted },
    { readOnly: true },
  );
  const byId = new Map(res.rows.map((r) => [r.id, toSource(r)]));
  return wanted.map((id) => byId.get(id)).filter((s): s is BrainSource => Boolean(s));
}

// ---------------------------------------------------------------- search_knowledge

export interface SearchData {
  terms: string[];
  hits: { id: string; score: number }[];
  sources: BrainSource[];
}

/** Documents, tickets, chat messages, decisions, findings and playbooks that mention the question's words. */
export async function searchKnowledge(ctx: ToolContext, input: { query: string }): Promise<ToolResult<SearchData>> {
  const terms = searchTerms(input.query);
  if (!terms.length) return result(ctx, "search_knowledge", "unknown_entity", "The question has no words to search for.", { terms, hits: [], sources: [] });
  const res = await ctx.tracer.run<{ id: string; score: number }>(
    "search documents, tickets, chats, decisions and findings",
    ctx.sandbox,
    `MATCH (x) WHERE ${SOURCE_NODE}
     WITH x, toLower(coalesce(x.title, '') + ' ' + coalesce(x.text, '') + ' ' + coalesce(x.rationale, '') + ' ' + coalesce(x.label, '')) AS hay
     WITH x, size([w IN $terms WHERE hay CONTAINS w]) AS score
     WHERE score > 0
     RETURN x.id AS id, score
     ORDER BY score DESC, coalesce(x.decidedMs, x.openedMs, x.createdMs, x.atMs, x.validFromMs, 0) DESC
     LIMIT 8`,
    { terms },
    { readOnly: true },
  );
  const best = res.rows.length ? res.rows[0].score : 0;
  const hits = res.rows.filter((r) => r.score >= Math.max(1, Math.ceil(best / 2)));
  const sources = await sourcesFor(ctx, hits.map((h) => h.id));
  if (!sources.length) {
    return result(ctx, "search_knowledge", "not_in_graph", `Nothing in the agency's documents, tickets, chats or decisions mentions ${terms.join(", ")}.`, { terms, hits, sources });
  }
  return result(
    ctx,
    "search_knowledge",
    "answered",
    `${sources.length} item${sources.length === 1 ? "" : "s"} mention ${terms.join(", ")}: ${sources.slice(0, 3).map((s) => `${s.id} “${clip(s.title, 70)}”`).join("; ")}.`,
    { terms, hits, sources },
  );
}

// ---------------------------------------------------------------- who_owns

export interface OwnerTeam {
  team: string;
  name: string;
  mission: string;
  via: string;
  people: BrainPerson[];
}

export interface Knower {
  name: string;
  role: string;
  team: string | null;
  /** Records about it they wrote, posted, filed or decided. */
  items: number;
  ids: string[];
  /** Tickets about it assigned to them; each counts double. */
  assigned: string[];
  score: number;
}

export interface OwnsData {
  subject: { label: string; stations: string[]; routes: string[]; ids: string[] } | null;
  owners: OwnerTeam[];
  tickets: { id: string; title: string; status: string; assignee: string | null; role: string | null; team: string | null }[];
  knows: Knower[];
  sources: BrainSource[];
}

const ID_PATTERN = /\b(EE-\d{3,5}|BUS-\d{4}-\d{2}|INC-[0-9A-Z]{3,10}|PB-[A-Z-]{3,20}|DOC-[A-Z0-9-]{3,20}|DEC-[A-Z0-9-]{3,20})\b/gi;

/** Route ids written as a line: "the G", "L train", "A line", "4 train", or a lone capital letter other than A and I. */
export function routesIn(text: string, known: string[]): string[] {
  const found = new Set<string>();
  const set = new Set(known);
  for (const m of text.matchAll(/\b(?:the\s+)?([A-Z]{1,2}|[1-7])(?:\s+(?:train|line|lines|trains|tube|platform))?\b/g)) {
    const id = m[1];
    const explicit = /\b(?:the\s+\S+|\S+\s+(?:train|line|lines|trains|tube|platform))$/.test(m[0]);
    if (set.has(id) && (explicit || (id.length === 1 && id !== "A" && id !== "I"))) found.add(id);
  }
  return [...found];
}

/** Words that describe the question, not a place, so they never resolve to a station. */
const NOT_PLACES = new Set("elevator elevators escalator outage outages ticket tickets train trains line lines platform platforms station stations tube bus bridge bridges shuttle crowding plan plans playbook".split(" "));

async function resolveStation(ctx: ToolContext, text: string, routes: string[]): Promise<{ id: string; name: string } | null> {
  const words = searchTerms(text).filter((w) => !NOT_PLACES.has(w) && !/^\d+$/.test(w) && w.length >= 4);
  if (!words.length) return null;
  const res = await ctx.tracer.run<{ id: string; name: string; routes: string[]; score: number }>(
    "find the station named in the question",
    ctx.sandbox,
    `CALL db.idx.fulltext.queryNodes('Station', $q) YIELD node, score
     RETURN node.id AS id, node.name AS name, node.routes AS routes, score
     ORDER BY score DESC LIMIT 8`,
    { q: words.join("|") },
    { readOnly: true },
  );
  if (!res.rows.length) return null;
  const named = res.rows.filter((r) => words.some((w) => r.name.toLowerCase().includes(w)));
  const pool = named.length ? named : res.rows;
  const onRoute = routes.length ? pool.find((r) => r.routes?.some((x) => routes.includes(x))) : undefined;
  const pick = onRoute ?? pool[0];
  return { id: pick.id, name: pick.name };
}

/** Which team owns a station, line, ticket or playbook, who is on it, what is open there, and who knows it best. */
export async function whoOwns(ctx: ToolContext, input: { subject: string }): Promise<ToolResult<OwnsData>> {
  const network = await loadNetwork();
  const routes = routesIn(input.subject, network.routes.map((r) => r.id));
  const ids = [...new Set([...input.subject.matchAll(ID_PATTERN)].map((m) => m[1].toUpperCase()))];
  const station = await resolveStation(ctx, input.subject, routes);
  const stations = station ? [station.id] : [];
  if (!stations.length && !routes.length && !ids.length) {
    return result(ctx, "who_owns", "unknown_entity", "The question names no station, line, ticket or playbook the graph knows.", {
      subject: null,
      owners: [],
      tickets: [],
      knows: [],
      sources: [],
    });
  }
  const label = [station?.name, routes.length ? `the ${routes.join(", ")}` : null, ...ids].filter(Boolean).join(", ");

  const owners = await ctx.tracer.run<{ team: string; name: string; mission: string; via: string; people: BrainPerson[] }>(
    "teams that own or maintain it, and their people",
    ctx.sandbox,
    `MATCH (t:Team)-[rel:OWNS|MAINTAINS]->(n)
     WHERE (n:Station AND n.id IN $stations) OR (n:Route AND n.id IN $routes)
        OR (n:Route AND size($routes) = 0 AND n.id IN $stationRoutes)
        OR ((n:Playbook OR n:Incident) AND n.id IN $ids)
     WITH t, collect(DISTINCT CASE WHEN type(rel) = 'MAINTAINS' THEN 'maintains the elevators at ' + n.name
                                   WHEN hasLabels(n, ['Route']) THEN 'plans the ' + n.id
                                   ELSE 'owns ' + coalesce(n.title, n.id) END) AS via
     OPTIONAL MATCH (p:Person)-[:MEMBER_OF]->(t)
     RETURN t.id AS team, t.name AS name, t.mission AS mission, t.ord AS ord, via[0] AS via,
            collect(DISTINCT {id: p.id, name: p.name, role: p.role}) AS people
     ORDER BY ord`,
    {
      stations,
      routes,
      ids,
      stationRoutes: station ? (network.stations.find((s) => s.id === station.id)?.routes ?? []) : [],
    },
    { readOnly: true },
  );

  const tickets = await ctx.tracer.run<OwnsData["tickets"][number]>(
    "tickets about it, open first",
    ctx.sandbox,
    `MATCH (k:Ticket)
     OPTIONAL MATCH (k)-[:MENTIONS]->(n) WHERE (n:Station AND n.id IN $stations) OR (n:Route AND n.id IN $routes AND size($stations) = 0)
     WITH k, count(n) AS hits
     WHERE hits > 0 OR k.id IN $ids
     OPTIONAL MATCH (k)-[:ASSIGNED_TO]->(a:Person)
     OPTIONAL MATCH (a)-[:MEMBER_OF]->(t:Team)
     RETURN k.id AS id, k.title AS title, k.status AS status, a.name AS assignee, a.role AS role, t.name AS team
     ORDER BY CASE k.status WHEN 'open' THEN 0 ELSE 1 END, k.openedMs DESC
     LIMIT 4`,
    { ids, stations, routes },
    { readOnly: true },
  );

  type Rec = { name: string; role: string; team: string | null; items: number; ids: string[] };
  const MENTIONED = "(n:Station AND n.id IN $stations) OR (n:Route AND n.id IN $routes) OR (n:Incident AND n.id IN $ids)";
  const wrote = await ctx.tracer.run<Rec>(
    "who wrote, posted, filed or decided records about it",
    ctx.sandbox,
    `MATCH (p:Person)-[:AUTHORED|POSTED|FILED|DECIDED]->(x)-[:MENTIONS]->(n)
     WHERE ${MENTIONED}
     OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
     RETURN p.name AS name, p.role AS role, t.name AS team, count(DISTINCT x) AS items, collect(DISTINCT x.id) AS ids`,
    { stations, routes, ids },
    { readOnly: true },
  );
  const assigned = await ctx.tracer.run<Rec>(
    "who is assigned tickets about it",
    ctx.sandbox,
    `MATCH (x:Ticket)-[:MENTIONS]->(n) WHERE ${MENTIONED}
     MATCH (x)-[:ASSIGNED_TO]->(p:Person)
     OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
     RETURN p.name AS name, p.role AS role, t.name AS team, count(DISTINCT x) AS items, collect(DISTINCT x.id) AS ids`,
    { stations, routes, ids },
    { readOnly: true },
  );
  const people = new Map<string, Knower>();
  for (const r of wrote.rows) people.set(r.name, { ...r, assigned: [], score: r.items });
  for (const r of assigned.rows) {
    const k = people.get(r.name) ?? { name: r.name, role: r.role, team: r.team, items: 0, ids: [], assigned: [], score: 0 };
    k.assigned = r.ids;
    k.score += 2 * r.items;
    people.set(r.name, k);
  }
  const knows = { rows: [...people.values()].sort((a, b) => b.score - a.score || b.items - a.items).slice(0, 4) };

  const ownerRows = owners.rows.map((o) => ({ ...o, people: (o.people ?? []).filter((p) => p && p.id) }));
  const sourceIds = [...tickets.rows.filter((k) => k.status === "open").map((k) => k.id), ...knows.rows.flatMap((k) => [...k.assigned.slice(0, 1), ...k.ids.slice(0, 2)]), ...tickets.rows.filter((k) => k.status !== "open").map((k) => k.id)];
  const sources = await sourcesFor(ctx, sourceIds.slice(0, 8));
  const data: OwnsData = { subject: { label, stations, routes, ids }, owners: ownerRows, tickets: tickets.rows, knows: knows.rows, sources };

  if (!ownerRows.length && !tickets.rows.length && !knows.rows.length) {
    return result(ctx, "who_owns", "not_in_graph", `No team, ticket or person in the graph is connected to ${label}.`, data);
  }
  const open = tickets.rows.find((k) => k.status === "open");
  const summary = [
    ownerRows.length ? `${ownerRows.map((o) => `${o.name} (${o.via})`).join("; ")}.` : `No team owns ${label} in the graph.`,
    open ? `Open ticket ${open.id} is assigned to ${open.assignee ?? "nobody"}.` : "",
    knows.rows.length ? `Knows it best: ${knows.rows.slice(0, 2).map((k) => `${k.name} (${k.assigned.length ? `assigned ${k.assigned.join(", ")}` : `${k.items} records`})`).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return result(ctx, "who_owns", "answered", summary, data);
}

// ---------------------------------------------------------------- trace_decision

export interface TraceData {
  decision: {
    id: string;
    title: string;
    rationale: string;
    decidedMs: number;
    status: string;
    liftedMs: number | null;
    by: string | null;
    role: string | null;
    team: string | null;
  } | null;
  basedOn: string[];
  /** Second hop: the sources of the findings the decision rests on. */
  deeper: { finding: string; sources: string[] }[];
  changed: string[];
  later: string[];
  sources: BrainSource[];
}

/** A decision, who made it and when, and everything it rests on, two hops back to the original documents, tickets and chats. */
export async function traceDecision(ctx: ToolContext, input: { query: string }): Promise<ToolResult<TraceData>> {
  const empty: TraceData = { decision: null, basedOn: [], deeper: [], changed: [], later: [], sources: [] };
  let id = input.query.match(/\bDEC-[A-Z0-9-]{3,20}\b/i)?.[0].toUpperCase() ?? null;
  if (!id) {
    const terms = searchTerms(input.query);
    if (!terms.length) return result(ctx, "trace_decision", "unknown_entity", "The question names no decision to trace.", empty);
    const found = await ctx.tracer.run<{ id: string; score: number }>(
      "find the decision the question is about",
      ctx.sandbox,
      `MATCH (d:Decision)
       WITH d, toLower(d.title + ' ' + d.rationale) AS hay
       WITH d, size([w IN $terms WHERE hay CONTAINS w]) AS score
       WHERE score > 0
       RETURN d.id AS id, score ORDER BY score DESC, d.decidedMs DESC LIMIT 1`,
      { terms },
      { readOnly: true },
    );
    id = found.rows[0]?.id ?? null;
    if (!id) return result(ctx, "trace_decision", "not_in_graph", `No recorded decision matches ${terms.join(", ")}.`, empty);
  }

  const res = await ctx.tracer.run<NonNullable<TraceData["decision"]> & { basedOn: string[]; changed: string[]; later: string[] }>(
    "the decision, who made it, and what it rests on",
    ctx.sandbox,
    `MATCH (d:Decision {id: $id})
     OPTIONAL MATCH (p:Person)-[:DECIDED]->(d)
     OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
     OPTIONAL MATCH (d)-[:BASED_ON]->(b)
     OPTIONAL MATCH (d)-[:CHANGED]->(c)
     OPTIONAL MATCH (later:Decision)-[:BASED_ON]->(d)
     RETURN d.id AS id, d.title AS title, d.rationale AS rationale, d.decidedMs AS decidedMs, d.status AS status,
            d.liftedMs AS liftedMs, p.name AS by, p.role AS role, t.name AS team,
            collect(DISTINCT b.id) AS basedOn, collect(DISTINCT coalesce(c.title, c.id)) AS changed, collect(DISTINCT later.id) AS later`,
    { id },
    { readOnly: true },
  );
  const row = res.rows[0];
  if (!row) return result(ctx, "trace_decision", "unknown_entity", `No decision ${id} in the graph.`, empty);

  const deep = await ctx.tracer.run<{ finding: string; sources: string[] }>(
    "where the findings it rests on came from",
    ctx.sandbox,
    `MATCH (:Decision {id: $id})-[:BASED_ON]->(f:Finding)-[:SOURCED_FROM]->(s)
     RETURN f.id AS finding, collect(DISTINCT s.id) AS sources`,
    { id },
    { readOnly: true },
  );
  const { basedOn, changed, later, ...decision } = row;
  const sourceIds = [decision.id, ...basedOn, ...deep.rows.flatMap((d) => d.sources), ...later];
  const sources = await sourcesFor(ctx, sourceIds);
  const data: TraceData = { decision, basedOn, deeper: deep.rows, changed, later, sources };
  return result(
    ctx,
    "trace_decision",
    "answered",
    `${decision.id} “${decision.title}”, decided by ${decision.by ?? "someone not recorded"}, rests on ${basedOn.join(", ") || "nothing recorded"}${deep.rows.length ? `; ${deep.rows.map((d) => `${d.finding} came from ${d.sources.join(", ")}`).join("; ")}` : ""}.`,
    data,
  );
}

// ---------------------------------------------------------------- whats_changed

export interface ChangeRow {
  id: string;
  label: string;
  what: string;
  at: number;
}

export interface ChangesData {
  days: number;
  since: number;
  /** True when nothing changed in the window and these are the latest changes instead. */
  widened: boolean;
  changes: ChangeRow[];
  sources: BrainSource[];
}

const CHANGES = `MATCH (x) WHERE x:Finding OR x:Ticket OR x:Decision OR x:Document OR x:Message OR x:Plan
     UNWIND [['learned', x.validFromMs], ['closed', x.validToMs], ['opened', x.openedMs], ['resolved', x.resolvedMs],
             ['decided', x.decidedMs], ['lifted', x.liftedMs], ['written', x.createdMs], ['posted', x.atMs],
             ['published', x.publishedMs]] AS e
     WITH x, e[0] AS what, e[1] AS at
     WHERE at IS NOT NULL AND at >= $since
     RETURN x.id AS id, labels(x)[0] AS label, what, at
     ORDER BY at DESC LIMIT 12`;

/** What the graph learned, closed, opened, resolved, decided or published in the last N days. */
export async function whatsChanged(ctx: ToolContext, input: { days?: number }): Promise<ToolResult<ChangesData>> {
  const days = Math.max(1, Math.min(365, Math.round(input.days ?? 7)));
  const since = Date.now() - days * 86_400_000;
  let res = await ctx.tracer.run<ChangeRow>(`changes in the last ${days} days`, ctx.sandbox, CHANGES, { since }, { readOnly: true });
  let widened = false;
  if (!res.rows.length) {
    widened = true;
    res = await ctx.tracer.run<ChangeRow>("the latest changes at any time", ctx.sandbox, CHANGES, { since: 0 }, { readOnly: true });
  }
  const changes = res.rows.map((r) => ({ ...r, what: r.label === "Plan" && r.what === "written" ? "proposed" : r.what }));
  const sources = await sourcesFor(ctx, changes.map((c) => c.id));
  const data: ChangesData = { days, since, widened, changes, sources };
  if (!changes.length) return result(ctx, "whats_changed", "not_in_graph", "The graph has no dated changes.", data);
  return result(
    ctx,
    "whats_changed",
    "answered",
    `${widened ? `Nothing changed in the last ${days} days; the latest changes` : `${changes.length} change${changes.length === 1 ? "" : "s"} in the last ${days} days`}: ${changes
      .slice(0, 4)
      .map((c) => `${c.id} ${c.what}`)
      .join(", ")}.`,
    data,
  );
}

// ---------------------------------------------------------------- directory

/** The org side of the visitor's graph for the brain page: teams, their people and what they own, open tickets, decisions. */
export async function brainDirectory(ctx: ToolContext): Promise<BrainDirectory> {
  const counts = await ctx.tracer.run<{ label: string; n: number }>(
    "count the org layer",
    ctx.sandbox,
    `MATCH (n) WHERE n:Person OR n:Team OR n:Document OR n:Ticket OR n:Message OR n:Decision
     RETURN labels(n)[0] AS label, count(n) AS n`,
    {},
    { readOnly: true },
  );
  const teams = await ctx.tracer.run<{ id: string; name: string; mission: string; people: BrainPerson[]; owns: (BrainOwned & { sort: number | null })[] }>(
    "teams, their people and what they own",
    ctx.sandbox,
    `MATCH (t:Team)
     OPTIONAL MATCH (p:Person)-[:MEMBER_OF]->(t)
     WITH t, collect(DISTINCT {id: p.id, name: p.name, role: p.role}) AS people
     OPTIONAL MATCH (t)-[:OWNS]->(o) WHERE o:Route OR o:Playbook
     WITH t, people, collect(DISTINCT {kind: CASE WHEN hasLabels(o, ['Route']) THEN 'route' ELSE 'playbook' END, id: o.id, label: coalesce(o.title, o.id), sort: o.sort}) AS owns
     RETURN t.id AS id, t.name AS name, t.mission AS mission, t.ord AS ord, people, owns
     ORDER BY ord`,
    {},
    { readOnly: true },
  );
  const maintained = await ctx.tracer.run<{ team: string; id: string; label: string }>(
    "stations each team maintains that have tickets",
    ctx.sandbox,
    `MATCH (t:Team)-[:MAINTAINS]->(s:Station), (k:Ticket)-[:MENTIONS]->(s)
     RETURN DISTINCT t.id AS team, s.id AS id, s.name AS label`,
    {},
    { readOnly: true },
  );
  const open = await ctx.tracer.run<{ id: string }>("open tickets", ctx.sandbox, "MATCH (k:Ticket {status: 'open'}) RETURN k.id AS id ORDER BY k.openedMs DESC", {}, { readOnly: true });
  const decisions = await ctx.tracer.run<{ id: string }>(
    "decisions, newest first",
    ctx.sandbox,
    `MATCH (d) WHERE d:Decision OR (d:Plan AND d.status = 'published')
     RETURN d.id AS id ORDER BY coalesce(d.publishedMs, d.decidedMs) DESC LIMIT 8`,
    {},
    { readOnly: true },
  );
  const sources = await sourcesFor(ctx, [...open.rows.map((r) => r.id), ...decisions.rows.map((r) => r.id)]);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const n = (label: string) => counts.rows.find((r) => r.label === label)?.n ?? 0;
  const teamList: BrainTeam[] = teams.rows.map((t) => ({
    id: t.id,
    name: t.name,
    mission: t.mission,
    people: (t.people ?? []).filter((p) => p && p.id),
    owns: [...(t.owns ?? []), ...maintained.rows.filter((m) => m.team === t.id).map((m) => ({ kind: "station" as const, id: m.id, label: m.label, sort: null }))]
      .filter((o) => o && o.id)
      .sort((a, b) => (a.kind === b.kind ? (a.sort ?? 0) - (b.sort ?? 0) : a.kind.localeCompare(b.kind)))
      .map(({ kind, id, label }) => ({ kind, id, label })),
  }));
  return {
    counts: { people: n("Person"), teams: n("Team"), documents: n("Document"), tickets: n("Ticket"), messages: n("Message"), decisions: n("Decision") },
    teams: teamList,
    openTickets: open.rows.map((r) => byId.get(r.id)).filter((s): s is BrainSource => Boolean(s)),
    decisions: decisions.rows.map((r) => byId.get(r.id)).filter((s): s is BrainSource => Boolean(s)),
    suggestions: BRAIN_SUGGESTIONS,
  };
}
