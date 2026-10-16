import { loadNetwork } from "../../network/data";
import type { Network } from "../../network/types";
import { copyGraph, deleteGraph, listGraphs } from "../db";
import { busLeg, BUS_FLEET, directionOf, freedLoad, haversineMeters, minCut, netBalance, type Direction, type DisplacedPair, type FlowEdge } from "../flow";
import { forkGraph } from "../names";
import { displacedPairs } from "./impact";
import { openIncident, type Incident } from "./incident";
import { result, type CutHighlight, type FlowHighlight, type ToolContext, type ToolResult } from "./types";

const DIRECTIONS: Direction[] = ["forward", "backward"];
const FEED: Record<Direction, string> = { forward: "FEED_F", backward: "FEED_B" };
const HUB: Record<Direction, { src: string; snk: string }> = {
  forward: { src: "SRC_F", snk: "SNK_F" },
  backward: { src: "SRC_B", snk: "SNK_B" },
};

interface Group {
  direction: Direction;
  pairs: DisplacedPair[];
  riders: number;
  required: number;
  sources: number;
  sinks: number;
}

interface Prepared {
  fork: string;
  incident: Incident;
  pairs: DisplacedPair[];
  groups: Group[];
  freed: Map<number, number>;
}

const fmt = (n: number) => (Math.round(n) || 0).toLocaleString("en-US");

function names(network: Network) {
  return new Map(network.stations.map((s) => [s.id, s.name]));
}

function segmentsById(network: Network) {
  return new Map(network.segments.map((s) => [s.eid, s]));
}

/**
 * Runs `fn` on a private fork of the sandbox with the closure applied. Every call gets its own
 * fork (tools may run in parallel) and the fork is deleted afterwards to stay inside 100 MB.
 */
