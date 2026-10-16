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
        `${i.id} on ${day(i.openedMs)} (${i.title})${i.shuttles.length ? `: ${i.shuttles.map((s) => `${s.from} ↔ ${s.to} planned ${s.planned}, carried ${s.observed}`).join("; ")}` : ""}`,
    ),
    ...pb.slice(0, 1).map((p) => `Playbook "${p.title}" used ${p.uses} time(s): ${p.steps.join(" ")}`),
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
