import { openIncident } from "./incident";
import { result, type ToolContext, type ToolResult } from "./types";

export interface RememberedFinding {
  id: string;
  text: string;
  kind: string;
  confidence: number;
  validFromMs: number;
  validToMs: number | null;
  example: boolean | null;
  incident: string | null;
  agent: string | null;
}

export interface RememberedIncident {
  id: string;
  title: string;
  openedMs: number;
  example: boolean | null;
  shuttles: { from: string; to: string; bph: number; planned: number; observed: number }[];
}

export interface RecallData {
  findings: RememberedFinding[];
  incidents: RememberedIncident[];
  playbooks: RememberedPlaybook[];
}

export interface RememberedPlaybook {
  id: string;
  title: string;
  steps: string[];
  uses: number;
  lastUsedMs: number;
}

const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

/** Reads what earlier sessions learned about these stations and routes, before any traversal. */
export async function recall(
  ctx: ToolContext,
  input: { stations?: string[]; routes?: string[] },
): Promise<ToolResult<RecallData>> {
  const stations = input.stations ?? [];
  const routes = (input.routes ?? []).map((r) => r.toUpperCase());

  const findings = await ctx.tracer.run<RememberedFinding>(
    "findings about these stations and routes",
    ctx.sandbox,
    `MATCH (f:Finding)-[:ABOUT]->(n)
     WHERE (n:Station AND n.id IN $stations) OR (n:Route AND n.id IN $routes)
     WITH DISTINCT f
     OPTIONAL MATCH (f)-[:FROM]->(i:Incident)
     OPTIONAL MATCH (ag:Agent)-[:WROTE]->(f)
     RETURN f.id AS id, f.text AS text, f.kind AS kind, f.confidence AS confidence, f.validFromMs AS validFromMs,
            f.validToMs AS validToMs, f.example AS example, i.id AS incident, ag.name AS agent
     ORDER BY validFromMs DESC LIMIT 12`,
    { stations, routes },
    { readOnly: true },
  );
  const incidents = await ctx.tracer.run<RememberedIncident>(
    "past incidents on these routes",
    ctx.sandbox,
    `MATCH (i:Incident)
     WHERE i.status <> 'open' AND any(r IN i.routes WHERE r IN $routes)
     OPTIONAL MATCH (s:Shuttle)-[:FOR]->(i)
     OPTIONAL MATCH (s)-[:FROM]->(a:Station)
     OPTIONAL MATCH (s)-[:TO]->(b:Station)
     WITH i, collect(CASE WHEN s IS NULL THEN null ELSE {from: a.name, to: b.name, bph: s.busesPerHour, planned: s.planned, observed: s.observed} END) AS shuttles
     RETURN i.id AS id, i.title AS title, i.openedMs AS openedMs, i.example AS example, shuttles
     ORDER BY openedMs DESC LIMIT 5`,
    { routes },
    { readOnly: true },
  );
  const playbooks = await ctx.tracer.run<RememberedPlaybook>(
    "playbooks for these routes",
    ctx.sandbox,
    `MATCH (p:Playbook)-[:FOR]->(r:Route) WHERE r.id IN $routes
     RETURN DISTINCT p.id AS id, p.title AS title, p.steps AS steps, p.uses AS uses, p.lastUsedMs AS lastUsedMs`,
    { routes },
    { readOnly: true },
  );

  const f = findings.rows;
  const inc = incidents.rows.map((i) => ({ ...i, shuttles: (i.shuttles ?? []).filter(Boolean) }));
  const pb = playbooks.rows;
  if (!f.length && !inc.length && !pb.length) {
    return result(ctx, "recall", "not_in_graph", "Nothing remembered about these stations or routes yet.", { findings: [], incidents: [], playbooks: [] });
  }
  const current = f.filter((x) => x.validToMs === null || x.validToMs === undefined);
  const closed = f.filter((x) => x.validToMs !== null && x.validToMs !== undefined);
  const parts = [
    ...current.slice(0, 4).map((x) => `Since ${day(x.validFromMs)}: ${x.text}`),
    ...closed.slice(0, 2).map((x) => `No longer true (${day(x.validFromMs)} to ${day(x.validToMs!)}): ${x.text}`),
    ...inc.slice(0, 2).map(
      (i) =>
        `${i.id} on ${day(i.openedMs)} (${i.title})${i.shuttles.length ? `: ${i.shuttles.map((s) => `${s.from} ↔ ${s.to} planned ${s.planned.toLocaleString("en-US")}, carried ${s.observed.toLocaleString("en-US")} riders an hour`).join("; ")}` : ""}`,
    ),
    ...pb.slice(0, 1).map((p) => `Playbook "${p.title}" used ${p.uses === 1 ? "once" : `${p.uses} times`}: ${p.steps.join(" ")}`),
  ];
  return result(ctx, "recall", "memory", parts.join(" | "), { findings: f, incidents: inc, playbooks: pb });
}

