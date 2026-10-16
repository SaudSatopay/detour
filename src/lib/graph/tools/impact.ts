import { loadNetwork } from "../../network/data";
import { DEMAND_GRAPH } from "../names";
import type { DisplacedPair } from "../flow";
import { openIncident, type Incident } from "./incident";
import { result, type ToolContext, type ToolResult } from "./types";

const MAX_DEPTH = 8;

/** Origin-destination pairs whose baseline path crosses a closed segment (shared demand graph). */
export async function displacedPairs(ctx: ToolContext, closedEids: number[]): Promise<DisplacedPair[]> {
  const res = await ctx.tracer.run<DisplacedPair>(
    "displaced riders",
    DEMAND_GRAPH,
    `MATCH (o:Station)-[d:DEMAND]->(x:Station)
     WHERE any(e IN d.via WHERE e IN $closed)
     RETURN o.id AS o, x.id AS d, d.riders AS riders, d.via AS via`,
    { closed: closedEids },
    { readOnly: true, timeoutMs: 20_000 },
  );
  return res.rows;
}

/**
 * Hops (following train direction) from every station that reaches the closed stretch within
 * MAX_DEPTH: one frontier query per hop, which stays linear where a variable-length pattern
 * would enumerate every parallel route path.
 */
async function hopsToStretch(ctx: ToolContext, incident: Incident): Promise<Map<string, number>> {
  const hops = new Map<string, number>(incident.stretch.map((id) => [id, 0]));
  let frontier = [...incident.stretch];
  for (let k = 1; k <= MAX_DEPTH && frontier.length; k++) {
    const res = await ctx.tracer.run<{ id: string }>(
      `stations ${k} stop${k > 1 ? "s" : ""} upstream`,
      ctx.sandbox,
      `MATCH (o:Station)-[:RUNS]->(t:Station)
       WHERE t.id IN $frontier AND NOT o.id IN $seen
       RETURN DISTINCT o.id AS id`,
      { frontier, seen: [...hops.keys()] },
      { readOnly: true },
    );
    frontier = res.rows.map((r) => r.id).filter((id) => !hops.has(id));
    for (const id of frontier) hops.set(id, k);
  }
  return hops;
}

export interface ImpactData {
  incidentId: string;
  totalRiders: number;
  pairs: number;
  /** Displaced riders per hour whose origin is within k hops of the closure, k = 0..MAX_DEPTH. */
  byDepth: { depth: number; riders: number; stations: number }[];
  beyondDepth: number;
  topOrigins: { id: string; name: string; riders: number; hops: number | null }[];
  topDestinations: { id: string; name: string; riders: number }[];
}

export async function affectedRiders(ctx: ToolContext, input: { depth?: number }): Promise<ToolResult<ImpactData | null>> {
  const incident = await openIncident(ctx);
  if (!incident) {
    return result(ctx, "affected_riders", "not_in_graph", "No closure is open in this sandbox. Close a line first.", null);
  }
  const network = await loadNetwork();
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  const [pairs, hops] = await Promise.all([displacedPairs(ctx, incident.closedEids), hopsToStretch(ctx, incident)]);

  const byOrigin = new Map<string, number>();
  const byDest = new Map<string, number>();
  let total = 0;
  for (const p of pairs) {
    total += p.riders;
    byOrigin.set(p.o, (byOrigin.get(p.o) ?? 0) + p.riders);
    byDest.set(p.d, (byDest.get(p.d) ?? 0) + p.riders);
  }

  const byDepth = Array.from({ length: MAX_DEPTH + 1 }, (_, depth) => {
    let riders = 0;
    let stations = 0;
    for (const [id, r] of byOrigin) {
      const h = hops.get(id);
      if (h !== undefined && h <= depth) {
        riders += r;
        stations += 1;
      }
    }
    return { depth, riders: Math.round(riders), stations };
  });
  const beyondDepth = Math.round(total - byDepth[MAX_DEPTH].riders);

  const topOrigins = [...byOrigin.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, riders]) => ({ id, name: names.get(id) ?? id, riders: Math.round(riders), hops: hops.get(id) ?? null }));
  const topDestinations = [...byDest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, riders]) => ({ id, name: names.get(id) ?? id, riders: Math.round(riders) }));

  const depth = Math.min(MAX_DEPTH, Math.max(0, input.depth ?? 4));
  const d1 = byDepth[1];
  const dk = byDepth[depth];
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  const summary =
    `${fmt(total)} riders an hour had trips crossing the closure (${pairs.length.toLocaleString("en-US")} origin-destination pairs). ` +
    `Within 1 stop of it: ${fmt(d1.riders)} riders at ${d1.stations} stations; within ${depth} stops: ${fmt(dk.riders)} at ${dk.stations} stations` +
    (beyondDepth > 0 ? `; ${fmt(beyondDepth)} more start further out.` : ".") +
    ` Largest origin: ${topOrigins[0]?.name ?? "none"} (${fmt(topOrigins[0]?.riders ?? 0)}).`;

  const depthMap: Record<string, number> = {};
  for (const [id] of byOrigin) {
    const h = hops.get(id);
    if (h !== undefined) depthMap[id] = h;
  }
  return result(
    ctx,
    "affected_riders",
    "answered",
    summary,
    { incidentId: incident.id, totalRiders: Math.round(total), pairs: pairs.length, byDepth, beyondDepth, topOrigins, topDestinations },
    { depth: depthMap, stations: topOrigins.map((o) => o.id), closedEids: incident.closedEids },
  );
}
