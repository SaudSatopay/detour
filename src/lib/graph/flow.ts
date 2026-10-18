/**
 * Pure helpers for the disruption model in docs/model.md. FalkorDB does the traversals and the
 * max flow; these turn its rows into the inputs, check its answers with a max-flow/min-cut
 * certificate (recomputing with Dinic's algorithm when one fails), and read the min cut out of
 * its edge flows.
 */
import type { Network } from "../network/types";
import { stretchBetween } from "../network/stretch";

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

/** A capacitated edge with no flow yet. Parallel edges are fine as long as keys differ. */
export type CapEdge = Omit<FlowEdge, "flow">;

/**
 * Exact max flow by Dinic's algorithm (level graph by BFS, blocking flow by DFS with current-arc
 * pointers) on float capacities. Detour's own solver: it recomputes a flow when FalkorDB's
 * algo.maxFlow fails its certificate. Returns the value and each edge's flow, in input order.
 */
export function dinicMaxFlow(edges: readonly CapEdge[], source: string, sink: string): { value: number; flows: number[] } {
  const index = new Map<string, number>();
  const node = (id: string) => index.get(id) ?? (index.set(id, index.size), index.size - 1);
  node(source);
  node(sink);
  // Arc 2i is edge i, arc 2i + 1 its reverse; residual[] holds what each arc can still carry.
  const head: number[] = [];
  const residual: number[] = [];
  const tails: number[] = [];
  for (const e of edges) {
    const a = node(e.from);
    const b = node(e.to);
    head.push(b, a);
    tails.push(a, b);
    residual.push(Math.max(0, e.capacity), 0);
  }
  const out: number[][] = Array.from({ length: index.size }, () => []);
  for (let arc = 0; arc < head.length; arc++) out[tails[arc]].push(arc);
  const s = index.get(source)!;
  const t = index.get(sink)!;
  const scale = edges.reduce((m, e) => Math.max(m, e.capacity), 1);
  const EPS = 1e-12 * scale;
  let value = 0;
  if (s !== t) {
    const level = new Int32Array(index.size);
    const next = new Int32Array(index.size);
    const push = (v: number, limit: number): number => {
      if (v === t) return limit;
      for (; next[v] < out[v].length; next[v]++) {
        const arc = out[v][next[v]];
        const w = head[arc];
        if (residual[arc] <= EPS || level[w] !== level[v] + 1) continue;
        const pushed = push(w, Math.min(limit, residual[arc]));
        if (pushed > EPS) {
          residual[arc] -= pushed;
          residual[arc ^ 1] += pushed;
          return pushed;
        }
      }
      return 0;
    };
    for (;;) {
      level.fill(-1);
      level[s] = 0;
      const queue = [s];
      for (let i = 0; i < queue.length; i++) {
        for (const arc of out[queue[i]]) {
          if (residual[arc] > EPS && level[head[arc]] < 0) {
            level[head[arc]] = level[queue[i]] + 1;
            queue.push(head[arc]);
          }
        }
      }
      if (level[t] < 0) break;
      next.fill(0);
      for (let f = push(s, Infinity); f > EPS; f = push(s, Infinity)) value += f;
    }
  }
  const flows = edges.map((e, i) => Math.min(Math.max(0, e.capacity), Math.max(0, residual[2 * i + 1])));
  return { value, flows };
}

interface FlowCertificate {
  /** Feasible, maximal, and the reported value is the flow's value: the number can be trusted. */
  checked: boolean;
  /** Every edge within capacity and flow conserved at every node but the source and sink. */
  feasible: boolean;
  /** No augmenting path: the sink is unreachable from the source in the residual graph. */
  maximal: boolean;
  /** What the solver said the max flow was. */
  reported: number;
  /** Net flow out of the source, read from the edge flows. */
  value: number;
  /** Capacity of the edges leaving the residual-reachable set; equals the value when the flow is maximal. */
  cutCapacity: number;
  /** Largest capacity or conservation violation found, riders an hour. */
  worstViolation: number;
  /** At most five plain descriptions of what failed. */
  problems: string[];
  tolerance: number;
}

/**
 * Max-flow/min-cut certificate for a solver's answer: the flow is feasible (0 ≤ flow ≤ capacity,
 * conservation at every node but the source and sink), the sink is unreachable in the residual
 * graph, and the reported value equals both the source's net outflow and the residual cut's
 * capacity. Any one failing means the answer is not a maximum flow.
 */