/**
 * What the next shuttle plan on these routes sizes buses at: the lowest share of plan any recalled shuttle
 * carried, when it fell short (under 97%). The scripted controller applies the same rule to recall's data.
 */
export function shuttleShare(incidents: RememberedIncident[]): { ratio: number; incident: string; from: string; to: string; openedMs: number } | null {
  let worst: { ratio: number; incident: string; from: string; to: string; openedMs: number } | null = null;
  for (const inc of incidents) {
    for (const s of inc.shuttles) {
      if (!s.planned || !s.observed) continue;
      const ratio = s.observed / s.planned;
      if (!worst || ratio < worst.ratio) worst = { ratio, incident: inc.id, from: s.from, to: s.to, openedMs: inc.openedMs };
    }
  }
  return worst && worst.ratio < 0.97 ? worst : null;
}

/**
 * Whether a new finding is about the open incident, and so gets a FROM link to it: it names one of the
 * closed routes, or a station in the closed stretch. A caller can decide instead (`explicit`), or ask for
 * stations alone ("stations"): a platform elevator is about a closure only when it is in the closed stretch.
 */
export function concernsIncident(
  finding: { stations?: string[]; routes?: string[] },
  incident: { routes: string[]; stretch: string[] } | null,
  explicit?: boolean | "stations",
): boolean {
  if (!incident) return false;
  if (typeof explicit === "boolean") return explicit;
  const stretch = new Set(incident.stretch);
  const atStretch = (finding.stations ?? []).some((s) => stretch.has(s));
  if (explicit === "stations") return atStretch;
  const routes = new Set(incident.routes.map((r) => r.toUpperCase()));
  return atStretch || (finding.routes ?? []).some((r) => routes.has(r.toUpperCase()));
}

/** Finding ids stay unique when many writers report in the same millisecond. */
export function findingId(now = Date.now(), random = Math.random()): string {
  const tail = Math.floor(random * 36 ** 3)
    .toString(36)
    .padStart(3, "0");
  return `F-${now.toString(36)}${tail}`.toUpperCase();
}

/** One platform elevator's facts: at most one of them is open at a time. */
interface Slot {
  station: string;
  route: string;
  prefix: string;
}

type FindingKind = "observation" | "capacity" | "accessibility" | "crowding" | "plan";

/**
 * Writes a finding with its validity window and provenance. A superseded finding is closed, not deleted.
 * Writing the finding and closing what it supersedes is one query, and FalkorDB runs one write at a time
 * per graph, so two reports at once cannot both supersede the same fact and leave two open: a finding
 * that would supersede a fact another report already closed is not written.
 */