async function withClosureFork<T>(ctx: ToolContext, incident: Incident, fn: (prepared: Prepared) => Promise<T>): Promise<T> {
  const fork = forkGraph(ctx.visitorId, `${incident.id.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    return await fn(await prepareClosureFork(ctx, incident, fork));
  } finally {
    await ctx.tracer.command("drop the fork", fork, `GRAPH.DELETE ${fork}`, async () => {
      if ((await listGraphs()).includes(fork)) await deleteGraph(fork);
    });
  }
}

/** Copies the sandbox into the fork, deletes the closed segments, and frees displaced riders' capacity. */
async function prepareClosureFork(ctx: ToolContext, incident: Incident, fork: string): Promise<Prepared> {
  const network = await loadNetwork();
  await ctx.tracer.command("fork the sandbox", fork, `GRAPH.COPY ${ctx.sandbox} ${fork}`, () => copyGraph(ctx.sandbox, fork));
  await ctx.tracer.run("drop closed segments in the fork", fork, "MATCH ()-[r:RUNS {closed: true}]->() DELETE r");
  await ctx.tracer.run("drop closed rides in the fork", fork, "MATCH ()-[r:RIDE {closed: true}]->() DELETE r");

  const pairs = await displacedPairs(ctx, incident.closedEids);
  const closed = new Set(incident.closedEids);
  const freed = freedLoad(pairs, closed);
  await ctx.tracer.run(
    "free displaced riders' capacity",
    fork,
    `UNWIND $freed AS f
     MATCH ()-[r:RUNS {eid: f.eid}]->()
     SET r.freed = f.riders,
         r.spare = CASE WHEN r.capacity - r.load + f.riders > 0 THEN r.capacity - r.load + f.riders ELSE 0 END`,
    { freed: [...freed.entries()].map(([eid, riders]) => ({ eid, riders })) },
  );

  const stretchIndex = new Map(incident.stretch.map((id, i) => [id, i]));
  const segs = segmentsById(network);
  const groups: Group[] = [];
  for (const direction of DIRECTIONS) {
    const groupPairs = pairs.filter((p) => directionOf(p.via, closed, stretchIndex, segs) === direction);
    const net = netBalance(groupPairs);
    const sources = [...net].filter(([, v]) => v > 0).map(([id, v]) => ({ id, cap: v }));
    const sinks = [...net].filter(([, v]) => v < 0).map(([id, v]) => ({ id, cap: -v }));
    const required = sources.reduce((s, x) => s + x.cap, 0);
    groups.push({ direction, pairs: groupPairs, riders: groupPairs.reduce((s, p) => s + p.riders, 0), required, sources: sources.length, sinks: sinks.length });
    if (!required) continue;
    await ctx.tracer.run(
      `${direction} source and sink`,
      fork,
      `CREATE (src:Hub {id: $src}), (snk:Hub {id: $snk})
       WITH src, snk
       UNWIND $sources AS s
       MATCH (x:Station {id: s.id})
       CREATE (src)-[:FLOW {spare: s.cap, kind: $kind, ref: -1}]->(x)`,
      { src: HUB[direction].src, snk: HUB[direction].snk, sources, kind: FEED[direction] },
    );
    await ctx.tracer.run(
      `${direction} sinks`,
      fork,
      `MATCH (snk:Hub {id: $snk})
       UNWIND $sinks AS s
       MATCH (x:Station {id: s.id})
       CREATE (x)-[:FLOW {spare: s.cap, kind: $kind, ref: -1}]->(snk)`,
      { snk: HUB[direction].snk, sinks, kind: FEED[direction] },
    );
  }
  await buildFlowNetwork(ctx, fork, ["RUNS", "WALK"]);
  return { fork, incident, pairs, groups, freed };
}

/**
 * algo.maxFlow takes one relationship type and no parallel edges, so the fork's flow network is
 * one FLOW edge per ordered station pair: the summed spare capacity of every open segment, walk
 * and shuttle leg between them, with their ids kept in `refs` for provenance.
 */
async function buildFlowNetwork(ctx: ToolContext, graph: string, kinds: string[]): Promise<void> {
  await ctx.tracer.run("clear corridor flow edges", graph, "MATCH (:Station)-[f:FLOW]->(:Station) DELETE f");
  await ctx.tracer.run(
    "aggregate spare capacity by corridor",
    graph,
    `MATCH (a:Station)-[r]->(b:Station)
     WHERE type(r) IN $kinds
     WITH a, b, sum(r.spare) AS spare,
          collect(CASE type(r) WHEN 'RUNS' THEN 'R' + toString(r.eid) WHEN 'WALK' THEN 'W' + toString(r.wid) ELSE 'B' + toString(r.bid) END) AS refs
     CREATE (a)-[:FLOW {spare: spare, kind: 'NET', refs: refs}]->(b)`,
    { kinds },
  );
}

/** Spare capacity of one constituent of a corridor (same arithmetic as the Cypher that set it). */
type SpareOf = (ref: string) => number;

function spareLookup(network: Network, freed: Map<number, number>, busCapacity: Map<number, number> = new Map()): SpareOf {
  const segs = segmentsById(network);
  return (ref) => {
    const id = Number(ref.slice(1));
    if (ref[0] === "R") {
      const s = segs.get(id);
      return s ? Math.max(0, s.capacity - s.load + (freed.get(id) ?? 0)) : 0;
    }
    if (ref[0] === "W") return network.walks[id]?.capacity ?? 0;
    return busCapacity.get(id) ?? 0;
  };
}

export interface FlowRun {
  direction: Direction;
  required: number;
  absorbed: number;
  unmet: number;
  flows: FlowHighlight[];
  cut: CutHighlight[];
  /** Feed edges in the cut: stations whose riders the network cannot move at all. */
  strandedAt: { id: string; riders: number }[];
}

/** algo.maxFlow from the direction's super source to its super sink, then the min cut from the residual graph. */
async function maxFlow(ctx: ToolContext, graph: string, group: Group, spareOf: SpareOf): Promise<FlowRun> {
  const { src, snk } = HUB[group.direction];
  const feed = FEED[group.direction];
  type Row = { maxFlow: number; es: [string, string, string][]; flows: number[] };
  const res = await ctx.tracer.run<Row>(
    `${group.direction} max flow`,
    graph,
    `MATCH (src:Hub {id: $src}), (snk:Hub {id: $snk})
     CALL algo.maxFlow({sourceNodes: [src], targetNodes: [snk], relationshipTypes: ['FLOW'], capacityProperty: 'spare'})
     YIELD maxFlow, edges, edgeFlows
     RETURN maxFlow, [e IN edges | [e.kind, startNode(e).id, endNode(e).id]] AS es, edgeFlows AS flows`,
    { src, snk },
    { readOnly: true, timeoutMs: 30_000 },
  );
  const row = res.rows[0];
  const absorbed = row?.maxFlow ?? 0;
  const flowByKey = new Map<string, number>();
  (row?.es ?? []).forEach(([kind, a, b], i) => flowByKey.set(`${kind}:${a}>${b}`, (flowByKey.get(`${kind}:${a}>${b}`) ?? 0) + (row.flows[i] ?? 0)));

  const all = await ctx.tracer.run<{ kind: string; a: string; b: string; cap: number; refs: string[] | null }>(
    `${group.direction} residual graph`,
    graph,
    `MATCH (a)-[r:FLOW]->(b) WHERE r.kind IN $kinds
     RETURN r.kind AS kind, a.id AS a, b.id AS b, r.spare AS cap, r.refs AS refs`,
    { kinds: ["NET", feed] },
    { readOnly: true },
  );
  const refsOf = new Map<string, string[]>();
  const edges: FlowEdge[] = all.rows.map((r) => {
    const key = `${r.kind}:${r.a}>${r.b}`;
    if (r.refs) refsOf.set(key, r.refs);
    return { key, from: r.a, to: r.b, capacity: r.cap ?? 0, flow: flowByKey.get(key) ?? 0 };
  });
  const { cut } = minCut(edges, src);
  const network = await loadNetwork();
  const segs = segmentsById(network);

  // Corridor flows are shared out to the lines in the corridor in proportion to their spare capacity.
  const flows: FlowHighlight[] = [];
  for (const e of edges) {
    if (!e.key.startsWith("NET:") || e.flow < 0.5) continue;
    const refs = refsOf.get(e.key) ?? [];
    const total = refs.reduce((sum, ref) => sum + spareOf(ref), 0);
    for (const ref of refs) {
      const share = total > 0 ? spareOf(ref) / total : 1 / refs.length;
      const flow = Math.round(e.flow * share);
      if (flow < 1) continue;
      const kind = ref[0] === "R" ? "RUNS" : ref[0] === "W" ? "WALK" : "BUS";
      flows.push({ kind, id: Number(ref.slice(1)), from: e.from, to: e.to, flow });
    }
  }
  flows.sort((a, b) => b.flow - a.flow);

  const cutNet: CutHighlight[] = cut
    .filter((e) => e.key.startsWith("NET:"))
    .flatMap((e) =>
      (refsOf.get(e.key) ?? []).map((ref) => {
        const kind = (ref[0] === "R" ? "RUNS" : ref[0] === "W" ? "WALK" : "BUS") as CutHighlight["kind"];
        const id = Number(ref.slice(1));
        return { kind, id, from: e.from, to: e.to, spare: Math.round(spareOf(ref)), route: kind === "RUNS" ? segs.get(id)?.route : undefined };
      }),
    );
  // Riders the network cannot move: supply left on the source's feed edges after max flow.
  const strandedAt = edges
    .filter((e) => e.key.startsWith(`${feed}:`) && e.from === src && e.capacity - e.flow > 0.5)
    .map((e) => ({ id: e.to, riders: Math.round(e.capacity - e.flow) }))
    .sort((a, b) => b.riders - a.riders);

  return {
    direction: group.direction,
    // Float noise can put max flow a hair above supply; it never moves more riders than there are.
    required: Math.round(group.required),
    absorbed: Math.round(Math.min(absorbed, group.required)),
    unmet: Math.round(group.required - Math.min(absorbed, group.required)),
    flows,
    cut: cutNet,
    strandedAt,
  };
}

export interface RerouteRun {
  rerouted: number;
  stranded: number;
  strandedPairs: number;
  /** Segments the closure pushes over capacity; baseline is the load at 8 a.m. before it. */
  overloaded: { kind: "RUNS" | "BUS"; id: number; route: string; from: string; to: string; load: number; baseline: number; capacity: number; pct: number }[];
  overflow: number;
  flows: FlowHighlight[];
}

/**
 * Every displaced pair takes its fastest open path on the platform layer (riding, boarding with
 * wait and transfer penalty, walking): one algo.SPpaths per pair, all pairs in one UNWIND query.
 */
async function reroute(ctx: ToolContext, graph: string, prepared: Prepared, withBus: boolean): Promise<RerouteRun> {
  const network = await loadNetwork();
  const segs = segmentsById(network);
  const types = ["BOARD", "RIDE", "ALIGHT", "WALK", ...(withBus ? ["BUS"] : [])];

  const res = await ctx.tracer.run<{ o: string; d: string; minutes: number; eids: number[]; bids: number[]; walks: number[] }>(
    "reroute displaced riders on fastest open paths",
    graph,
    `UNWIND $pairs AS p
     MATCH (a:Station {id: p.o}), (b:Station {id: p.d})
     CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: $types, weightProp: 'minutes'})
     YIELD path, pathWeight
     RETURN p.o AS o, p.d AS d, pathWeight AS minutes,
            [r IN relationships(path) WHERE type(r) = 'RIDE' | r.eid] AS eids,
            [r IN relationships(path) WHERE type(r) = 'BUS' | r.bid] AS bids,
            [r IN relationships(path) WHERE type(r) = 'WALK' | r.wid] AS walks`,
    { pairs: prepared.pairs.map((p) => ({ o: p.o, d: p.d })), types },
    { readOnly: true, timeoutMs: 45_000 },
  );

  const riders = new Map(prepared.pairs.map((p) => [`${p.o}>${p.d}`, p.riders]));
  const added = new Map<number, number>();
  const busAdded = new Map<number, number>();
  const walkAdded = new Map<number, number>();
  let rerouted = 0;
  const reached = new Set<string>();
  for (const r of res.rows) {
    const key = `${r.o}>${r.d}`;
    const n = riders.get(key) ?? 0;
    if (!n || reached.has(key)) continue;
    reached.add(key);
    rerouted += n;
    for (const eid of r.eids) added.set(eid, (added.get(eid) ?? 0) + n);
    for (const bid of r.bids) busAdded.set(bid, (busAdded.get(bid) ?? 0) + n);
    for (const wid of r.walks) walkAdded.set(wid, (walkAdded.get(wid) ?? 0) + n);
  }
  const strandedList = prepared.pairs.filter((p) => !reached.has(`${p.o}>${p.d}`));

  const overloaded: RerouteRun["overloaded"] = [];
  for (const [eid, n] of added) {
    const s = segs.get(eid);
    if (!s) continue;
    const load = s.load - (prepared.freed.get(eid) ?? 0) + n;
    // Only overload the closure causes: a segment already over capacity at 8 a.m. counts only for what it adds.
    if (load > s.capacity && load > s.load) {
      overloaded.push({
        kind: "RUNS",
        id: eid,
        route: s.route,
        from: s.from,
        to: s.to,
        load: Math.round(load),
        baseline: Math.round(s.load),
        capacity: s.capacity,
        pct: Math.round((load / s.capacity) * 100),
      });
    }
  }
  if (withBus && busAdded.size) {
    const buses = await ctx.tracer.run<{ bid: number; a: string; b: string; cap: number }>(
      "bus legs",
      graph,
      "MATCH (a)-[r:BUS]->(b) RETURN r.bid AS bid, a.id AS a, b.id AS b, r.capacity AS cap",
      {},
      { readOnly: true },
    );
    for (const bus of buses.rows) {
      const load = busAdded.get(bus.bid) ?? 0;
      if (load > bus.cap) overloaded.push({ kind: "BUS", id: bus.bid, route: "BUS", from: bus.a, to: bus.b, load: Math.round(load), baseline: 0, capacity: bus.cap, pct: Math.round((load / bus.cap) * 100) });
    }
  }
  const excess = (o: RerouteRun["overloaded"][number]) => o.load - Math.max(o.capacity, o.baseline);
  overloaded.sort((a, b) => excess(b) - excess(a));

  const flows: FlowHighlight[] = [
    ...[...added].map(([id, flow]) => ({ kind: "RUNS" as const, id, from: segs.get(id)?.from ?? "", to: segs.get(id)?.to ?? "", flow: Math.round(flow) })),
    ...[...walkAdded].map(([id, flow]) => {
      const w = network.walks[id];
      return { kind: "WALK" as const, id, from: w?.from ?? "", to: w?.to ?? "", flow: Math.round(flow) };
    }),
  ]
    .filter((f) => f.flow > 0)
    .sort((a, b) => b.flow - a.flow);

  return {
    rerouted: Math.round(rerouted),
    stranded: Math.round(strandedList.reduce((s, p) => s + p.riders, 0)),
    strandedPairs: strandedList.length,
    overloaded,
    overflow: Math.round(overloaded.reduce((s, o) => s + excess(o), 0)),
    flows,
  };
}

function describeSegment(n: Map<string, string>, x: { route?: string; from: string; to: string; kind: string }) {
  const label = x.kind === "WALK" ? "walk" : x.kind === "BUS" ? "shuttle bus" : `${x.route}`;
  return `${label} ${n.get(x.from) ?? x.from} → ${n.get(x.to) ?? x.to}`;
}

export interface CapacityData {
  incidentId: string;
  displacedRiders: number;
  reroute: RerouteRun;
  directions: FlowRun[];
  peak: Direction;
}

/** The incident's capacity picture: fastest-path reroute (what happens) and max flow + min cut (what is possible). */
export async function measureCapacity(ctx: ToolContext): Promise<ToolResult<CapacityData | null>> {
  const incident = await openIncident(ctx);
  if (!incident) return result(ctx, "measure_capacity", "not_in_graph", "No closure is open in this sandbox. Close a line first.", null);
  const network = await loadNetwork();
  const n = names(network);
  const { runs, re, displacedRiders } = await withClosureFork(ctx, incident, async (prepared) => {
    const runs: FlowRun[] = [];
    const spareOf = spareLookup(network, prepared.freed);
    for (const g of prepared.groups) if (g.required > 0) runs.push(await maxFlow(ctx, prepared.fork, g, spareOf));
    const re = await reroute(ctx, prepared.fork, prepared, false);
    return { runs, re, displacedRiders: Math.round(prepared.pairs.reduce((s, p) => s + p.riders, 0)) };
  });
  const peak = runs.slice().sort((a, b) => b.required - a.required)[0];

  await ctx.tracer.run(
    "remember the capacity picture",
    ctx.sandbox,
    `MATCH (i:Incident {id: $id})
     SET i.displaced = $displaced, i.overflow = $overflow, i.stranded = $stranded,
         i.required = $required, i.absorbed = $absorbed, i.unmet = $unmet, i.measuredMs = timestamp()`,
    {
      id: incident.id,
      displaced: displacedRiders,
      overflow: re.overflow,
      stranded: re.stranded,
      required: peak?.required ?? 0,
      absorbed: peak?.absorbed ?? 0,
      unmet: peak?.unmet ?? 0,
    },
  );

  const worst = re.overloaded.slice(0, 3).map((o) => `${describeSegment(n, o)} at ${o.pct}%`);
  const bottlenecks = peak?.cut.slice(0, 3).map((c) => describeSegment(n, c)) ?? [];
  const stranded = peak?.strandedAt.slice(0, 3).map((s) => `${n.get(s.id) ?? s.id} (${fmt(s.riders)})`) ?? [];
  const summary = [
    `${fmt(displacedRiders)} displaced riders an hour.`,
    `If each takes the fastest open path, ${re.overloaded.length} segments overflow by ${fmt(re.overflow)} riders an hour${worst.length ? `: ${worst.join("; ")}` : ""}${re.stranded ? `; ${fmt(re.stranded)} have no open path` : ""}.`,
    peak
      ? `If riders are spread perfectly (max flow, ${peak.direction} peak direction), the open network can carry ${fmt(peak.absorbed)} of ${fmt(peak.required)} (${Math.round((peak.absorbed / Math.max(1, peak.required)) * 100)}%); ${fmt(peak.unmet)} cannot move.`
      : "",
    bottlenecks.length ? `Min cut: ${bottlenecks.join("; ")}.` : stranded.length ? `Min cut is at the riders' own stations: ${stranded.join(", ")} have no open alternative.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return result(
    ctx,
    "measure_capacity",
    "answered",
    summary,
    { incidentId: incident.id, displacedRiders, reroute: re, directions: runs, peak: peak?.direction ?? "forward" },
    {
      closedEids: incident.closedEids,
      flows: re.flows.slice(0, 160),
      cut: peak?.cut ?? [],
      stations: peak?.strandedAt.map((s) => s.id) ?? [],
    },
  );
}

