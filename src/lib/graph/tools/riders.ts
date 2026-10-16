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

type PathRow = {
  stations: { id: string; ada: number }[];
  rels: { t: string; route: string | null; eid: number | null; minutes: number }[];
  weight: number;
};

function legsOf(row: PathRow): RouteLeg[] {
  const legs: RouteLeg[] = [];
  row.rels.forEach((rel, i) => {
    const from = row.stations[i].id;
    const to = row.stations[i + 1].id;
    const kind = rel.t as RouteLeg["kind"];
    const last = legs[legs.length - 1];
    if (last && last.kind === kind && last.route === (rel.route ?? null) && last.to === from) {
      last.to = to;
      last.stops += 1;
      last.minutes += rel.minutes;
    } else {
      legs.push({ kind, route: rel.route ?? null, from, to, stops: 1, minutes: rel.minutes });
    }
  });
  return legs;
}

/** Stations a step-free rider must use: where they start, end, and change between legs. */
function stepPoints(legs: RouteLeg[]): string[] {
  if (!legs.length) return [];
  return [legs[0].from, ...legs.map((l) => l.to)];
}

/**
 * Weighted shortest paths (algo.SPpaths, k alternatives) over open segments, walks and any published
 * shuttle. Step-free riders get the first alternative whose boarding, transfer and exit stations are
 * accessible and have no elevator outage remembered as current.
 */
export async function routeRider(
  ctx: ToolContext,
  input: { riderId?: string; from?: string; to?: string; stepFree?: boolean; avoidRoutes?: string[] },
): Promise<ToolResult<{ rider: string | null; answer: RouteAnswer | null; alternatives: number }>> {
  const network = await loadNetwork();
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
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

  const outages = await ctx.tracer.run<{ id: string; text: string; sinceMs: number }>(
    "current accessibility outages (memory)",
    ctx.sandbox,
    `MATCH (f:Finding {kind: 'accessibility'})-[:ABOUT]->(s:Station)
     WHERE f.validToMs IS NULL
     RETURN s.id AS id, f.text AS text, f.validFromMs AS sinceMs`,
    {},
    { readOnly: true },
  );
  const outageAt = new Map(outages.rows.map((o) => [o.id, o.text]));

  const res = await ctx.tracer.run<PathRow>(
    "fastest paths on the open network",
    ctx.sandbox,
    `MATCH (a:Station {id: $from}), (b:Station {id: $to})
     CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: ['RUNS', 'WALK', 'BUS'], weightProp: 'minutes', pathCount: $k})
     YIELD path, pathWeight
     RETURN [n IN nodes(path) | {id: n.id, ada: n.ada}] AS stations,
            [r IN relationships(path) | {t: type(r), route: r.route, eid: r.eid, minutes: r.minutes}] AS rels,
            pathWeight AS weight
     ORDER BY weight`,
    { from, to, k: stepFree || input.avoidRoutes?.length ? 8 : 1 },
    { readOnly: true },
  );

  const avoid = new Set((input.avoidRoutes ?? []).map((r) => r.toUpperCase()));
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
    const ada = new Map(row.stations.map((s) => [s.id, s.ada]));
    const blockedBy = stepFree
      ? stepPoints(legs).filter((id) => ada.get(id) !== 1 || outageAt.has(id))
      : [];
    return {
      minutes: Math.round(row.weight * 10) / 10,
      stations: row.stations.map((s) => s.id),
      eids: row.rels.filter((r) => r.t === "RUNS").map((r) => r.eid!),
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
            : `${l.route} ${names.get(l.from)} → ${names.get(l.to)} (${l.stops} stop${l.stops > 1 ? "s" : ""})`,
      )
      .join(", then ");

  if (!pick) {
    const first = answers[0];
    const why = first.blockedBy.map((id) => `${names.get(id)}${outageAt.has(id) ? ` (${outageAt.get(id)})` : " (not accessible)"}`);
    return result(
      ctx,
      "route_rider",
      "not_in_graph",
      `None of the ${answers.length} fastest paths is step-free. The fastest (${first.minutes} min) needs ${why.join(", ")}.`,
      { rider: riderName, answer: null, alternatives: answers.length },
      { path: first.stations, pathEids: first.eids, stations: first.blockedBy },
    );
  }

  const memoryNote = stepFree && answers[0] !== pick && answers[0].blockedBy.some((id) => outageAt.has(id))
    ? ` Skipped the fastest path because memory says: ${answers[0].blockedBy.filter((id) => outageAt.has(id)).map((id) => outageAt.get(id)).join("; ")}`
    : "";
  return result(
    ctx,
    "route_rider",
    "answered",
    `${riderName ? `${riderName}: ` : ""}${pick.minutes} min, ${pick.transfers} transfer${pick.transfers === 1 ? "" : "s"}${stepFree ? ", step-free" : ""}: ${describe(pick)}.${memoryNote}`,
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
