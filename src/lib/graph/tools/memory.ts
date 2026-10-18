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

/** Writes a finding with its validity window and provenance. A superseded finding is closed, not deleted. */
export async function remember(
  ctx: ToolContext,
  input: { text: string; kind: "observation" | "capacity" | "accessibility" | "crowding" | "plan"; stations?: string[]; routes?: string[]; confidence?: number; supersedes?: string },
): Promise<ToolResult<{ id: string; superseded: string | null }>> {
  const id = `F-${Date.now().toString(36).toUpperCase()}`;
  await ctx.tracer.run(
    "write finding",
    ctx.sandbox,
    `MATCH (ag:Agent {id: $agent})
     CREATE (ag)-[:WROTE]->(:Finding {id: $id, text: $text, kind: $kind, confidence: $confidence,
       validFromMs: timestamp(), learnedMs: timestamp()})`,
    { agent: ctx.agentId, id, text: input.text.slice(0, 400), kind: input.kind, confidence: input.confidence ?? 0.8 },
  );
  await ctx.tracer.run(
    "link finding to what it is about",
    ctx.sandbox,
    `MATCH (f:Finding {id: $id}), (n)
     WHERE (n:Station AND n.id IN $stations) OR (n:Route AND n.id IN $routes)
     CREATE (f)-[:ABOUT]->(n)`,
    { id, stations: input.stations ?? [], routes: (input.routes ?? []).map((r) => r.toUpperCase()) },
  );
  const incident = await openIncident(ctx);
  if (incident) {
    await ctx.tracer.run("link finding to the incident", ctx.sandbox, "MATCH (f:Finding {id: $id}), (i:Incident {id: $incident}) CREATE (f)-[:FROM]->(i)", {
      id,
      incident: incident.id,
    });
  }
  let superseded: string | null = null;
  if (input.supersedes) {
    const res = await ctx.tracer.run<{ old: string }>(
      "close the superseded finding",
      ctx.sandbox,
      `MATCH (old:Finding {id: $old}), (f:Finding {id: $id})
       WHERE old.validToMs IS NULL
       SET old.validToMs = timestamp()
       CREATE (f)-[:SUPERSEDES]->(old)
       RETURN old.id AS old`,
      { old: input.supersedes, id },
    );
    superseded = res.rows[0]?.old ?? null;
  }
  return result(
    ctx,
    "remember",
    "answered",
    `Remembered ${id}${superseded ? `, closing ${superseded}` : ""}: ${input.text.slice(0, 160)}`,
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
  input: { station: string; stationName: string; route: string; working: boolean },
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
  const working = current.rows.find((f) => f.kind !== "accessibility");
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
    supersedes: input.working ? outage?.id : working?.id,
  });
  // Keep the agency's records current with the report: the platform's maintenance ticket resolves (or
  // reopens), the new fact cites it, and decisions that rested on it are lifted (or back in force).
  // Graphs without the agency layer have no tickets, so nothing changes there.
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