export interface Candidate {
  reason: "stranded" | "relief";
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  lines: string[];
  supply: number;
  meters: number;
  outSpare: number;
  suggestedBusesPerHour: number;
}

/**
 * Shuttle-bridge candidates. First the stations max flow cannot clear (riders with no open line),
 * then the busiest displaced origins (relief for overloaded lines), each paired with nearby
 * stations on open lines that have spare capacity, by straight-line distance in Cypher.
 */
export async function shuttleCandidates(ctx: ToolContext, input: { maxKm?: number; limit?: number }): Promise<ToolResult<{ candidates: Candidate[] } | null>> {
  const incident = await openIncident(ctx);
  if (!incident) return result(ctx, "shuttle_candidates", "not_in_graph", "No closure is open. Close a line first.", null);
  const network = await loadNetwork();
  const maxMeters = Math.min(4, Math.max(0.5, input.maxKm ?? 2)) * 1000;
  const res = await withClosureFork(ctx, incident, async (prepared) => {
    const peakGroup = prepared.groups.slice().sort((a, b) => b.required - a.required)[0];
    const stranded = peakGroup?.required ? (await maxFlow(ctx, prepared.fork, peakGroup, spareLookup(network, prepared.freed))).strandedAt : [];
    const net = netBalance(peakGroup?.pairs ?? []);
    const relief = [...net]
      .filter(([id, v]) => v > 0 && !stranded.some((x) => x.id === id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id, v]) => ({ id, net: Math.round(v), reason: "relief" }));
    const sources = [...stranded.slice(0, 6).map((x) => ({ id: x.id, net: x.riders, reason: "stranded" })), ...relief];
    return ctx.tracer.run<Omit<Candidate, "suggestedBusesPerHour">>(
      "shuttle candidates within reach",
      prepared.fork,
      `UNWIND $sources AS s
       MATCH (a:Station {id: s.id}), (b:Station)
       WHERE b.id <> a.id AND NOT b.id IN $stretch AND distance(a.loc, b.loc) <= $maxMeters
       WITH a, b, s, distance(a.loc, b.loc) AS meters
       MATCH (b)-[r:RUNS]->()
       WITH a, b, s, meters, sum(r.spare) AS outSpare, collect(DISTINCT r.route) AS lines
       WHERE size([x IN lines WHERE NOT x IN $closedRoutes]) > 0
       RETURN a.id AS fromId, a.name AS fromName, b.id AS toId, b.name AS toName, lines,
              s.net AS supply, s.reason AS reason, meters, outSpare
       ORDER BY reason DESC, supply DESC, meters ASC`,
      { sources, stretch: incident.stretch, maxMeters, closedRoutes: incident.routes },
      { readOnly: true },
    );
  });
  const bestPerSource = new Map<string, Omit<Candidate, "suggestedBusesPerHour">[]>();
  for (const r of res.rows) {
    const list = bestPerSource.get(r.fromId) ?? [];
    if (list.length < 2) list.push(r);
    bestPerSource.set(r.fromId, list);
  }
  const candidates: Candidate[] = [...bestPerSource.values()]
    .flat()
    .slice(0, Math.min(12, input.limit ?? 8))
    .map((c) => ({ ...c, meters: Math.round(c.meters), outSpare: Math.round(c.outSpare), suggestedBusesPerHour: Math.min(60, Math.max(6, Math.ceil(c.supply / 70))) }));

  const describe = (c: Candidate) =>
    `${c.fromName} → ${c.toName} (${c.reason === "stranded" ? `${fmt(c.supply)} riders an hour with no open line` : `relief for ${fmt(c.supply)} riders an hour`}, ${(c.meters / 1000).toFixed(1)} km away, ${c.lines.length === 1 ? "line" : "lines"} ${c.lines.join("/")})`;
  const summary = candidates.length
    ? `Shuttle candidates: ${candidates.slice(0, 5).map(describe).join("; ")}.`
    : `No station on an open line lies within ${(maxMeters / 1000).toFixed(1)} km of the stranded riders; widen the radius.`;
  return result(ctx, "shuttle_candidates", candidates.length ? "answered" : "not_in_graph", summary, { candidates }, {
    stations: candidates.flatMap((c) => [c.fromId, c.toId]),
  });
}