export async function remember(
  ctx: ToolContext,
  input: {
    text: string;
    kind: FindingKind;
    stations?: string[];
    routes?: string[];
    confidence?: number;
    supersedes?: string;
    /** Link to the open incident regardless of what the finding names (true or false), or by its stations alone. */
    aboutIncident?: boolean | "stations";
    /** Replace the platform's current elevator fact, unless it already says the same (see reportElevator). */
    slot?: Slot;
  },
): Promise<ToolResult<{ id: string; superseded: string | null }>> {
  const id = findingId();
  const stations = input.stations ?? [];
  const routes = (input.routes ?? []).map((r) => r.toUpperCase());
  const incident = await openIncident(ctx);
  const link = concernsIncident({ stations, routes }, incident, input.aboutIncident);

  // What the new finding replaces, matched inside the write so the check and the write cannot interleave.
  const current = input.slot
    ? `OPTIONAL MATCH (cur:Finding)-[:ABOUT]->(:Station {id: $slotStation}), (cur)-[:ABOUT]->(:Route {id: $slotRoute})
     WHERE cur.validToMs IS NULL AND cur.text STARTS WITH $slotPrefix
     WITH ag, collect(DISTINCT cur) AS current
     WHERE none(c IN current WHERE c.kind = $kind)`
    : input.supersedes
      ? `OPTIONAL MATCH (old:Finding {id: $old})
     WITH ag, old
     WHERE old IS NULL OR old.validToMs IS NULL
     WITH ag, CASE WHEN old IS NULL THEN [] ELSE [old] END AS current`
      : "WITH ag, [] AS current";
  const res = await ctx.tracer.run<{ id: string; superseded: string[] }>(
    input.supersedes || input.slot ? "write finding and close the one it supersedes" : "write finding",
    ctx.sandbox,
    `MATCH (ag:Agent {id: $agent})
     ${current}
     CREATE (ag)-[:WROTE]->(f:Finding {id: $id, text: $text, kind: $kind, confidence: $confidence,
       validFromMs: timestamp(), learnedMs: timestamp()})
     FOREACH (c IN current | SET c.validToMs = timestamp() CREATE (f)-[:SUPERSEDES]->(c))
     WITH f, [c IN current | c.id] AS superseded
     OPTIONAL MATCH (n) WHERE (n:Station AND n.id IN $stations) OR (n:Route AND n.id IN $routes)
     WITH f, superseded, collect(n) AS about
     FOREACH (x IN about | CREATE (f)-[:ABOUT]->(x))
     WITH f, superseded
     OPTIONAL MATCH (i:Incident {id: $incident})
     FOREACH (_ IN CASE WHEN i IS NULL THEN [] ELSE [1] END | CREATE (f)-[:FROM]->(i))
     RETURN f.id AS id, superseded`,
    {
      agent: ctx.agentId,
      id,
      text: input.text.slice(0, 400),
      kind: input.kind,
      confidence: input.confidence ?? 0.8,
      stations,
      routes,
      incident: link && incident ? incident.id : "",
      old: input.supersedes ?? null,
      slotStation: input.slot?.station ?? null,
      slotRoute: input.slot?.route ?? null,
      slotPrefix: input.slot?.prefix ?? null,
    },
  );
  const row = res.rows[0];
  if (!row) {
    const why = input.slot ? "Memory already holds this as the current fact" : `${input.supersedes} was already superseded by another report`;
    return result(ctx, "remember", "memory", `${why}; nothing new was written.`, { id: "", superseded: null });
  }
  const superseded = row.superseded?.[0] ?? null;
  return result(
    ctx,
    "remember",
    "answered",
    `Remembered ${id}${superseded ? `, closing ${superseded}` : ""}${link && incident ? `, from ${incident.id}` : ""}: ${input.text.slice(0, 160)}`,
    { id, superseded },
  );
}

/**
 * A rider-desk report that a platform elevator works again (or broke again). The current fact is
 * superseded, not deleted: route_rider reads only facts with no end date, so the next route changes,
 * and the old fact stays queryable with its validity window.
 */
