import { loadNetwork } from "../../network/data";
import { CLOSED_MINUTES, openIncident } from "./incident";
import { result, type ToolContext, type ToolResult } from "./types";

export interface RiderProfile {
  id: string;
  name: string;
  persona: string;
  departs: string;
  stepFree: boolean;
  from: string;
  to: string;
  usualEids: number[];
  usualStations: string[];
  usualMinutes: number;
  preferences: { key: string; value: string; sinceMs: number }[];
}

export async function listRiders(ctx: ToolContext): Promise<RiderProfile[]> {
  const res = await ctx.tracer.run<RiderProfile>(
    "riders and what they prefer now",
    ctx.sandbox,
    `MATCH (r:Rider)-[:STARTS_AT]->(a:Station), (r)-[:ENDS_AT]->(b:Station)
     OPTIONAL MATCH (r)-[p:PREFERS]->(pref:Preference)
     WHERE p.validToMs IS NULL
     WITH r, a, b, collect(CASE WHEN pref IS NULL THEN null ELSE {key: pref.key, value: pref.value, sinceMs: p.validFromMs} END) AS prefs
     RETURN r.id AS id, r.name AS name, r.persona AS persona, r.departs AS departs, r.stepFree AS stepFree,
            a.id AS from, b.id AS to, r.usualEids AS usualEids, r.usualStations AS usualStations,
            r.usualMinutes AS usualMinutes, prefs AS preferences
     ORDER BY name`,
    {},
    { readOnly: true },
  );
  return res.rows.map((r) => ({ ...r, preferences: (r.preferences ?? []).filter(Boolean) }));
}

export interface RouteLeg {
  kind: "RUNS" | "WALK" | "BUS";
  route: string | null;
  from: string;
  to: string;
  stops: number;
  minutes: number;
}

export interface RouteAnswer {
  minutes: number;
  stations: string[];
  eids: number[];
  legs: RouteLeg[];
  transfers: number;
  stepFreeOk: boolean;
  blockedBy: string[];
}

/** One shortest path on the platform layer, as the query returns it. */
export type PathRow = {
  nodes: { station: string; route: string | null; platform: boolean }[];
  rels: { t: string; eid: number | null; minutes: number }[];
  weight: number;
};

/**
 * Turns a platform-layer path into the legs a rider takes: BOARD starts a ride on the platform's
 * route, RIDE extends it, ALIGHT ends it; WALK and BUS are legs of their own. Minutes include the
 * boarding cost (half the headway plus the transfer penalty).
 */
export function legsOf(row: PathRow): RouteLeg[] {
  const legs: RouteLeg[] = [];
  let ride: RouteLeg | null = null;
  row.rels.forEach((rel, i) => {
    const a = row.nodes[i];
    const b = row.nodes[i + 1];
    if (rel.t === "BOARD") {
      ride = { kind: "RUNS", route: b.route, from: a.station, to: a.station, stops: 0, minutes: rel.minutes };
    } else if (rel.t === "RIDE" && ride) {
      ride.to = b.station;
      ride.stops += 1;
      ride.minutes += rel.minutes;
    } else if (rel.t === "ALIGHT" && ride) {
      legs.push(ride);
      ride = null;
    } else if (rel.t === "WALK" || rel.t === "BUS") {
      legs.push({ kind: rel.t, route: null, from: a.station, to: b.station, stops: 1, minutes: rel.minutes });
    }
  });
  return legs;
}

/** Where a step-free rider needs an elevator: every boarding and every exit, with the route used there. */
function stepPoints(legs: RouteLeg[]): { station: string; route: string | null }[] {
  return legs.filter((l) => l.kind === "RUNS").flatMap((l) => [
    { station: l.from, route: l.route },
    { station: l.to, route: l.route },
  ]);
}

/**
 * Weighted shortest paths (algo.SPpaths, k alternatives) on the platform layer: riding, boarding
 * (wait plus transfer penalty), walking and any published shuttle. Step-free riders get the first
 * alternative whose boardings and exits are accessible, skipping platforms with an elevator outage
 * remembered as current.
 */
