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
  /** The ride's most crowded segment as a share of its capacity, when one is over capacity. */
  peakPct?: number;
}

/** A line over capacity on a route: the ride (boarding to exit) with its most crowded segment. */
export interface CrowdedLine {
  route: string;
  pct: number;
  from: string;
  to: string;
}

export interface RouteAnswer {
  minutes: number;
  stations: string[];
  eids: number[];
  legs: RouteLeg[];
  transfers: number;
  stepFreeOk: boolean;
  blockedBy: string[];
  /** Lines over capacity that the fastest path rides and this route does not. */
  avoids?: CrowdedLine[];
}

/** One shortest path on the platform layer, as the query returns it. */
export type PathRow = {
  nodes: { station: string; route: string | null; platform: boolean }[];
  rels: { t: string; eid: number | null; minutes: number; crowd?: number | null }[];
  weight: number;
};

/** Lines over capacity on a route, worst first: per line, the ride with its most crowded segment. */
export function crowdedLines(legs: RouteLeg[]): CrowdedLine[] {
  const worst = new Map<string, CrowdedLine>();
  for (const l of legs) {
    if (!l.route || !l.peakPct || (worst.get(l.route)?.pct ?? 0) >= l.peakPct) continue;
    worst.set(l.route, { route: l.route, pct: l.peakPct, from: l.from, to: l.to });
  }
  return [...worst.values()].sort((a, b) => b.pct - a.pct);
}

const and = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]);

/** "the G between Nassau Av and Court Sq-23 St, running at 244% of capacity" */
export function describeCrowded(lines: CrowdedLine[], name: (id: string) => string = (id) => id): string {
  return and(lines.map((l) => `the ${l.route} between ${name(l.from)} and ${name(l.to)}, running at ${l.pct}% of capacity`));
}

/**
 * What a crowding-aware route says about crowding: the crowded rides the fastest path takes and it
 * avoids (with what that costs in minutes), and any crowded ride it still takes because nothing
 * reasonable avoids it. A route can avoid the crowded stretch of a line and still ride the line
 * elsewhere. Empty when nothing on either path is over capacity.
 */
export function crowdingNote(pick: RouteAnswer, fastest: RouteAnswer | null, name: (id: string) => string = (id) => id): { avoids: CrowdedLine[]; text: string } {
  const rides = crowdedLines(pick.legs);
  const riding = new Set(rides.map((l) => l.route));
  const avoids = fastest ? crowdedLines(fastest.legs).filter((l) => !riding.has(l.route)) : [];
  const parts: string[] = [];
  if (avoids.length) {
    const extra = fastest ? Math.round(pick.minutes - fastest.minutes) : 0;
    parts.push(`Avoids ${describeCrowded(avoids, name)}${extra >= 1 ? `, for about ${extra} more minute${extra === 1 ? "" : "s"}` : ""}.`);
  }
  if (rides.length) {
    const text = describeCrowded(rides, name);
    parts.push(`Rides ${text}: no reasonable route avoids ${rides.length === 1 ? "it" : "them"}.`);
  }
  return { avoids, text: parts.join(" ") };
}

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
      if (rel.crowd && rel.crowd > 100) ride.peakPct = Math.max(ride.peakPct ?? 0, rel.crowd);
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
 * remembered as current. While the incident's crowding is set on the rides, paths are weighed by their
 * cost (minutes, with rides over capacity weighted up), so riders are steered onto lines with room when
 * a reasonable alternative exists, and the answer says which crowded line it avoids.
 */