export function certifyMaxFlow(edges: readonly FlowEdge[], source: string, sink: string, reported: number): FlowCertificate {
  const scale = edges.reduce((m, e) => Math.max(m, e.capacity), 1);
  const tol = 1e-6 * scale;
  const problems: string[] = [];
  let worst = 0;
  const note = (amount: number, text: string) => {
    worst = Math.max(worst, amount);
    if (problems.length < 5) problems.push(text);
  };
  const balance = new Map<string, number>();
  for (const e of edges) {
    if (e.flow < -tol) note(-e.flow, `${e.key} carries negative flow ${e.flow.toFixed(3)}`);
    if (e.flow > e.capacity + tol) note(e.flow - e.capacity, `${e.key} carries ${e.flow.toFixed(3)} over its capacity ${e.capacity.toFixed(3)}`);
    balance.set(e.from, (balance.get(e.from) ?? 0) + e.flow);
    balance.set(e.to, (balance.get(e.to) ?? 0) - e.flow);
  }
  for (const [id, net] of balance) {
    if (id === source || id === sink) continue;
    if (Math.abs(net) > tol) note(Math.abs(net), `flow is not conserved at ${id}: ${net > 0 ? "sends" : "receives"} ${Math.abs(net).toFixed(3)} more than it ${net > 0 ? "receives" : "sends"}`);
  }
  const feasible = problems.length === 0;
  const value = balance.get(source) ?? 0;
  if (Math.abs(value - reported) > tol) note(Math.abs(value - reported), `reported ${reported.toFixed(3)} but the flows move ${value.toFixed(3)} out of the source`);

  const { reachable } = minCut(edges as FlowEdge[], source);
  const maximal = !reachable.has(sink);
  if (!maximal) problems.push("an augmenting path from source to sink remains in the residual graph");
  const cutCapacity = edges.reduce((sum, e) => (reachable.has(e.from) && !reachable.has(e.to) ? sum + e.capacity : sum), 0);
  if (maximal && Math.abs(cutCapacity - value) > tol * Math.max(1, edges.length / 100)) {
    note(Math.abs(cutCapacity - value), `cut capacity ${cutCapacity.toFixed(3)} differs from the flow value ${value.toFixed(3)}`);
  }
  return {
    checked: problems.length === 0,
    feasible,
    maximal,
    reported,
    value,
    cutCapacity,
    worstViolation: worst,
    problems: problems.slice(0, 5),
    tolerance: tol,
  };
}

/**
 * Stations a closure cuts off, by connectivity over edges with spare capacity: an origin is cut
 * off when it reaches no destination of its group, a destination when no origin reaches it.
 * No capacity anywhere can help their riders; only new links (shuttles) can.
 */