export async function routeRider(
  ctx: ToolContext,
  input: { riderId?: string; from?: string; to?: string; stepFree?: boolean; avoidRoutes?: string[] },
): Promise<ToolResult<{ rider: string | null; answer: RouteAnswer | null; alternatives: number }>> {
  const network = await loadNetwork();
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  const ada = new Map(network.stations.map((s) => [s.id, s.ada]));
  let from = input.from;
  let to = input.to;
  let stepFree = input.stepFree ?? false;
  let riderName: string | null = null;
  if (input.riderId) {
    const riders = await listRiders(ctx);
    const rider = riders.find((r) => r.id === input.riderId);
    if (!rider) return result(ctx, "route_rider", "unknown_entity", `No rider "${input.riderId}" in memory.`, { rider: null, answer: null, alternatives: 0 });
    from = rider.from;
    to = rider.to;
    stepFree = input.stepFree ?? rider.stepFree;
    riderName = rider.name;
  }
  if (!from || !to || !names.has(from) || !names.has(to)) {
    return result(ctx, "route_rider", "unknown_entity", "Give a rider id, or two station ids resolved with resolve_places.", { rider: riderName, answer: null, alternatives: 0 });
  }

  const outages = await ctx.tracer.run<{ id: string; text: string; sinceMs: number; routes: string[] }>(
    "current accessibility outages (memory)",
    ctx.sandbox,
    `MATCH (f:Finding {kind: 'accessibility'})-[:ABOUT]->(s:Station)
     WHERE f.validToMs IS NULL
     OPTIONAL MATCH (f)-[:ABOUT]->(r:Route)
     RETURN s.id AS id, f.text AS text, f.validFromMs AS sinceMs, collect(r.id) AS routes`,
    {},
    { readOnly: true },
  );
  // An outage tagged with routes (the L platform's elevator) only blocks riders using those routes there.
  const outageAt = new Map(outages.rows.map((o) => [o.id, { text: o.text, routes: o.routes ?? [] }]));
  const blockedAt = (station: string, route: string | null) => {
    const o = outageAt.get(station);
    if (!o) return false;
    return !o.routes.length || (route !== null && o.routes.includes(route));
  };

  const avoid = new Set((input.avoidRoutes ?? []).map((r) => r.toUpperCase()));
  const res = await ctx.tracer.run<PathRow>(
    "fastest paths on the platform layer",
    ctx.sandbox,
    `MATCH (a:Station {id: $from}), (b:Station {id: $to})
     CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: ['BOARD', 'RIDE', 'ALIGHT', 'WALK', 'BUS'], weightProp: 'minutes', pathCount: $k})
     YIELD path, pathWeight
     RETURN [n IN nodes(path) | {station: coalesce(n.station, n.id), route: n.route, platform: hasLabels(n, ['Platform'])}] AS nodes,
            [r IN relationships(path) | {t: type(r), eid: r.eid, minutes: r.minutes}] AS rels,
            pathWeight AS weight
     ORDER BY weight`,
    { from, to, k: stepFree || avoid.size ? 10 : 1 },
    { readOnly: true },
  );

  const open = res.rows.filter((r) => r.weight < CLOSED_MINUTES);
  if (!open.length) {
    return result(
      ctx,
      "route_rider",
      "not_in_graph",
      `No open path connects ${names.get(from)} and ${names.get(to)} in the subway graph${res.rows.length ? " while the closure stands" : ""}.`,
      { rider: riderName, answer: null, alternatives: 0 },
    );
  }

  const answers: RouteAnswer[] = open.map((row) => {
    const legs = legsOf(row);
    const blockedBy = stepFree
      ? [...new Set(stepPoints(legs).filter((p) => ada.get(p.station) !== 1 || blockedAt(p.station, p.route)).map((p) => p.station))]
      : [];
    const stations = row.nodes.map((n) => n.station).filter((id, i, all) => i === 0 || all[i - 1] !== id);
    return {
      minutes: Math.round(row.weight * 10) / 10,
      stations,
      eids: row.rels.filter((r) => r.t === "RIDE").map((r) => r.eid!),
      legs,
      transfers: Math.max(0, legs.filter((l) => l.kind !== "WALK").length - 1),
      stepFreeOk: blockedBy.length === 0,
      blockedBy,
    };
  });
  const usable = answers.filter((a) => a.legs.every((l) => !l.route || !avoid.has(l.route)));
  const pick = (stepFree ? usable.find((a) => a.stepFreeOk) : usable[0]) ?? null;

  const describe = (a: RouteAnswer) =>
    a.legs
      .map((l) =>
        l.kind === "WALK"
          ? `walk ${names.get(l.from)} → ${names.get(l.to)}`
          : l.kind === "BUS"
            ? `shuttle bus ${names.get(l.from)} → ${names.get(l.to)}`
            : `${l.route} ${names.get(l.from)} → ${names.get(l.to)} (${l.stops} stop${l.stops === 1 ? "" : "s"})`,
      )
      .join(", then ");

  if (!pick) {
    const first = answers[0];
    const why = first.blockedBy.map((id) => `${names.get(id)}${outageAt.has(id) ? ` (${outageAt.get(id)!.text})` : " (not accessible)"}`);
    return result(
      ctx,
      "route_rider",
      "not_in_graph",
      `None of the ${answers.length} fastest paths is step-free. The fastest (${first.minutes} min) needs ${why.join(", ")}.`,
      { rider: riderName, answer: null, alternatives: answers.length },
      { path: first.stations, pathEids: first.eids, stations: first.blockedBy },
    );
  }

  const skipped = stepFree ? answers.find((a) => a !== pick && a.blockedBy.some((id) => outageAt.has(id))) : undefined;
  const memoryNote = skipped
    ? ` Skipped a faster path because memory says: ${[...new Set(skipped.blockedBy.filter((id) => outageAt.has(id)).map((id) => outageAt.get(id)!.text))].join("; ")}`
    : "";
  return result(
    ctx,
    "route_rider",
    "answered",
    `${riderName ? `${riderName}: ` : ""}about ${Math.round(pick.minutes)} min, ${pick.transfers} transfer${pick.transfers === 1 ? "" : "s"}${stepFree ? ", step-free" : ""}: ${describe(pick)}.${memoryNote}`,
    { rider: riderName, answer: pick, alternatives: answers.length },
    { path: pick.stations, pathEids: pick.eids },
  );
}

/** Which remembered riders' usual trips cross the open closure. */
export async function ridersAffected(ctx: ToolContext): Promise<ToolResult<{ incident: string | null; affected: RiderProfile[]; unaffected: string[] }>> {
  const incident = await openIncident(ctx);
  if (!incident) return result(ctx, "riders_affected", "not_in_graph", "No closure is open.", { incident: null, affected: [], unaffected: [] });
  const riders = await listRiders(ctx);
  const closed = new Set(incident.closedEids);
  const affected = riders.filter((r) => r.usualEids?.some((e) => closed.has(e)));
  const unaffected = riders.filter((r) => !affected.includes(r)).map((r) => r.name);
  return result(
    ctx,
    "riders_affected",
    "answered",
    affected.length
      ? `${affected.map((r) => r.name).join(", ")} usually ride through the closure; ${unaffected.length} other remembered riders do not.`
      : "No remembered rider's usual trip crosses this closure.",
    { incident: incident.id, affected, unaffected },
    { stations: affected.flatMap((r) => [r.from, r.to]) },
  );
}
