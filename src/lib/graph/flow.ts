/**
 * Pure helpers for the disruption model in docs/model.md. FalkorDB does the traversals and the
 * max flow; these turn its rows into the inputs and read the min cut out of its edge flows.
 */

export type Direction = "forward" | "backward";

export interface DisplacedPair {
  o: string;
  d: string;
  riders: number;
  via: number[];
}

interface SegmentEnds {
  from: string;
  to: string;
}

/** Direction of the first closed segment on the pair's path (docs/model.md, "Displaced riders"). */
export function directionOf(
  via: number[],
  closed: ReadonlySet<number>,
  stretchIndex: ReadonlyMap<string, number>,
  segments: ReadonlyMap<number, SegmentEnds>,
): Direction | null {
  for (const eid of via) {
    if (!closed.has(eid)) continue;
    const seg = segments.get(eid);
    if (!seg) continue;
    const a = stretchIndex.get(seg.from);
    const b = stretchIndex.get(seg.to);
    if (a === undefined || b === undefined) continue;
    return b > a ? "forward" : "backward";
  }
  return null;
}

/** Riders per hour that displaced pairs no longer put on each open segment. */
export function freedLoad(pairs: DisplacedPair[], closed: ReadonlySet<number>): Map<number, number> {
  const freed = new Map<number, number>();
  for (const p of pairs) {
    for (const eid of p.via) {
      if (closed.has(eid)) continue;
      freed.set(eid, (freed.get(eid) ?? 0) + p.riders);
    }
  }
  return freed;
}

/** net(x) = riders starting at x − riders ending at x, for one direction group. */
export function netBalance(pairs: DisplacedPair[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const p of pairs) {
    net.set(p.o, (net.get(p.o) ?? 0) + p.riders);
    net.set(p.d, (net.get(p.d) ?? 0) - p.riders);
  }
  for (const [k, v] of net) if (Math.abs(v) < 1e-9) net.delete(k);
  return net;
}

export interface FlowEdge {
  /** Stable key, e.g. "RUNS:812", "WALK:14", "BUS:2", "FEED:SRC>120". */
  key: string;
  from: string;
  to: string;
  capacity: number;
  flow: number;
}

/**
 * Min cut from a max-flow solution: nodes reachable from the source in the residual graph
 * (forward edges with flow < capacity, backward edges with flow > 0), then every edge that
 * leaves that set. Its total capacity equals the max flow.
 */
export function minCut(edges: FlowEdge[], source: string): { reachable: Set<string>; cut: FlowEdge[] } {
  const EPS = 1e-6;
  const out = new Map<string, FlowEdge[]>();
  const inc = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
  }
  const reachable = new Set<string>([source]);
  const queue = [source];
  while (queue.length) {
    const n = queue.shift()!;
    for (const e of out.get(n) ?? []) {
      if (e.capacity - e.flow > EPS && !reachable.has(e.to)) {
        reachable.add(e.to);
        queue.push(e.to);
      }
    }
    for (const e of inc.get(n) ?? []) {
      if (e.flow > EPS && !reachable.has(e.from)) {
        reachable.add(e.from);
        queue.push(e.from);
      }
    }
  }
  const cut = edges.filter((e) => reachable.has(e.from) && !reachable.has(e.to) && e.capacity > EPS);
  return { reachable, cut };
}

/** Straight-line distance in meters (shuttle legs, walking links). */
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Bus planning numbers from docs/model.md: 70 riders per bus, 4 min + 3 min per km of street running. */
const BUS_RIDERS = 70;
export const BUS_FLEET = 120;

export function busLeg(meters: number, busesPerHour: number) {
  const km = meters / 1000;
  const minutes = Math.round((4 + km * 3) * 10) / 10;
  const roundTrip = 2 * minutes + 6;
  return {
    minutes,
    capacity: busesPerHour * BUS_RIDERS,
    vehicles: Math.ceil((busesPerHour * roundTrip) / 60),
  };
}
