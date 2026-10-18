import type { BrainIntake, BrainSource, IntakeKind } from "../brain/types";
import { loadNetwork } from "../network/data";
import { ORG_PEOPLE } from "./seed-org";
import type { CypherTrace } from "./trace";
import { routesIn, sourcesFor } from "./tools/brain";
import { reportElevator } from "./tools/memory";
import { result, type ToolContext, type ToolResult } from "./tools/types";

/**
 * Adds a chat message, ticket or note to the brain. The text is linked to the stations, lines and people it
 * names; an elevator or escalator outage files a ticket with the team that maintains the station (or joins
 * the open one) and writes the outage to memory, so step-free routes change; a report that it works again
 * resolves the ticket and lifts the decisions that rested on it.
 */

export interface Mentions {
  stations: { id: string; name: string; routes: string[] }[];
  routes: string[];
  /** Org people named in the text, by person id. */
  people: string[];
  outage: "elevator" | "escalator" | null;
  restored: boolean;
}

type StationRef = { id: string; name: string; routes: string[] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STREET_TYPE = /\s+(avs?|sts?|blvd|pkwy|rd|sq|pl|ctr)$/i;

/**
 * Every way a station is written: its full name, the name without its street type ("Myrtle-Wyckoff"), and long
 * parts of a compound name ("Metropolitan", "Lorimer St"). A key several stations share is resolved by the line
 * the text names, or not at all.
 */
function stationKeys(stations: StationRef[]): Map<string, StationRef[]> {
  const keys = new Map<string, StationRef[]>();
  const add = (key: string, s: StationRef) => {
    const k = key.toLowerCase().trim();
    const list = keys.get(k) ?? [];
    if (!list.some((x) => x.id === s.id)) list.push(s);
    keys.set(k, list);
  };
  for (const s of stations) {
    const variants = new Set<string>([s.name]);
    const bare = s.name.replace(STREET_TYPE, "");
    if (bare.length >= 8) variants.add(bare);
    for (const part of s.name.split(/[-/]/).map((x) => x.trim())) {
      if (part.length >= 8) variants.add(part);
      const partBare = part.replace(STREET_TYPE, "");
      if (partBare.length >= 8) variants.add(partBare);
    }
    for (const v of variants) add(v, s);
  }
  return keys;
}

const OUTAGE = /\b(elevator|escalator)s?\b[^.!?]{0,60}?\b(out of service|out of order|broken|broke down|down|not working|stuck|failed|outage)\b|\b(out of service|out of order|broken|not working|stuck)\b[^.!?]{0,40}?\b(elevator|escalator)s?\b/i;
const RESTORED = /\b(back in service|working again|is fixed|was fixed|been fixed|fixed now|restored|repaired|back up)\b/i;

/** What a piece of text names: stations (longest match wins), lines, org people, and an outage or a fix. */
export function extractMentions(text: string, stations: StationRef[], routeIds: string[], people: { id: string; name: string }[]): Mentions {
  const lower = text.toLowerCase().replace(/[‐-―]/g, "-");
  const routes = routesIn(text.replace(/[‐-―]/g, "-"), routeIds);
  const found: { start: number; end: number; refs: StationRef[] }[] = [];
  for (const [key, refs] of stationKeys(stations)) {
    const re = new RegExp(`(^|[^a-z0-9])(${escape(key)})(?=$|[^a-z0-9])`, "g");
    for (const m of lower.matchAll(re)) {
      const start = (m.index ?? 0) + m[1].length;
      found.push({ start, end: start + m[2].length, refs });
    }
  }
  // Longest first; a match inside a longer one ("14 St" in "14 St-Union Sq") does not count.
  found.sort((a, b) => b.end - b.start - (a.end - a.start));
  const taken: { start: number; end: number }[] = [];
  const picked = new Map<string, StationRef>();
  for (const f of found) {
    if (taken.some((t) => f.start < t.end && t.start < f.end)) continue;
    taken.push(f);
    const onRoute = f.refs.filter((r) => r.routes.some((x) => routes.includes(x)));
    const choice = f.refs.length === 1 ? f.refs[0] : onRoute.length === 1 ? onRoute[0] : null;
    if (choice) picked.set(choice.id, choice);
  }
  const named = people.filter((p) => {
    const first = p.name.split(" ")[0];
    const firstUnique = people.filter((q) => q.name.split(" ")[0] === first).length === 1;
    return new RegExp(`\\b${escape(p.name)}\\b`, "i").test(text) || (firstUnique && new RegExp(`\\b${escape(first)}\\b`).test(text));
  });
  const outage = text.match(OUTAGE);
  const device = outage ? ((outage[1] ?? outage[4] ?? "elevator").toLowerCase() as "elevator" | "escalator") : null;
  const restored = RESTORED.test(text);
  return { stations: [...picked.values()], routes, people: named.map((p) => p.id), outage: restored ? null : device, restored };
}

/** The platform a report is about: the line it names that the station serves, or the station's only line. */
export function platformRoute(station: StationRef, routes: string[]): string | null {
  const named = routes.filter((r) => station.routes.includes(r));
  if (named.length === 1) return named[0];
  return station.routes.length === 1 ? station.routes[0] : null;
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}`;

export async function ingest(ctx: ToolContext, given: { kind: IntakeKind; text: string }): Promise<ToolResult<BrainIntake>> {
  const text = given.text.trim().slice(0, 1200);
  const network = await loadNetwork();
  const people = ORG_PEOPLE.map((p) => ({ id: p.id, name: p.name }));
  const m = extractMentions(
    text,
    network.stations.map((s) => ({ id: s.id, name: s.name, routes: s.routes })),
    network.routes.map((r) => r.id),
    people,
  );
  // A "ticket" saying something works again is news about an existing ticket, so it is posted as a message.
  const input = { kind: given.kind === "ticket" && m.restored ? ("message" as const) : given.kind };
  const traces: CypherTrace[] = [];
  const flush = () => traces.push(...ctx.tracer.traces.splice(0));
  const station = m.stations[0] ?? null;
  const route = station ? platformRoute(station, m.routes) : null;
  const title = text.split(/(?<=[.!?])\s/)[0].slice(0, 90);

  await ctx.tracer.run(
    "you, on the Rail Control Center desk",
    ctx.sandbox,
    `MERGE (p:Person {id: 'P-YOU'}) ON CREATE SET p.name = 'You', p.role = 'Dispatcher on duty'
     WITH p MATCH (t:Team {id: 'RCC'}) MERGE (p)-[:MEMBER_OF]->(t)`,
  );

  // A ticket typed in is the node itself; a chat message or note is its own node and may file a ticket.
  let nodeId: string;
  if (input.kind === "message") {
    nodeId = newId("MSG");
    await ctx.tracer.run(
      "post the chat message",
      ctx.sandbox,
      "MATCH (p:Person {id: 'P-YOU'}) CREATE (p)-[:POSTED]->(:Message {id: $id, channel: '#intake', text: $text, atMs: timestamp()})",
      { id: nodeId, text },
    );
  } else if (input.kind === "note") {
    nodeId = newId("DOC-NOTE");
    await ctx.tracer.run(
      "write the note",
      ctx.sandbox,
      "MATCH (p:Person {id: 'P-YOU'}) CREATE (p)-[:AUTHORED]->(:Document {id: $id, kind: 'note', title: $title, text: $text, createdMs: timestamp()})",
      { id: nodeId, title, text },
    );
  } else {
    nodeId = "";
  }

  // Who should do the work: elevators and escalators go to the maintenance team, anything else to the line's
  // planners, and with no line named, to the control center. The lead (or senior) person on the team takes it.
  type Owner = { id: string; name: string; role: string; team: string };
  const device = m.outage ?? (/escalator/i.test(text) ? "escalator" : /elevator/i.test(text) ? "elevator" : null);
  const LEAD =
    "ORDER BY CASE WHEN toLower(p.role) CONTAINS 'lead' OR toLower(p.role) CONTAINS 'senior' OR toLower(p.role) CONTAINS 'superintendent' THEN 0 ELSE 1 END, p.name LIMIT 1";
  const PICK = "RETURN p.id AS id, p.name AS name, p.role AS role, t.name AS team";
  const ownerOf = async (label: string, cypher: string, params: Record<string, string> = {}) =>
    (await ctx.tracer.run<Owner>(label, ctx.sandbox, `${cypher} ${PICK} ${LEAD}`, params, { readOnly: true })).rows[0] ?? null;
  const lineRoute = route ?? m.routes[0] ?? null;
  const owner = device
    ? await ownerOf("who maintains elevators and escalators", "MATCH (t:Team {id: 'EE'})<-[:MEMBER_OF]-(p:Person)")
    : lineRoute
      ? await ownerOf("who plans the line", "MATCH (t:Team)-[:OWNS]->(:Route {id: $route}) MATCH (p:Person)-[:MEMBER_OF]->(t)", { route: lineRoute })
      : await ownerOf("who runs the control center", "MATCH (t:Team {id: 'RCC'})<-[:MEMBER_OF]-(p:Person) WHERE p.id <> 'P-YOU'");

  let ticket: BrainIntake["ticket"] = null;
  let finding: BrainIntake["finding"] = null;

  if ((m.outage || input.kind === "ticket") && !m.restored) {
    const existing = station
      ? await ctx.tracer.run<{ id: string; title: string; assignee: string | null; role: string | null; team: string | null }>(
          "an open ticket for the same platform",
          ctx.sandbox,
          `MATCH (k:Ticket {status: 'open', station: $station})
           WHERE $route = '' OR k.route = $route
           OPTIONAL MATCH (k)-[:ASSIGNED_TO]->(a:Person)
           OPTIONAL MATCH (a)-[:MEMBER_OF]->(t:Team)
           RETURN k.id AS id, k.title AS title, a.name AS assignee, a.role AS role, t.name AS team
           ORDER BY k.openedMs DESC LIMIT 1`,
          { station: station.id, route: route ?? "" },
          { readOnly: true },
        )
      : { rows: [] as { id: string; title: string; assignee: string | null; role: string | null; team: string | null }[] };
    const open = existing.rows[0];
    if (open && nodeId) {
      await ctx.tracer.run("add the report to the open ticket", ctx.sandbox, "MATCH (k:Ticket {id: $ticket}), (x {id: $node}) CREATE (k)-[:SOURCED_FROM]->(x)", {
        ticket: open.id,
        node: nodeId,
      });
      ticket = { ...open, created: false };
    } else if (!open) {
      const next = await ctx.tracer.run<{ n: number | null }>(
        "the next ticket number",
        ctx.sandbox,
        "MATCH (k:Ticket) WHERE k.id STARTS WITH 'EE-' RETURN max(toInteger(substring(k.id, 3))) AS n",
        {},
        { readOnly: true },
      );
      const ticketId = device ? `EE-${(next.rows[0]?.n ?? 1207) + 1}` : newId("TKT");
      const ticketTitle = device && station ? `${station.name}: ${route ? `${route} platform ` : ""}${device} out of service` : title;
      await ctx.tracer.run(
        "file the ticket with its owner",
        ctx.sandbox,
        `MATCH (you:Person {id: 'P-YOU'})
         CREATE (you)-[:FILED]->(k:Ticket {id: $id, title: $title, text: $text, station: $station, route: $route, status: 'open', openedMs: timestamp()})
         WITH k
         OPTIONAL MATCH (a:Person {id: $assignee})
         FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | CREATE (k)-[:ASSIGNED_TO]->(a))`,
        { id: ticketId, title: ticketTitle, text, station: station?.id ?? "", route: route ?? "", assignee: owner?.id ?? "" },
      );
      if (nodeId) {
        await ctx.tracer.run("link the ticket to the report", ctx.sandbox, "MATCH (k:Ticket {id: $ticket}), (x {id: $node}) CREATE (k)-[:SOURCED_FROM]->(x)", {
          ticket: ticketId,
          node: nodeId,
        });
      } else {
        nodeId = ticketId;
      }
      ticket = { id: ticketId, title: ticketTitle, assignee: owner?.name ?? null, role: owner?.role ?? null, team: owner?.team ?? null, created: true };
    } else {
      ticket = { ...open, created: false };
      nodeId = open.id;
    }
  }

  // Links: what the new node and any new ticket are about.
  const linked = [...new Set([nodeId, ticket?.created ? ticket.id : ""].filter(Boolean))];
  await ctx.tracer.run(
    "link it to the stations, lines and people it names",
    ctx.sandbox,
    `UNWIND $ids AS xid
     MATCH (x {id: xid}), (n)
     WHERE (x:Message OR x:Document OR x:Ticket)
       AND ((n:Station AND n.id IN $stations) OR (n:Route AND n.id IN $routes) OR (n:Person AND n.id IN $people))
     MERGE (x)-[:MENTIONS]->(n)`,
    { ids: linked, stations: m.stations.map((s) => s.id), routes: m.routes, people: m.people },
  );

  // Memory: an outage on a known platform changes step-free routes; a fix resolves the ticket and lifts decisions.
  if (station && route && (m.outage === "elevator" || m.restored)) {
    flush();
    const fr = await reportElevator(ctx, { station: station.id, stationName: station.name, route, working: m.restored, syncTicket: m.restored });
    traces.push(...fr.trace);
    const written = fr.data;
    if (written) {
      finding = { id: written.id, text: m.restored ? `Elevator to the ${route} platform at ${station.name} back in service.` : `Elevator to the ${route} platform at ${station.name} out of service again.` };
      await ctx.tracer.run("the report is the new fact's source", ctx.sandbox, "MATCH (f:Finding {id: $f}), (x {id: $node}) CREATE (f)-[:SOURCED_FROM]->(x)", {
        f: written.id,
        node: nodeId,
      });
    }
    if (m.restored) {
      const resolved = await ctx.tracer.run<{ id: string; title: string; assignee: string | null; role: string | null; team: string | null }>(
        "the platform's ticket after the fix",
        ctx.sandbox,
        `MATCH (k:Ticket {station: $station, route: $route})
         OPTIONAL MATCH (k)-[:ASSIGNED_TO]->(a:Person)
         OPTIONAL MATCH (a)-[:MEMBER_OF]->(t:Team)
         RETURN k.id AS id, k.title AS title, a.name AS assignee, a.role AS role, t.name AS team
         ORDER BY coalesce(k.resolvedMs, 0) DESC LIMIT 1`,
        { station: station.id, route },
        { readOnly: true },
      );
      if (resolved.rows[0] && written) ticket = { ...resolved.rows[0], created: false };
    }
  }
  flush();

  const sources: BrainSource[] = await sourcesFor(ctx, [nodeId, ticket?.id ?? "", finding?.id ?? ""].filter(Boolean));
  flush();

  const where = [...m.stations.map((s) => s.name), ...m.routes.map((r) => `the ${r}`)];
  const who = m.people.map((id) => people.find((p) => p.id === id)?.name).filter(Boolean) as string[];
  const parts = [
    `Added ${input.kind === "message" ? "a chat message" : input.kind === "note" ? "a note" : "a ticket"} ${nodeId}${where.length ? `, linked to ${where.join(", ")}` : ", linked to nothing the graph knows by name"}${who.length ? ` and ${who.join(", ")}` : ""}.`,
    ticket
      ? m.restored
        ? `Ticket ${ticket.id} is resolved and the decisions that rested on it are lifted.`
        : ticket.created
          ? `Filed ticket ${ticket.id} with ${ticket.assignee ?? "nobody"}${ticket.team ? ` (${ticket.team})` : ""}.`
          : `Ticket ${ticket.id} was already open with ${ticket.assignee ?? "nobody"}; the report is added to it.`
      : "",
    finding ? `Memory ${m.restored ? "closed the outage" : "now has the outage, so step-free routes avoid that platform"} (${finding.id}).` : "",
  ].filter(Boolean);

  const data: BrainIntake = {
    kind: input.kind,
    id: nodeId,
    summary: parts.join(" "),
    stations: m.stations.map(({ id, name }) => ({ id, name })),
    routes: m.routes,
    people: who,
    ticket,
    finding,
    sources,
    steps: [],
  };
  const r = result(ctx, "add_knowledge", "answered", data.summary, data);
  r.trace = [...traces, ...r.trace];
  data.steps = [{ tool: "add_knowledge", outcome: "answered", summary: data.summary, trace: r.trace }];
  return r;
}
