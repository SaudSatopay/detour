import { loadNetwork } from "../../network/data";
import { stretchBetween } from "../../network/stretch";
import { result, type ToolContext, type ToolResult } from "./types";

export interface Incident {
  id: string;
  title: string;
  report: string;
  routes: string[];
  stretch: string[];
  closedEids: number[];
  status: string;
  openedMs: number;
}

/** Marks a closed RUNS edge so weighted shortest paths never use it; capacity becomes zero. */
export const CLOSED_MINUTES = 100_000;

export async function openIncident(ctx: ToolContext): Promise<Incident | null> {
  const res = await ctx.tracer.run<Incident>(
    "open incident",
    ctx.sandbox,
    `MATCH (i:Incident {status: 'open'})
     RETURN i.id AS id, i.title AS title, i.report AS report, i.routes AS routes, i.stretch AS stretch,
            i.closedEids AS closedEids, i.status AS status, i.openedMs AS openedMs
     ORDER BY i.openedMs DESC LIMIT 1`,
    {},
    { readOnly: true },
  );
  return res.rows[0] ?? null;
}

/** Restores every closed segment and marks open incidents resolved (used before a new closure and on reset). */
export async function reopenAll(ctx: ToolContext, status: "resolved" | "superseded"): Promise<number> {
  const res = await ctx.tracer.run<{ n: number }>(
    "reopen closed segments",
    ctx.sandbox,
    `MATCH ()-[r:RUNS {closed: true}]->()
     SET r.closed = false, r.minutes = r.baseMinutes,
         r.spare = CASE WHEN r.capacity > r.load THEN r.capacity - r.load ELSE 0 END
     RETURN count(r) AS n`,
  );
  await ctx.tracer.run(
    "close out incident",
    ctx.sandbox,
    "MATCH (i:Incident {status: 'open'}) SET i.status = $status, i.closedMs = timestamp()",
    { status },
  );
  return res.rows[0]?.n ?? 0;
}

export async function closeLine(
  ctx: ToolContext,
  input: { routes: string[]; fromStation: string; toStation: string; report: string; title?: string },
): Promise<ToolResult<{ incident: Incident | null; closed: { eid: number; route: string; from: string; to: string; load: number }[]; peakLoad: number }>> {
  const network = await loadNetwork();
  const routes = [...new Set(input.routes.map((r) => r.toUpperCase()))];
  const unknownRoutes = routes.filter((r) => !network.routes.some((x) => x.id === r));
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  if (unknownRoutes.length || !names.has(input.fromStation) || !names.has(input.toStation)) {
    const missing = [
      ...unknownRoutes.map((r) => `route "${r}"`),
      ...[input.fromStation, input.toStation].filter((s) => !names.has(s)).map((s) => `station id "${s}"`),
    ];
    return result(ctx, "close_line", "unknown_entity", `Not in the graph: ${missing.join(", ")}. Resolve names first.`, {
      incident: null,
      closed: [],
      peakLoad: 0,
    });
  }

  const stretch = stretchBetween(network, routes, input.fromStation, input.toStation);
  if (!stretch) {
    return result(
      ctx,
      "close_line",
      "not_in_graph",
      `No scheduled ${routes.join("/")} pattern runs between ${names.get(input.fromStation)} and ${names.get(input.toStation)}, so there is no stretch to close.`,
      { incident: null, closed: [], peakLoad: 0 },
    );
  }

  await reopenAll(ctx, "superseded");
  const closedRes = await ctx.tracer.run<{ eid: number; route: string; from: string; to: string; load: number }>(
    "close segments",
    ctx.sandbox,
    `MATCH (a:Station)-[r:RUNS]->(b:Station)
     WHERE r.route IN $routes AND a.id IN $stretch AND b.id IN $stretch
     SET r.closed = true, r.minutes = $closedMinutes, r.spare = 0
     RETURN r.eid AS eid, r.route AS route, a.id AS from, b.id AS to, r.load AS load
     ORDER BY eid`,
    { routes, stretch, closedMinutes: CLOSED_MINUTES },
  );
  const closed = closedRes.rows;
  const id = `INC-${Date.now().toString(36).toUpperCase()}`;
  const title = input.title?.trim() || `${routes.join("/")}: ${names.get(stretch[0])} to ${names.get(stretch[stretch.length - 1])}`;
  await ctx.tracer.run(
    "record incident",
    ctx.sandbox,
    `MATCH (ag:Agent {id: $agent})
     CREATE (ag)-[:OPENED {atMs: timestamp()}]->(i:Incident {id: $id, title: $title, report: $report, routes: $routes,
       stretch: $stretch, closedEids: $closedEids, status: 'open', openedMs: timestamp()})
     WITH i
     MATCH (s:Station) WHERE s.id IN $stretch
     CREATE (i)-[:CLOSES]->(s)`,
    { agent: ctx.agentId, id, title, report: input.report, routes, stretch, closedEids: closed.map((c) => c.eid) },
  );

  const peakLoad = closed.reduce((max, c) => Math.max(max, c.load), 0);
  const incident: Incident = {
    id,
    title,
    report: input.report,
    routes,
    stretch,
    closedEids: closed.map((c) => c.eid),
    status: "open",
    openedMs: Date.now(),
  };
  const summary = `Opened ${id}. Closed ${closed.length} ${routes.join("/")} segments across ${stretch.length} stations (${stretch
    .map((s) => names.get(s))
    .join(" → ")}). At 8 a.m. the busiest closed segment carried ${Math.round(peakLoad).toLocaleString("en-US")} riders an hour.`;
  return result(ctx, "close_line", "answered", summary, { incident, closed, peakLoad }, { stations: stretch, closedEids: incident.closedEids });
}