export async function reportElevator(
  ctx: ToolContext,
  input: { station: string; stationName: string; route: string; working: boolean; syncTicket?: boolean },
): Promise<ToolResult<{ id: string; superseded: string | null } | null>> {
  const current = await ctx.tracer.run<{ id: string; kind: string; text: string }>(
    "current elevator facts for this platform",
    ctx.sandbox,
    `MATCH (f:Finding)-[:ABOUT]->(:Station {id: $station}), (f)-[:ABOUT]->(:Route {id: $route})
     WHERE f.validToMs IS NULL AND f.text STARTS WITH 'Elevator'
     RETURN f.id AS id, f.kind AS kind, f.text AS text
     ORDER BY f.validFromMs DESC`,
    { station: input.station, route: input.route },
    { readOnly: true },
  );
  const outage = current.rows.find((f) => f.kind === "accessibility");
  if (input.working && !outage) {
    return result(ctx, "remember", "not_in_graph", `Memory has no current elevator outage on the ${input.route} platform at ${input.stationName}.`, null);
  }
  if (!input.working && outage) {
    return result(ctx, "remember", "memory", `Memory already says the ${input.route} platform elevator at ${input.stationName} is out: ${outage.text}`, null);
  }
  const written = await remember(ctx, {
    text: input.working
      ? `Elevator to the ${input.route} platform at ${input.stationName} back in service.`
      : `Elevator to the ${input.route} platform at ${input.stationName} out of service again.`,
    kind: input.working ? "observation" : "accessibility",
    stations: [input.station],
    routes: [input.route],
    confidence: 1,
    // A platform elevator concerns a closure only when the platform is in the closed stretch.
    aboutIncident: "stations",
    // Closes whichever elevator fact is current when the write runs, so simultaneous reports leave one open.
    slot: { station: input.station, route: input.route, prefix: "Elevator" },
  });
  // Another report got there first and memory already says this: nothing to sync.
  if (!written.data.id) return written;
  // Keep the agency's records current with the report: the platform's maintenance ticket resolves (or
  // reopens), the new fact cites it, and decisions that rested on it are lifted (or back in force).
  // Graphs without the agency layer have no tickets, so nothing changes there. The intake files its own tickets.
  if (input.syncTicket === false) {
    written.trace.push(...ctx.tracer.traces.splice(0));
    return written;
  }
  const ticket = await ctx.tracer.run<{ id: string }>(
    input.working ? "resolve the platform's elevator ticket" : "reopen the platform's elevator ticket",
    ctx.sandbox,
    `MATCH (k:Ticket {station: $station, route: $route, status: $from})
     WITH k ORDER BY k.openedMs DESC LIMIT 1
     SET k.status = $to, k.resolvedMs = CASE WHEN $working THEN timestamp() ELSE null END
     WITH k
     MATCH (f:Finding {id: $finding})
     CREATE (f)-[:SOURCED_FROM]->(k)
     RETURN k.id AS id`,
    {
      station: input.station,
      route: input.route,
      working: input.working,
      from: input.working ? "open" : "resolved",
      to: input.working ? "resolved" : "open",
      finding: written.data.id,
    },
  );
  const ticketId = ticket.rows[0]?.id;
  if (ticketId) {
    await ctx.tracer.run(
      input.working ? "lift decisions that rested on the ticket" : "put those decisions back in force",
      ctx.sandbox,
      `MATCH (d:Decision {status: $from, until: $ticket})
       SET d.status = $to, d.liftedMs = CASE WHEN $working THEN timestamp() ELSE null END`,
      { ticket: ticketId, working: input.working, from: input.working ? "in force" : "lifted", to: input.working ? "lifted" : "in force" },
    );
    written.trace.push(...ctx.tracer.traces.splice(0));
    written.summary += ` Ticket ${ticketId} ${input.working ? "resolved" : "reopened"}.`;
  } else {
    written.trace.push(...ctx.tracer.traces.splice(0));
  }
  // remember() returns every query this context ran, the lookup first.
  return written;
}
