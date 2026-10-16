/**
 * Builds the NYC subway network Detour reasons over, from public MTA data only.
 *
 *   pnpm tsx scripts/build-network.ts data/raw data/nyc
 *
 * Inputs (bash scripts/fetch-mta.sh):
 *   <raw>/gtfs/*.txt                    MTA GTFS static, subway
 *   <raw>/stations/stations.json        MTA Subway Stations (data.ny.gov 39hk-dx4f)
 *   <raw>/stations/complexes.json       MTA Subway Stations and Complexes (data.ny.gov 5f5g-n3cz)
 *   <raw>/od/od-2025-10-wed-08.csv      MTA Subway OD Ridership Estimate 2025 (data.ny.gov y2qv-fytt)
 *
 * Outputs: <out>/network.json, <out>/demand.json, <out>/meta.json
 *
 * Method:
 *   - Capacity: weekday trips departing a stop between 08:00 and 08:59 give trains per hour per
 *     (route, station complex pair); capacity = trains per hour × planning capacity per train.
 *   - Demand: average riders per hour between station complexes on October 2025 Wednesdays,
 *     8:00 to 8:59. Pairs under MIN_RIDERS are dropped (they carry under 10% of riders).
 *   - Baseline assignment: every kept pair rides its fastest route-aware path (in-vehicle time,
 *     half-headway waits, a transfer penalty, short street walks). Segment load is the sum.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import type {
  AdaLevel,
  Borough,
  Demand,
  DemandPair,
  Network,
  NetworkMeta,
  Route,
  Segment,
  Station,
  Walk,
} from "../src/lib/network/types";

const [rawDir = "data/raw", outDir = "data/nyc"] = process.argv.slice(2);

const MIN_RIDERS = 2;
const PEAK_START = 8 * 3600;
const PEAK_END = 9 * 3600;
const TRANSFER_PENALTY_MIN = 3;
/** Half the headway, up to a full half hour, so a segment with one train an hour is not attractive. */
const MAX_WAIT_MIN = 30;
const MIN_ASSIGNABLE_TPH = 3;
const WALK_RADIUS_M = 400;
const WALK_SPEED_M_PER_MIN = 75;
const WALK_CAPACITY = 3000;

/** Riders per car at MTA rush-hour guideline loads (planning assumption). */
const CAR_LOAD = { A: 110, B60: 145, B75: 175 } as const;
/** Typical weekday consist per route (planning assumption). */
const CONSIST: Record<string, { cars: number; car: keyof typeof CAR_LOAD }> = {
  "1": { cars: 10, car: "A" }, "2": { cars: 10, car: "A" }, "3": { cars: 10, car: "A" },
  "4": { cars: 10, car: "A" }, "5": { cars: 10, car: "A" }, "6": { cars: 10, car: "A" },
  "7": { cars: 11, car: "A" }, GS: { cars: 6, car: "A" },
  A: { cars: 8, car: "B75" }, C: { cars: 8, car: "B75" }, E: { cars: 10, car: "B60" },
  B: { cars: 8, car: "B75" }, D: { cars: 8, car: "B75" }, F: { cars: 10, car: "B60" },
  M: { cars: 8, car: "B60" }, G: { cars: 5, car: "B60" }, J: { cars: 8, car: "B60" },
  Z: { cars: 8, car: "B60" }, L: { cars: 8, car: "B60" }, N: { cars: 10, car: "B60" },
  Q: { cars: 10, car: "B60" }, R: { cars: 10, car: "B60" }, W: { cars: 10, car: "B60" },
  FS: { cars: 2, car: "B75" }, H: { cars: 4, car: "B75" }, SI: { cars: 4, car: "B75" },
};
const BASE_ROUTE: Record<string, string> = { "6X": "6", "7X": "7", FX: "F" };

type Row = Record<string, string>;