export function cutOffStations(
  edges: readonly CapEdge[],
  sources: ReadonlyMap<string, number>,
  sinks: ReadonlyMap<string, number>,
): { id: string; side: "origin" | "destination"; riders: number }[] {
  const fwd = new Map<string, string[]>();
  const back = new Map<string, string[]>();
  for (const e of edges) {
    if (e.capacity <= 1e-9) continue;
    (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
    (back.get(e.to) ?? back.set(e.to, []).get(e.to)!).push(e.from);
  }
  const reach = (start: Iterable<string>, adj: Map<string, string[]>) => {
    const seen = new Set(start);
    const queue = [...seen];
    for (let i = 0; i < queue.length; i++) {
      for (const n of adj.get(queue[i]) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return seen;
  };
  // Nodes some origin can reach, and nodes that can reach some destination.
  const fromSources = reach(sources.keys(), fwd);
  const toSinks = reach(sinks.keys(), back);
  return [
    ...[...sources].filter(([id]) => !toSinks.has(id)).map(([id, riders]) => ({ id, side: "origin" as const, riders })),
    ...[...sinks].filter(([id]) => !fromSources.has(id)).map(([id, riders]) => ({ id, side: "destination" as const, riders })),
  ].sort((a, b) => b.riders - a.riders);
}

interface Headroom {
  /** Riders an hour that can reach the open network at all (max flow with unlimited spare). */
  connected: number;
  /** Demand multiplier at which the first open segment saturates; null when it is beyond maxScale. */
  multiplier: number | null;
  /** Network edges in the cut that binds at that multiplier: the segments that saturate first. */
  saturating: CapEdge[];
  /** Max-flow solves the search took. */
  solves: number;
}

/**
 * Parametric max flow over a demand scale λ (every feed capacity × λ). The max flow f(λ) is the
 * lower envelope of the cuts' lines λ·F + N, where F is a cut's feed capacity at λ = 1 and N its
 * network capacity. For small λ only feed cuts bind and f(λ) = λ·F0, where F0 is the connected
 * demand. The headroom is the first breakpoint, where a cut through an open segment starts to
 * bind. Newton's method on the breakpoints finds it exactly: from λ, take the min cut and jump to
 * where its line meets λ·F0; the sequence decreases and stops at the breakpoint in a few solves.
 *
 * `solve` returns each edge's flow at demand scale λ, given those capacities too (FalkorDB in
 * the app, Dinic in tests); the cut is read from those flows.
 */
export async function parametricHeadroom(
  edges: readonly (CapEdge & { feed: boolean })[],
  source: string,
  sink: string,
  solve: (lambda: number, capacities: number[]) => Promise<number[]> | number[],
  maxScale = 50,
): Promise<Headroom> {
  const big = edges.reduce((s, e) => s + (e.feed ? e.capacity : 0), 1) * (maxScale + 1);
  const unlimited = edges.map((e) => ({ ...e, capacity: e.feed ? e.capacity : e.capacity > 1e-9 ? big : 0 }));
  const connected = dinicMaxFlow(unlimited, source, sink).value;
  if (connected <= 1e-9) return { connected: 0, multiplier: null, saturating: [], solves: 0 };

  let lambda = maxScale;
  let binding: CapEdge[] = [];
  let solves = 0;
  for (let i = 0; i < 40; i++) {
    const caps = edges.map((e) => (e.feed ? e.capacity * lambda : e.capacity));
    const flows = await solve(lambda, caps);
    solves++;
    const scaled = edges.map((e, k) => ({ key: e.key, from: e.from, to: e.to, capacity: caps[k], flow: flows[k] }));
    const value = scaled.reduce((s, e) => s + (e.from === source ? e.flow : 0) - (e.to === source ? e.flow : 0), 0);
    if (value >= lambda * connected * (1 - 1e-9) - 1e-6) {
      // No cut is below the feed line at λ: either the breakpoint lies beyond maxScale, or λ is it.
      return { connected, multiplier: i === 0 ? null : lambda, saturating: binding, solves };
    }
    const { reachable } = minCut(scaled, source);
    let feedCap = 0;
    let netCap = 0;
    const crossing: CapEdge[] = [];
    edges.forEach((e, k) => {
      if (!reachable.has(e.from) || reachable.has(e.to)) return;
      if (e.feed) feedCap += e.capacity;
      else {
        netCap += caps[k];
        if (caps[k] > 1e-9) crossing.push({ key: e.key, from: e.from, to: e.to, capacity: caps[k] });
      }
    });
    if (connected - feedCap <= 1e-9) break; // cannot happen for a valid min cut; stop rather than divide by zero
    binding = crossing.sort((a, b) => a.capacity - b.capacity);
    lambda = netCap / (connected - feedCap);
  }
  return { connected, multiplier: lambda, saturating: binding, solves };
}

/** Deterministic PRNG (mulberry32) so held-out closures are the same on every run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ClosureSpec {
  id: string;
  title: string;
  report: string;
  routes: string[];
  /** The closed stretch, end to end, as close_line derives it from the two ends. */
  stations: string[];
}

/**
 * Held-out closures for the evaluation: `count` stretches of 2 to 6 segments on one line each,
 * drawn with a fixed seed. Lines are taken in a shuffled round so every line with a stretch that
 * long is used before any repeats; each stretch is re-derived with stretchBetween so it is exactly
 * the one close_line would close, and no closure appears twice.
 */
export function heldOutClosures(network: Network, count: number, seed: number): ClosureSpec[] {
  const rand = seededRandom(seed);
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  const lines = network.routes.filter((r) => r.patterns.some((p) => p.length >= 3)).map((r) => r.id).sort();
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }
  const seen = new Set<string>();
  const out: ClosureSpec[] = [];
  for (let attempt = 0; out.length < count && attempt < count * 50; attempt++) {
    const route = network.routes.find((r) => r.id === lines[attempt % lines.length])!;
    const patterns = route.patterns.filter((p) => p.length >= 3);
    const pattern = patterns[Math.floor(rand() * patterns.length)];
    const segments = Math.min(pattern.length - 1, 2 + Math.floor(rand() * 5));
    const start = Math.floor(rand() * (pattern.length - segments));
    const stretch = stretchBetween(network, [route.id], pattern[start], pattern[start + segments]);
    if (!stretch || stretch.length < 3 || stretch.length > 7) continue;
    const key = `${route.id}:${[...stretch].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = names.get(stretch[0]) ?? stretch[0];
    const to = names.get(stretch[stretch.length - 1]) ?? stretch[stretch.length - 1];
    out.push({
      id: `h${String(out.length + 1).padStart(2, "0")}-${route.id.toLowerCase()}`,
      title: `${route.id}: ${from} to ${to}`,
      report: `Held-out closure: no ${route.id} service between ${from} and ${to}.`,
      routes: [route.id],
      stations: stretch,
    });
  }
  return out;
}

/** What a shuttle plan buys, as the scripted controller scores it: riders with no path plus max-flow shortfall cleared. */
export function planGain(p: { before: { stranded: number; unmet: number }; after: { stranded: number; unmet: number } }): number {
  return p.before.stranded - p.after.stranded + (p.before.unmet - p.after.unmet);
}

/**
 * Policy gap for one closure: how much gain per bus the controller's choice leaves on the table
 * against the best single leg an exhaustive search found, as a share of the best (0 = optimal).
 * A choice of "no buses" is optimal only when no leg has positive gain.
 */
export function policyGap(chosenPerBus: number | null, oraclePerBus: number | null): number {
  const best = oraclePerBus !== null && oraclePerBus > 0 ? oraclePerBus : 0;
  const mine = chosenPerBus !== null && chosenPerBus > 0 ? chosenPerBus : 0;
  if (best === 0) return 0;
  return Math.max(0, (best - mine) / best);
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