export interface PlanData {
  planId: string;
  shuttles: { from: string; to: string; busesPerHour: number; capacity: number; minutes: number; vehicles: number; meters: number }[];
  vehicles: number;
  before: { overflow: number; stranded: number; absorbed: number; unmet: number };
  after: { overflow: number; stranded: number; absorbed: number; unmet: number };
  reroute: RerouteRun;
  direction: FlowRun | null;
}

/** Tests a shuttle plan on its own fork of the closure graph: adds BUS edges, reroutes riders, reruns max flow. */
export async function simulatePlan(
  ctx: ToolContext,
  input: { shuttles: { from: string; to: string; busesPerHour: number }[]; label?: string },
): Promise<ToolResult<PlanData | null>> {
  const incident = await openIncident(ctx);
  if (!incident) return result(ctx, "simulate_plan", "not_in_graph", "No closure is open. Close a line first.", null);
  const network = await loadNetwork();
  const n = names(network);
  const byId = new Map(network.stations.map((s) => [s.id, s]));
  const unknown = input.shuttles.flatMap((s) => [s.from, s.to]).filter((id) => !byId.has(id));
  if (unknown.length) {
    return result(ctx, "simulate_plan", "unknown_entity", `Unknown station ids: ${unknown.join(", ")}. Resolve names first.`, null);
  }

  const legs = input.shuttles.slice(0, 4).map((s, i) => {
    const a = byId.get(s.from)!;
    const b = byId.get(s.to)!;
    const meters = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    const bph = Math.min(60, Math.max(1, Math.round(s.busesPerHour)));
    return { bid: i, from: s.from, to: s.to, busesPerHour: bph, meters: Math.round(meters), ...busLeg(meters, bph) };
  });
  const vehicles = legs.reduce((s, l) => s + l.vehicles, 0);
  if (vehicles > BUS_FLEET) {
    return result(
      ctx,
      "simulate_plan",
      "not_in_graph",
      `That plan needs ${vehicles} buses on the road; only ${BUS_FLEET} are available for bridges. Cut buses per hour or drop a leg.`,
      null,
    );
  }

  return withClosureFork(ctx, incident, async (prepared) => {
  const peakGroup = prepared.groups.slice().sort((a, b) => b.required - a.required)[0];
  const beforeFlow = peakGroup?.required ? await maxFlow(ctx, prepared.fork, peakGroup, spareLookup(network, prepared.freed)) : null;
  const beforeRe = await reroute(ctx, prepared.fork, prepared, false);

  const planId = `PLAN-${Date.now().toString(36).toUpperCase()}`;
  const planFork = forkGraph(ctx.visitorId, `p-${planId.toLowerCase()}`);
  await ctx.tracer.command("fork for this plan", planFork, `GRAPH.COPY ${prepared.fork} ${planFork}`, () => copyGraph(prepared.fork, planFork));
  try {
    await ctx.tracer.run(
      "add shuttle legs",
      planFork,
      `UNWIND $legs AS l
       MATCH (a:Station {id: l.from}), (b:Station {id: l.to})
       CREATE (a)-[:BUS {bid: l.bid, capacity: l.capacity, spare: l.capacity, minutes: l.minutes, busesPerHour: l.busesPerHour}]->(b),
              (b)-[:BUS {bid: l.bid, capacity: l.capacity, spare: l.capacity, minutes: l.minutes, busesPerHour: l.busesPerHour}]->(a)`,
      { legs: legs.map((l) => ({ bid: l.bid, from: l.from, to: l.to, capacity: l.capacity, minutes: l.minutes, busesPerHour: l.busesPerHour })) },
    );
    await buildFlowNetwork(ctx, planFork, ["RUNS", "WALK", "BUS"]);
    const busCapacity = new Map(legs.map((l) => [l.bid, l.capacity]));
    const afterFlow = peakGroup?.required ? await maxFlow(ctx, planFork, peakGroup, spareLookup(network, prepared.freed, busCapacity)) : null;
    const afterRe = await reroute(ctx, planFork, prepared, true);

    const before = {
      overflow: beforeRe.overflow,
      stranded: beforeRe.stranded,
      absorbed: beforeFlow?.absorbed ?? 0,
      unmet: beforeFlow?.unmet ?? 0,
    };
    const after = {
      overflow: afterRe.overflow,
      stranded: afterRe.stranded,
      absorbed: afterFlow?.absorbed ?? 0,
      unmet: afterFlow?.unmet ?? 0,
    };
    await ctx.tracer.run(
      "record the plan",
      ctx.sandbox,
      `MATCH (i:Incident {id: $incident}), (ag:Agent {id: $agent})
       CREATE (ag)-[:PROPOSED {atMs: timestamp()}]->(p:Plan {id: $id, label: $label, status: 'simulated', legs: $legsJson,
         vehicles: $vehicles, overflowBefore: $ob, overflowAfter: $oa, unmetBefore: $ub, unmetAfter: $ua,
         strandedBefore: $sb, strandedAfter: $sa, createdMs: timestamp()})-[:FOR]->(i)`,
      {
        incident: incident.id,
        agent: ctx.agentId,
        id: planId,
        label: input.label ?? legs.map((l) => `${n.get(l.from)} ↔ ${n.get(l.to)}`).join(" + "),
        legsJson: JSON.stringify(legs.map((l) => ({ from: l.from, to: l.to, busesPerHour: l.busesPerHour, capacity: l.capacity, minutes: l.minutes, meters: l.meters }))),
        vehicles,
        ob: before.overflow,
        oa: after.overflow,
        ub: before.unmet,
        ua: after.unmet,
        sb: before.stranded,
        sa: after.stranded,
      },
    );

    const summary =
      `${planId}: ${legs.map((l) => `${n.get(l.from)} ↔ ${n.get(l.to)} at ${l.busesPerHour} buses an hour (${fmt(l.capacity)} riders)`).join("; ")}; ${vehicles} buses on the road. ` +
      `Riders with no path ${fmt(before.stranded)} → ${fmt(after.stranded)}; max-flow shortfall ${fmt(before.unmet)} → ${fmt(after.unmet)}; ` +
      `fastest-path overflow ${fmt(before.overflow)} → ${fmt(after.overflow)} riders an hour` +
      (after.overflow > before.overflow && after.stranded < before.stranded
        ? " (riders who had no path now travel and add load downstream)."
        : ".");
    return result(
      ctx,
      "simulate_plan",
      "answered",
      summary,
      {
        planId,
        shuttles: legs.map((l) => ({ from: l.from, to: l.to, busesPerHour: l.busesPerHour, capacity: l.capacity, minutes: l.minutes, vehicles: l.vehicles, meters: l.meters })),
        vehicles,
        before,
        after,
        reroute: afterRe,
        direction: afterFlow,
      },
      {
        closedEids: incident.closedEids,
        flows: afterRe.flows.slice(0, 160),
        cut: afterFlow?.cut ?? [],
        shuttles: legs.map((l) => ({ from: l.from, to: l.to, busesPerHour: l.busesPerHour, capacity: l.capacity })),
      },
    );
  } finally {
    await ctx.tracer.command("drop the plan fork", planFork, `GRAPH.DELETE ${planFork}`, () => deleteGraph(planFork));
  }
  });
}