function readCsv(path: string): Row[] {
  return parse(readFileSync(path, "utf8"), { columns: true, skip_empty_lines: true, bom: true });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function seconds(hms: string): number {
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

function boroughOf(code: string): Borough {
  const map: Record<string, Borough> = { M: "M", Bk: "Bk", B: "Bk", Q: "Q", Bx: "Bx", SI: "SI" };
  return map[code] ?? "M";
}

// ---------------------------------------------------------------------------------------------
// Stations

type StationRow = { gtfs_stop_id: string; complex_id: string; borough: string; daytime_routes: string };
type ComplexRow = {
  complex_id: string;
  stop_name: string;
  display_name: string;
  latitude: string;
  longitude: string;
  borough: string;
  cbd: string;
  ada: string;
  ada_notes?: string;
  daytime_routes: string;
  gtfs_stop_ids: string;
};

const stationRows = readJson<StationRow[]>(join(rawDir, "stations/stations.json"));
const complexRows = readJson<ComplexRow[]>(join(rawDir, "stations/complexes.json"));

const stopToComplex = new Map<string, string>();
for (const s of stationRows) stopToComplex.set(s.gtfs_stop_id, s.complex_id);

const stations = new Map<string, Station>();
for (const c of complexRows) {
  const ada = Number(c.ada);
  stations.set(c.complex_id, {
    id: c.complex_id,
    name: c.stop_name,
    label: c.display_name,
    lat: Number(c.latitude),
    lon: Number(c.longitude),
    borough: boroughOf(c.borough),
    cbd: c.cbd === "true",
    ada: (ada === 1 || ada === 2 ? ada : 0) as AdaLevel,
    adaNotes: c.ada_notes && c.ada_notes !== "NaN" ? c.ada_notes : null,
    routes: [],
    entries: 0,
    exits: 0,
  });
}

// ---------------------------------------------------------------------------------------------
// GTFS: trains per hour per (route, complex pair) in the weekday 8 a.m. hour

const routeRows = readCsv(join(rawDir, "gtfs/routes.txt"));
const tripRows = readCsv(join(rawDir, "gtfs/trips.txt"));
const stopTimeRows = readCsv(join(rawDir, "gtfs/stop_times.txt"));

const weekdayTrips = new Map<string, { route: string; direction: string }>();
for (const t of tripRows) {
  if (t.service_id !== "Weekday") continue;
  weekdayTrips.set(t.trip_id, { route: BASE_ROUTE[t.route_id] ?? t.route_id, direction: t.direction_id });
}

const tripStops = new Map<string, { seq: number; stop: string; arr: number; dep: number }[]>();
for (const st of stopTimeRows) {
  if (!weekdayTrips.has(st.trip_id)) continue;
  let list = tripStops.get(st.trip_id);
  if (!list) tripStops.set(st.trip_id, (list = []));
  list.push({ seq: Number(st.stop_sequence), stop: st.stop_id, arr: seconds(st.arrival_time), dep: seconds(st.departure_time) });
}

const parentOf = (stopId: string) => stopId.replace(/[NS]$/, "");

type SegAgg = { route: string; from: string; to: string; trains: number; minutes: number[] };
const segAgg = new Map<string, SegAgg>();
const patternCounts = new Map<string, Map<string, number>>();
const stationRoutes = new Map<string, Set<string>>();

for (const [tripId, stops] of tripStops) {
  const { route, direction } = weekdayTrips.get(tripId)!;
  stops.sort((a, b) => a.seq - b.seq);
  const complexes = stops.map((s) => stopToComplex.get(parentOf(s.stop)));
  if (complexes.some((c) => !c)) continue;

  let ranInPeak = false;
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = complexes[i]!;
    const b = complexes[i + 1]!;
    if (a === b) continue;
    const dep = stops[i].dep;
    if (dep < PEAK_START || dep >= PEAK_END) continue;
    ranInPeak = true;
    const key = `${route}|${a}>${b}`;
    let agg = segAgg.get(key);
    if (!agg) segAgg.set(key, (agg = { route, from: a, to: b, trains: 0, minutes: [] }));
    agg.trains += 1;
    agg.minutes.push(Math.max(0.5, (stops[i + 1].arr - dep) / 60));
  }

  if (ranInPeak) {
    const seq = complexes.filter((c, i) => i === 0 || c !== complexes[i - 1]) as string[];
    for (const c of seq) {
      let set = stationRoutes.get(c);
      if (!set) stationRoutes.set(c, (set = new Set()));
      set.add(route);
    }
    const patternKey = `${direction}:${seq.join(",")}`;
    let counts = patternCounts.get(route);
    if (!counts) patternCounts.set(route, (counts = new Map()));
    counts.set(patternKey, (counts.get(patternKey) ?? 0) + 1);
  }
}

const routes: Route[] = [];
for (const r of routeRows) {
  const id = BASE_ROUTE[r.route_id] ?? r.route_id;
  if (routes.some((x) => x.id === id)) continue;
  const consist = CONSIST[id];
  if (!consist) throw new Error(`No consist assumption for route ${id}`);
  const counts = patternCounts.get(id);
  const patterns: string[][] = [];
  if (counts) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      if (n / total < 0.08 && patterns.length >= 2) continue;
      patterns.push(key.split(":")[1].split(","));
    }
  }
  routes.push({
    id,
    short: r.route_short_name || id,
    longName: r.route_long_name,
    color: (r.route_color || "808183").toUpperCase(),
    textColor: (r.route_text_color || "FFFFFF").toUpperCase(),
    trainCapacity: consist.cars * CAR_LOAD[consist.car],
    patterns,
    sort: Number(r.route_sort_order) || 99,
  });
}
routes.sort((a, b) => a.sort - b.sort);
const routeById = new Map(routes.map((r) => [r.id, r]));

