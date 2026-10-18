import { stretchBetween } from "../network/stretch";
import type { DemandPair, Network } from "../network/types";

/**
 * Ground truth for the eval, computed in plain TypeScript from the data files, never from FalkorDB: the same model
 * the graph tools implement (seed.ts, incident.ts, impact.ts, riders.ts), written a second time as array code so
 * the graph agent is graded against something it cannot have influenced.
 */

/** seed.ts: boarding costs a transfer penalty plus half the headway, capped. */
const TRANSFER_PENALTY_MINUTES = 3;
const MAX_WAIT_MINUTES = 30;
/** impact.ts walks this many hops upstream of the closure. */
export const MAX_DEPTH = 8;
const EPS = 1e-6;

export interface Closure {
  routes: string[];
  stretch: string[];
  closedEids: number[];
}

/** incident.ts closeLine: the stretch from the routes' stop patterns, and every RUNS edge of those routes inside it. */
export function closeLine(network: Network, routes: string[], from: string, to: string): Closure | null {
  const stretch = stretchBetween(network, routes, from, to);
  if (!stretch) return null;
  const inside = new Set(stretch);
  const closedEids = network.segments
    .filter((s) => routes.includes(s.route) && inside.has(s.from) && inside.has(s.to))
    .map((s) => s.eid)
    .sort((a, b) => a - b);
  return { routes, stretch, closedEids };
}

/** impact.ts displacedPairs: the origin-destination pairs whose baseline path uses a closed segment. */
export function displaced(pairs: DemandPair[], closedEids: number[]): DemandPair[] {
  const closed = new Set(closedEids);
  return pairs.filter((p) => p[4].some((e) => closed.has(e)));
}

/** impact.ts hopsToStretch: RUNS hops against the train direction (any route, closed or not) to the stretch. */
export function hopsToStretch(network: Network, stretch: string[], maxDepth = MAX_DEPTH): Map<string, number> {
  const upstream = new Map<string, Set<string>>();
  for (const s of network.segments) {
    if (!upstream.has(s.to)) upstream.set(s.to, new Set());
    upstream.get(s.to)!.add(s.from);
  }
  const hops = new Map(stretch.map((id) => [id, 0]));
  let frontier = [...stretch];
  for (let k = 1; k <= maxDepth && frontier.length; k++) {
    const next: string[] = [];
    for (const id of frontier) for (const o of upstream.get(id) ?? []) if (!hops.has(o) && !next.includes(o)) next.push(o);
    for (const id of next) hops.set(id, k);
    frontier = next;
  }
  return hops;
}

export interface Impact {
  total: number;
  pairs: number;
  /** Riders an hour whose origin is within k hops of the closure, k = 0..MAX_DEPTH. */
  byDepth: number[];
}

export function impact(network: Network, pairs: DemandPair[], closure: Closure): Impact {
  const hit = displaced(pairs, closure.closedEids);
  const hops = hopsToStretch(network, closure.stretch);
  const byDepth = Array.from({ length: MAX_DEPTH + 1 }, (_, k) =>
    Math.round(hit.reduce((s, p) => s + ((hops.get(p[0]) ?? Infinity) <= k ? p[2] : 0), 0)),
  );
  return { total: Math.round(hit.reduce((s, p) => s + p[2], 0)), pairs: hit.length, byDepth };
}

/** Stations reachable from `from` over open segments and walking links (what route_rider can find during a closure). */
export function reachable(network: Network, from: string, closedEids: number[] = []): Set<string> {
  const closed = new Set(closedEids);
  const next = new Map<string, string[]>();
  const link = (a: string, b: string) => next.set(a, [...(next.get(a) ?? []), b]);
  for (const s of network.segments) if (!closed.has(s.eid)) link(s.from, s.to);
  for (const w of network.walks) link(w.from, w.to);
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const x = queue.shift()!;
    for (const y of next.get(x) ?? []) {
      if (seen.has(y)) continue;
      seen.add(y);
      queue.push(y);
    }
  }
  return seen;
}

// ------------------------------------------------------------------ routing

type Edge = { to: number; minutes: number; board: boolean; station: string; route: string | null; kind: "BOARD" | "ALIGHT" | "RIDE" | "WALK"; eid?: number };

/** The platform layer of seed.ts as adjacency lists: a node per station and per station and route. */
export interface PlatformGraph {
  index: Map<string, number>;
  edges: Edge[][];
}