export async function routeRider(
  ctx: ToolContext,
  input: {
    riderId?: string;
    from?: string;
    to?: string;
    stepFree?: boolean;
    avoidRoutes?: string[];
    /** false routes as if nothing were remembered: elevator outages in memory are ignored (the evaluation's control). */
    useMemory?: boolean;
  },
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

  const outages =
    input.useMemory === false
      ? []
      : (
          await ctx.tracer.run<{ id: string; text: string; sinceMs: number; routes: string[] }>(
            "current accessibility outages (memory)",
            ctx.sandbox,
            `MATCH (f:Finding {kind: 'accessibility'})-[:ABOUT]->(s:Station)
             WHERE f.validToMs IS NULL
             OPTIONAL MATCH (f)-[:ABOUT]->(r:Route)
             RETURN s.id AS id, f.text AS text, f.validFromMs AS sinceMs, collect(r.id) AS routes`,
            {},
            { readOnly: true },
          )
        ).rows;
  // An outage tagged with routes (the L platform's elevator) only blocks riders using those routes there.
  // Two outages at one station (two platforms' elevators) block both platforms.
  const outageAt = new Map<string, { text: string; routes: string[]; all: boolean }>();
  for (const o of outages) {
    const seen = outageAt.get(o.id);
    const routes = o.routes ?? [];
    outageAt.set(o.id, {
      text: seen ? `${seen.text}; ${o.text}` : o.text,
      routes: [...(seen?.routes ?? []), ...routes],
      all: (seen?.all ?? false) || !routes.length,
    });
  }
  const blockedAt = (station: string, route: string | null) => {
    const o = outageAt.get(station);
    if (!o) return false;
    return o.all || (route !== null && o.routes.includes(route));
  };

  // Crowding the capacity measure or the published plan persisted on the rides (see applyCrowding).
  const crowding = await ctx.tracer.run<{ n: number }>(
    "rides over capacity right now",
    ctx.sandbox,
    "MATCH ()-[r:RIDE]->() WHERE r.crowd > 100 RETURN count(r) AS n",
    {},
    { readOnly: true },
  );
  const crowded = (crowding.rows[0]?.n ?? 0) > 0;

  const avoid = new Set((input.avoidRoutes ?? []).map((r) => r.toUpperCase()));
  const k = stepFree || avoid.size ? 10 : 1;
  // weightProp is a literal: 'cost' (minutes, crowded rides weighted up) while crowding is set, else 'minutes'.
  const paths = (weight: "minutes" | "cost", label: string) =>
    ctx.tracer.run<PathRow>(
      label,
      ctx.sandbox,
      `MATCH (a:Station {id: $from}), (b:Station {id: $to})
       CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: ['BOARD', 'RIDE', 'ALIGHT', 'WALK', 'BUS'], weightProp: '${weight}', pathCount: $k})
       YIELD path, pathWeight
       RETURN [n IN nodes(path) | {station: coalesce(n.station, n.id), route: n.route, platform: hasLabels(n, ['Platform'])}] AS nodes,
              [r IN relationships(path) | {t: type(r), eid: r.eid, minutes: r.minutes, crowd: r.crowd}] AS rels,
              pathWeight AS weight
       ORDER BY weight`,
      { from, to, k },
      { readOnly: true },
    );
  const res = await paths(crowded ? "cost" : "minutes", crowded ? "paths weighed by minutes and crowding" : "fastest paths on the platform layer");

  const toAnswer = (row: PathRow): RouteAnswer => {
    const legs = legsOf(row);
    const blockedBy = stepFree
      ? [...new Set(stepPoints(legs).filter((p) => ada.get(p.station) !== 1 || blockedAt(p.station, p.route)).map((p) => p.station))]
      : [];
    const stations = row.nodes.map((n) => n.station).filter((id, i, all) => i === 0 || all[i - 1] !== id);
    return {
      // Travel time, not the routing cost: the crowding weight only chooses between paths.
      minutes: Math.round(row.rels.reduce((s, r) => s + (r.minutes ?? 0), 0) * 10) / 10,
      stations,
      eids: row.rels.filter((r) => r.t === "RIDE").map((r) => r.eid!),
      legs,
      transfers: Math.max(0, legs.filter((l) => l.kind !== "WALK").length - 1),
      stepFreeOk: blockedBy.length === 0,
      blockedBy,
    };
  };
  const choose = (answers: RouteAnswer[]) => {
    const usable = answers.filter((a) => a.legs.every((l) => !l.route || !avoid.has(l.route)));
    return (stepFree ? usable.find((a) => a.stepFreeOk) : usable[0]) ?? null;
  };

  const answers = res.rows.map(toAnswer).filter((a) => a.minutes < CLOSED_MINUTES);
  if (!answers.length) {
    return result(
      ctx,
      "route_rider",
      "not_in_graph",
      `No open path connects ${names.get(from)} and ${names.get(to)} in the subway graph${res.rows.length ? " while the closure stands" : ""}.`,
      { rider: riderName, answer: null, alternatives: 0 },
    );
  }
  const pick = choose(answers);

  // With crowding set, the fastest path by minutes alone says what the chosen route avoids.
  let crowdText = "";
  if (pick && crowded) {
    const fastest = choose((await paths("minutes", "fastest paths, ignoring crowding")).rows.map(toAnswer).filter((a) => a.minutes < CLOSED_MINUTES));
    const note = crowdingNote(pick, fastest, (id) => names.get(id) ?? id);
    if (note.avoids.length) pick.avoids = note.avoids;
    crowdText = note.text ? ` ${note.text}` : "";
  }

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
    `${riderName ? `${riderName}: ` : ""}about ${Math.round(pick.minutes)} min, ${pick.transfers} transfer${pick.transfers === 1 ? "" : "s"}${stepFree ? ", step-free" : ""}: ${describe(pick)}.${crowdText}${memoryNote}`,
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