const segments: Segment[] = [...segAgg.values()]
  .sort((a, b) => (a.route + a.from + a.to).localeCompare(b.route + b.from + b.to))
  .map((s, eid) => ({
    eid,
    route: s.route,
    from: s.from,
    to: s.to,
    tph: s.trains,
    minutes: round(median(s.minutes), 2),
    capacity: s.trains * routeById.get(s.route)!.trainCapacity,
    load: 0,
  }));

for (const [id, set] of stationRoutes) {
  const st = stations.get(id);
  if (st) st.routes = [...set].sort((a, b) => routeById.get(a)!.sort - routeById.get(b)!.sort);
}

// ---------------------------------------------------------------------------------------------
// Street walks between nearby complexes

const served = [...stations.values()].filter((s) => s.routes.length > 0);
const walks: Walk[] = [];
for (let i = 0; i < served.length; i++) {
  for (let j = 0; j < served.length; j++) {
    if (i === j) continue;
    const a = served[i];
    const b = served[j];
    const meters = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (meters > WALK_RADIUS_M) continue;
    walks.push({
      wid: walks.length,
      from: a.id,
      to: b.id,
      meters: Math.round(meters),
      minutes: round(2 + meters / WALK_SPEED_M_PER_MIN, 1),
      capacity: WALK_CAPACITY,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Demand

const odRows = readCsv(join(rawDir, "od/od-2025-10-wed-08.csv"));
let totalRiders = 0;
const kept: { o: string; d: string; riders: number }[] = [];
for (const r of odRows) {
  const riders = Number(r.estimated_average_ridership);
  totalRiders += riders;
  const o = r.origin_station_complex_id;
  const d = r.destination_station_complex_id;
  const so = stations.get(o);
  const sd = stations.get(d);
  if (so) so.entries += riders;
  if (sd) sd.exits += riders;
  if (riders < MIN_RIDERS || o === d) continue;
  kept.push({ o, d, riders });
}

// ---------------------------------------------------------------------------------------------
// Baseline assignment: route-aware Dijkstra (state = station × current route)

const stationIds = served.map((s) => s.id);
const stationIndex = new Map(stationIds.map((id, i) => [id, i]));
const R = routes.length;
const routeIndex = new Map(routes.map((r, i) => [r.id, i]));
type Edge = { kind: "seg" | "walk"; idx: number; to: number; route: number; minutes: number; tph: number };
const adjacency: Edge[][] = stationIds.map(() => []);
for (const s of segments) {
  // One-off patterns (a single express run, a short turn) would otherwise pull riders who are
  // already aboard onto a train that rarely comes. They still count as capacity.
  if (s.tph < MIN_ASSIGNABLE_TPH) continue;
  const a = stationIndex.get(s.from);
  const b = stationIndex.get(s.to);
  if (a === undefined || b === undefined) continue;
  adjacency[a].push({ kind: "seg", idx: s.eid, to: b, route: routeIndex.get(s.route)!, minutes: s.minutes, tph: s.tph });
}
for (const w of walks) {
  const a = stationIndex.get(w.from)!;
  const b = stationIndex.get(w.to)!;
  adjacency[a].push({ kind: "walk", idx: w.wid, to: b, route: -1, minutes: w.minutes, tph: 0 });
}

const stateOf = (station: number, route: number) => station * (R + 1) + (route + 1);
const STATES = stationIds.length * (R + 1);

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.keys;
    const v = this.vals;
    const top: [number, number] = [k[0], v[0]];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

const byOrigin = new Map<string, { d: string; riders: number }[]>();
for (const p of kept) {
  let list = byOrigin.get(p.o);
  if (!list) byOrigin.set(p.o, (list = []));
  list.push({ d: p.d, riders: p.riders });
}

const segmentLoad = new Float64Array(segments.length);
const pairs: DemandPair[] = [];
let ridersAssigned = 0;
let unassignedPairs = 0;

for (const [origin, dests] of byOrigin) {
  const o = stationIndex.get(origin);
  if (o === undefined) {
    unassignedPairs += dests.length;
    continue;
  }
  const dist = new Float64Array(STATES).fill(Infinity);
  const prevState = new Int32Array(STATES).fill(-1);
  const prevEdge = new Int32Array(STATES).fill(-1);
  const prevKind = new Uint8Array(STATES);
  const settledAt = new Int32Array(stationIds.length).fill(-1);
  const heap = new MinHeap();
  const start = stateOf(o, -1);
  dist[start] = 0;
  heap.push(0, start);
  let remaining = new Set(dests.map((x) => x.d));

  while (heap.size && remaining.size) {
    const [cost, state] = heap.pop();
    if (cost > dist[state]) continue;
    const station = Math.floor(state / (R + 1));
    const route = (state % (R + 1)) - 1;
    if (settledAt[station] === -1) {
      settledAt[station] = state;
      remaining.delete(stationIds[station]);
    }
    for (const e of adjacency[station]) {
      let next: number;
      let step: number;
      if (e.kind === "walk") {
        next = stateOf(e.to, -1);
        step = e.minutes;
      } else {
        next = stateOf(e.to, e.route);
        const boarding = e.route !== route;
        step = e.minutes + (boarding ? Math.min(MAX_WAIT_MIN, 30 / Math.max(e.tph, 1)) + (route >= 0 ? TRANSFER_PENALTY_MIN : 0) : 0);
      }
      const nd = cost + step;
      if (nd < dist[next]) {
        dist[next] = nd;
        prevState[next] = state;
        prevEdge[next] = e.idx;
        prevKind[next] = e.kind === "seg" ? 1 : 2;
        heap.push(nd, next);
      }
    }
  }

  for (const { d, riders } of dests) {
    const di = stationIndex.get(d);
    const end = di === undefined ? -1 : settledAt[di];
    if (end === -1) {
      unassignedPairs += 1;
      continue;
    }
    const segs: number[] = [];
    const walkIds: number[] = [];
    for (let s = end; s !== start && s !== -1; s = prevState[s]) {
      if (prevKind[s] === 1) segs.push(prevEdge[s]);
      else if (prevKind[s] === 2) walkIds.push(prevEdge[s]);
    }
    segs.reverse();
    walkIds.reverse();
    for (const eid of segs) segmentLoad[eid] += riders;
    ridersAssigned += riders;
    pairs.push([origin, d, round(riders, 1), round(dist[end], 1), segs, walkIds]);
  }
  remaining = new Set();
}

for (const s of segments) s.load = Math.round(segmentLoad[s.eid]);

// ---------------------------------------------------------------------------------------------
// Write

const network: Network = {
  stations: [...stations.values()]
    .filter((s) => s.routes.length > 0)
    .map((s) => ({ ...s, entries: Math.round(s.entries), exits: Math.round(s.exits) }))
    .sort((a, b) => Number(a.id) - Number(b.id)),
  routes,
  segments,
  walks,
};
const demand: Demand = { pairs };

const overloaded = segments.filter((s) => s.load > s.capacity).length;
const meta: NetworkMeta = {
  builtAt: new Date().toISOString(),
  sources: [
    { name: "MTA GTFS static (subway)", url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip", slice: "service_id Weekday, departures 08:00-08:59", retrieved: "2026-10-16" },
    { name: "MTA Subway Stations", url: "https://data.ny.gov/d/39hk-dx4f", retrieved: "2026-10-16" },
    { name: "MTA Subway Stations and Complexes", url: "https://data.ny.gov/d/5f5g-n3cz", retrieved: "2026-10-16" },
    { name: "MTA Subway Origin-Destination Ridership Estimate: 2025", url: "https://data.ny.gov/d/y2qv-fytt", slice: "October 2025, Wednesday, hour 8", retrieved: "2026-10-16" },
  ],
  assumptions: {
    peakWindow: "08:00-08:59 weekday",
    riderLoadPerCarA: CAR_LOAD.A,
    riderLoadPerCar60ft: CAR_LOAD.B60,
    riderLoadPerCar75ft: CAR_LOAD.B75,
    minRidersPerPair: MIN_RIDERS,
    transferPenaltyMinutes: TRANSFER_PENALTY_MIN,
    maxWaitMinutes: MAX_WAIT_MIN,
    minTrainsPerHourForAssignment: MIN_ASSIGNABLE_TPH,
    walkRadiusMeters: WALK_RADIUS_M,
    walkSpeedMetersPerMinute: WALK_SPEED_M_PER_MIN,
    walkCapacityPerHour: WALK_CAPACITY,
    assignment: "all-or-nothing, route-aware shortest time (in-vehicle + half-headway wait + transfer penalty)",
  },
  counts: {
    stations: network.stations.length,
    routes: routes.length,
    segments: segments.length,
    walks: walks.length,
    demandPairs: pairs.length,
    overloadedSegments: overloaded,
  },
  ridership: {
    totalRiders: Math.round(totalRiders),
    pairsTotal: odRows.length,
    pairsKept: kept.length,
    ridersKept: Math.round(kept.reduce((a, b) => a + b.riders, 0)),
    ridersAssigned: Math.round(ridersAssigned),
    unassignedPairs,
  },
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "network.json"), JSON.stringify(network));
writeFileSync(join(outDir, "demand.json"), JSON.stringify(demand));
writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));

console.log(JSON.stringify({ counts: meta.counts, ridership: meta.ridership }, null, 2));