export function platformGraph(network: Network): PlatformGraph {
  const platformTph = new Map<string, number>();
  for (const e of network.segments) {
    for (const key of [`${e.from}:${e.route}`, `${e.to}:${e.route}`]) if (!platformTph.has(key)) platformTph.set(key, 0);
    platformTph.set(`${e.from}:${e.route}`, Math.max(platformTph.get(`${e.from}:${e.route}`) ?? 0, e.tph));
  }
  const index = new Map<string, number>();
  const edges: Edge[][] = [];
  const node = (key: string) => {
    let i = index.get(key);
    if (i === undefined) {
      i = edges.length;
      index.set(key, i);
      edges.push([]);
    }
    return i;
  };
  for (const s of network.stations) node(`s:${s.id}`);
  for (const [id, tph] of platformTph) {
    const [station, route] = id.split(":");
    const board = Math.round((TRANSFER_PENALTY_MINUTES + Math.min(MAX_WAIT_MINUTES, 30 / Math.max(1, tph))) * 10) / 10;
    const s = node(`s:${station}`);
    const p = node(`p:${id}`);
    edges[s].push({ to: p, minutes: board, board: true, station, route, kind: "BOARD" });
    edges[p].push({ to: s, minutes: 0, board: false, station, route, kind: "ALIGHT" });
  }
  for (const e of network.segments) {
    edges[node(`p:${e.from}:${e.route}`)].push({ to: node(`p:${e.to}:${e.route}`), minutes: e.minutes, board: false, station: e.to, route: e.route, kind: "RIDE", eid: e.eid });
  }
  for (const w of network.walks) {
    edges[node(`s:${w.from}`)].push({ to: node(`s:${w.to}`), minutes: w.minutes, board: false, station: w.to, route: null, kind: "WALK" });
  }
  return { index, edges };
}

/** A small binary heap of [priority, secondary, node]. */
class Heap {
  private items: [number, number, number][] = [];
  get size() {
    return this.items.length;
  }
  private less(a: [number, number, number], b: [number, number, number]) {
    return a[0] < b[0] - EPS || (Math.abs(a[0] - b[0]) <= EPS && a[1] < b[1]);
  }
  push(item: [number, number, number]) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(a[i], a[parent])) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }
  pop(): [number, number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export interface Trip {
  minutes: number;
  /** Fewest and most boardings among the paths of that weight: the transfers question is asked only when they agree. */
  minBoardings: number;
  maxBoardings: number;
}

export interface TripOptions {
  closedEids?: number[];
  /** Only board and alight where this holds (step-free routing). */
  stepOk?: (station: string, route: string) => boolean;
}

/**
 * Weighted shortest path on the platform layer, lexicographic on (minutes, boardings): run once for the fewest
 * boardings among the fastest paths and once for the most. Boarding edges always cost minutes, so the secondary
 * key never makes a cheaper path look dearer and Dijkstra stays exact.
 */
function shortest(g: PlatformGraph, from: string, to: string, o: TripOptions, sign: 1 | -1): { minutes: number; boardings: number } | null {
  const closed = new Set(o.closedEids ?? []);
  const src = g.index.get(`s:${from}`);
  const dst = g.index.get(`s:${to}`);
  if (src === undefined || dst === undefined || from === to) return null;
  const best: [number, number][] = g.edges.map(() => [Infinity, Infinity]);
  best[src] = [0, 0];
  const heap = new Heap();
  heap.push([0, 0, src]);
  const better = (a: [number, number], b: [number, number]) => a[0] < b[0] - EPS || (Math.abs(a[0] - b[0]) <= EPS && a[1] < b[1]);
  while (heap.size) {
    const [d, b, u] = heap.pop();
    if (better(best[u], [d, b])) continue;
    if (u === dst) return { minutes: d, boardings: sign * b };
    for (const e of g.edges[u]) {
      if (e.eid !== undefined && closed.has(e.eid)) continue;
      if (o.stepOk && (e.kind === "BOARD" || e.kind === "ALIGHT") && !o.stepOk(e.station, e.route!)) continue;
      const next: [number, number] = [d + e.minutes, b + (e.board ? sign : 0)];
      if (better(next, best[e.to])) {
        best[e.to] = next;
        heap.push([next[0], next[1], e.to]);
      }
    }
  }
  return null;
}

/** The fastest trip as route_rider prices it, or null when no open path connects the two stations. */
export function fastestTrip(g: PlatformGraph, from: string, to: string, o: TripOptions = {}): Trip | null {
  const fewest = shortest(g, from, to, o, 1);
  if (!fewest) return null;
  const most = shortest(g, from, to, o, -1)!;
  return { minutes: Math.round(fewest.minutes * 10) / 10, minBoardings: fewest.boardings, maxBoardings: most.boardings };
}

/** Transfers the way riders.ts counts them: train legs minus one (walks are not legs). */
export const transfersOf = (boardings: number) => Math.max(0, boardings - 1);

/**
 * route_rider's step-free rule: every boarding and exit at a fully accessible station (ADA level 1), and not on a
 * platform whose elevator memory says is out now.
 */
export function stepFreeRule(network: Network, outages: { station: string; routes: string[] }[]): (station: string, route: string) => boolean {
  const ada = new Map(network.stations.map((s) => [s.id, s.ada]));
  return (station, route) => {
    if (ada.get(station) !== 1) return false;
    return !outages.some((o) => o.station === station && (!o.routes.length || o.routes.includes(route)));
  };
}
