/**
 * Detour with memory against Detour without it, measured. Writes data/eval/memory.json, which the proof page shows.
 *
 *   elevators  Real MTA records (data/eval/elevator-availability.json, 698 elevators and escalators, monthly since
 *              2015). A time-ordered replay: each month, before that month's records are read, a step-free rider
 *              is sent through one of two units of the same kind at the same station. Three arms differ only in
 *              memory: none (a coin), a placebo that keeps every record forever (no validity window, no
 *              SUPERSEDES), and Detour's time-aware memory. Computed here in TypeScript, no FalkorDB.
 *   stepFree   FalkorDB: an elevator outage is written to memory at each of 40 accessible platforms, and the
 *              step-free trips that would use it are routed with memory off and on.
 *   buses      FalkorDB: leave-one-out over past shuttle incidents (seeded plus a synthetic history with known
 *              observed/planned ratios): how far the riders a bus bridge carries land from what it was sized for.
 *   sessions   FalkorDB: facts written in one session change the answers a later session gives.
 *   race       FalkorDB: 10, 50 and 100 simultaneous reports about one elevator leave exactly one open fact.
 *
 *   FALKORDB_URL=falkor://127.0.0.1:6380 pnpm eval:memory [--only elevators,stepfree,buses,sessions,race]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, run } from "../../src/lib/graph/db";
import { ensureBaseGraphs } from "../../src/lib/graph/seed";
import { dropSandbox, ensureSandbox } from "../../src/lib/graph/tenancy";
import { Tracer } from "../../src/lib/graph/trace";
import { recall, reportElevator, shuttleShare, type RememberedIncident } from "../../src/lib/graph/tools/memory";
import { listRiders, routeRider, type RouteAnswer } from "../../src/lib/graph/tools/riders";
import type { ToolContext } from "../../src/lib/graph/tools/types";
import { loadNetwork } from "../../src/lib/network/data";
import type { Network } from "../../src/lib/network/types";

const OUT = "data/eval/memory.json";
const SEED = 20261019;
const BOOT = 2000;

/* Deterministic randomness and confidence intervals */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

/** 95% interval from a seeded bootstrap that resamples whole clusters (stations), since decisions at one station are not independent. */
function clusterBootstrap<T>(items: T[], clusterOf: (x: T) => string, stat: (xs: T[]) => number, seed = SEED): [number, number] {
  const groups = [...items.reduce((m, x) => m.set(clusterOf(x), [...(m.get(clusterOf(x)) ?? []), x]), new Map<string, T[]>()).values()];
  const r = rng(seed);
  const stats: number[] = [];
  for (let b = 0; b < BOOT; b++) {
    const sample: T[] = [];
    for (let i = 0; i < groups.length; i++) sample.push(...groups[Math.floor(r() * groups.length)]);
    stats.push(stat(sample));
  }
  stats.sort((a, b) => a - b);
  return [round(quantile(stats, 0.025)), round(quantile(stats, 0.975))];
}

/* 1. Elevators and escalators: real records, time-ordered replay */

interface Unit {
  code: string;
  type: string;
  station: string;
  a: (number | null)[];
  u: (number | null)[];
}

interface Slice {
  source: Record<string, unknown>;
  first: string;
  months: number;
  units: Unit[];
}

/** One monthly record as memory holds it: valid from when it is read (the next month) for `window` months, unless superseded. */
interface Fact {
  month: number;
  a: number;
  u: number | null;
  validFrom: number;
  validTo: number;
  supersededAt: number | null;
}

type Arm = "none" | "placebo" | "timeAware";
const ARMS: Arm[] = ["none", "placebo", "timeAware"];

/** Detour's validity window for a unit's monthly record: a year, so each season is seen once. The sensitivity table varies it. */
const WINDOW = 12;
/** A unit out for most of two straight months was overhauled or replaced: the record from before no longer describes it. */
const OVERHAUL = 0.5;

class UnitMemory {
  facts = new Map<string, Fact[]>();

  /** Reads month m's records, which become valid at m + 1. A unit back from an overhaul supersedes its open facts. */
  ingest(units: Unit[], m: number, window: number) {
    for (const unit of units) {
      const a = unit.a[m];
      if (a === null || a === undefined) continue;
      const list = this.facts.get(unit.code) ?? [];
      const back = a >= OVERHAUL && (unit.a[m - 1] ?? 1) < OVERHAUL && (unit.a[m - 2] ?? 1) < OVERHAUL;
      if (back) for (const f of list) if (f.supersededAt === null) f.supersededAt = m + 1;
      list.push({ month: m, a, u: unit.u[m], validFrom: m + 1, validTo: m + 1 + window, supersededAt: null });
      this.facts.set(unit.code, list);
    }
  }

  /** The facts an arm may read at decision time t. Every one was read before t: the replay never looks ahead. */
  read(code: string, t: number, arm: Arm): Fact[] {
    const all = this.facts.get(code) ?? [];
    for (const f of all) if (f.validFrom > t) throw new Error(`leak: a record valid from month ${f.validFrom} read at ${t}`);
    if (arm === "none") return [];
    if (arm === "placebo") return all;
    return all.filter((f) => f.validTo > t && (f.supersededAt === null || f.supersededAt > t));
  }
}

const monthIndex = (first: string, ym: string) => (Number(ym.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(ym.slice(5, 7)) - Number(first.slice(5, 7));
const monthName = (first: string, i: number) => {
  const m = Number(first.slice(0, 4)) * 12 + Number(first.slice(5, 7)) - 1 + i;
  return new Date(Date.UTC(Math.floor(m / 12), m % 12, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
};

interface Decision {
  t: number;
  station: string;
  type: string;
  units: [string, string];
  actual: [number, number];
  remembered: Record<Arm, [number | null, number | null]>;
  correct: Record<Arm, 0 | 1>;
}

function replay(slice: Slice, holdFrom: number, holdTo: number, window: number): Decision[] {
  const memory = new UnitMemory();
  const coins = Object.fromEntries(ARMS.map((arm, i) => [arm, rng(SEED + i)])) as Record<Arm, () => number>;
  const out: Decision[] = [];
  for (let t = 0; t < slice.months; t++) {
    if (t >= holdFrom && t <= holdTo) {
      const groups = new Map<string, Unit[]>();
      for (const u of slice.units) if (u.a[t] !== null && u.a[t] !== undefined) groups.set(`${u.station}|${u.type}`, [...(groups.get(`${u.station}|${u.type}`) ?? []), u]);
      for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
        list.sort((a, b) => a.code.localeCompare(b.code));
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const [x, y] = [list[i], list[j]];
            const ax = x.a[t]!;
            const ay = y.a[t]!;
            // Only pairs where one unit really ran more that month; a tie has no right answer.
            if (Math.abs(ax - ay) <= 0.005) continue;
            const remembered = {} as Decision["remembered"];
            const correct = {} as Decision["correct"];
            for (const arm of ARMS) {
              const fx = memory.read(x.code, t, arm);
              const fy = memory.read(y.code, t, arm);
              const sx = fx.length ? mean(fx.map((f) => f.a)) : null;
              const sy = fy.length ? mean(fy.map((f) => f.a)) : null;
              remembered[arm] = [sx === null ? null : round(sx, 4), sy === null ? null : round(sy, 4)];
              // No memory (or nothing valid to go on, or a tie): a coin picks.
              const pickX = sx === null || sy === null || sx === sy ? coins[arm]() < 0.5 : sx > sy;
              correct[arm] = pickX === ax > ay ? 1 : 0;
            }
            out.push({ t, station: key.split("|")[0], type: key.split("|")[1], units: [x.code, y.code], actual: [ax, ay], remembered, correct });
          }
        }
      }
    }
    memory.ingest(slice.units, t, window);
  }
  return out;
}

function elevatorEval() {
  const slice = JSON.parse(readFileSync("data/eval/elevator-availability.json", "utf8")) as Slice;
  const holdFrom = monthIndex(slice.first, "2026-01");
  const holdTo = monthIndex(slice.first, "2026-08");
  const decisions = replay(slice, holdFrom, holdTo, WINDOW);
  const acc = (arm: Arm) => (xs: Decision[]) => mean(xs.map((d) => d.correct[arm]));
  const byStation = (d: Decision) => d.station;
  const arms = Object.fromEntries(
    ARMS.map((arm) => [arm, { accuracy: round(acc(arm)(decisions)), ci: clusterBootstrap(decisions, byStation, acc(arm)) }]),
  ) as Record<Arm, { accuracy: number; ci: [number, number] }>;
  const diff = (a: Arm, b: Arm) => {
    const stat = (xs: Decision[]) => acc(a)(xs) - acc(b)(xs);
    return { value: round(stat(decisions)), ci: clusterBootstrap(decisions, byStation, stat) };
  };
  const byType = Object.fromEntries(
    [...new Set(decisions.map((d) => d.type))].sort().map((type) => {
      const xs = decisions.filter((d) => d.type === type);
      return [type, { n: xs.length, ...Object.fromEntries(ARMS.map((arm) => [arm, round(acc(arm)(xs))])) }];
    }),
  );

  // Sensitivity: the same replay with other validity windows.
  const sensitivity = [3, 6, 12, 24].map((w) => ({ windowMonths: w, accuracy: round(acc("timeAware")(replay(slice, holdFrom, holdTo, w))) }));

  // The failure-prone list: at the start of the holdout, rank units by remembered unscheduled outages a month.
  const units = slice.units.filter((u) => u.u.slice(holdFrom, holdTo + 1).filter((x) => x !== null).length >= 6);
  const memory = new UnitMemory();
  for (let t = 0; t < holdFrom; t++) memory.ingest(slice.units, t, WINDOW);
  const outagesHeld = (u: Unit) => mean(u.u.slice(holdFrom, holdTo + 1).filter((x): x is number => x !== null));
  const ranked = units.filter((u) => memory.read(u.code, holdFrom, "timeAware").some((f) => f.u !== null));
  const worstCount = Math.round(ranked.length / 10);
  const worst = new Set(ranked.slice().sort((a, b) => outagesHeld(b) - outagesHeld(a)).slice(0, worstCount).map((u) => u.code));
  const K = 50;
  const topBy = (arm: Arm) =>
    ranked
      .map((u) => ({ code: u.code, score: mean(memory.read(u.code, holdFrom, arm).flatMap((f) => (f.u === null ? [] : [f.u]))) }))
      .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
      .slice(0, K);
  const shuffled = ranked.map((u) => u.code).sort();
  const r = rng(SEED + 7);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const precision = (codes: string[]) => round(codes.filter((c) => worst.has(c)).length / K);

  // Where time-aware memory picked wrong, the biggest misses first, one per station.
  const wrong = decisions.filter((d) => !d.correct.timeAware);
  const examples = wrong
    .slice()
    .sort((a, b) => Math.abs(b.actual[0] - b.actual[1]) - Math.abs(a.actual[0] - a.actual[1]))
    .filter((d, i, all) => all.findIndex((x) => x.station === d.station) === i)
    .slice(0, 4)
    .map((d) => ({
      month: monthName(slice.first, d.t),
      station: d.station.replace(/ - Station$/, ""),
      type: d.type,
      units: d.units,
      remembered: d.remembered.timeAware,
      actual: d.actual.map((x) => round(x, 3)),
    }));

  return {
    question: "A step-free rider can use one of two elevators (or escalators) at the same station. Which one is more likely to be running this month?",
    method: [
      `Source: ${String(slice.source.name)} (${String(slice.source.publisher)}), retrieved ${String(slice.source.retrieved)}; ${slice.units.length} units, ${slice.months} months from ${monthName(slice.first, 0)}.`,
      `Replay in time order. Each month's records reach memory only at the start of the next month; every decision reads only records valid before it (a check that throws on any later record found none).`,
      `Decisions: every month from ${monthName(slice.first, holdFrom)} to ${monthName(slice.first, holdTo)}, every pair of units of one kind at one station complex whose availability that month differs by more than half a point. Right means memory picked the unit that ran more.`,
      "No memory: a seeded coin. Placebo: every record ever read, kept forever (no validity window, no SUPERSEDES). Time-aware (Detour): records valid for 12 months, and a unit back from two months mostly out of service supersedes its older records, the way a superseded Finding is closed.",
      `95% intervals: ${BOOT} seeded bootstrap resamples of whole station complexes.`,
    ],
    n: { decisions: decisions.length, stations: new Set(decisions.map(byStation)).size, months: holdTo - holdFrom + 1, units: slice.units.length },
    arms,
    differences: { timeAwareVsNone: diff("timeAware", "none"), timeAwareVsPlacebo: diff("timeAware", "placebo") },
    byType,
    sensitivity,
    failureProne: {
      question: `Which ${K} units will have the most unscheduled outages a month, ${monthName(slice.first, holdFrom)} to ${monthName(slice.first, holdTo)}?`,
      units: ranked.length,
      worst: worstCount,
      k: K,
      precision: { none: precision(shuffled.slice(0, K)), baseRate: round(worstCount / ranked.length), placebo: precision(topBy("placebo").map((x) => x.code)), timeAware: precision(topBy("timeAware").map((x) => x.code)) },
    },
    failures: {
      wrong: wrong.length,
      share: round(wrong.length / Math.max(1, decisions.length)),
      note: "Memory predicts from the past; a unit that breaks for the first time, or one just repaired, still fools it. These are its largest misses.",
      examples,
    },
    leaks: 0,
  };
}

/* Graph helpers */

const ctxFor = (visitorId: string, sandbox: string, agentId = "rider-desk"): ToolContext => ({ visitorId, sandbox, agentId, tracer: new Tracer() });

async function sandboxFor(label: string) {
  const visitor = `evalmem${label}${Date.now().toString(36)}`;
  const sandbox = await ensureSandbox(visitor);
  return { visitor, graph: sandbox.graph };
}

const uses = (answer: RouteAnswer | null, station: string, route: string) =>
  Boolean(answer?.legs.some((l) => l.kind === "RUNS" && l.route === route && (l.from === station || l.to === station)));

const signature = (answer: RouteAnswer | null) => (answer ? answer.legs.map((l) => `${l.route ?? l.kind}:${l.from}>${l.to}`).join(" ") : "no route");

/** Accessible platforms in a fixed order, each with an accessible station 3 to 8 stops down the line. */
function accessiblePlatforms(network: Network) {
  const ada = new Set(network.stations.filter((s) => s.ada === 1).map((s) => s.id));
  const found = new Map<string, { station: string; route: string; dest: string }>();
  for (const route of [...network.routes].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const pattern of route.patterns) {
      pattern.forEach((s, i) => {
        if (!ada.has(s) || found.has(`${s}:${route.id}`)) return;
        const dest = pattern.slice(i + 3, i + 9).find((x) => ada.has(x) && x !== s);
        if (dest) found.set(`${s}:${route.id}`, { station: s, route: route.id, dest });
      });
    }
  }
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p);
}

/* 2. Step-free routing with an elevator outage in memory */

async function stepFreeEval(network: Network) {
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  const all = accessiblePlatforms(network);
  const step = all.length / 40;
  const platforms = Array.from({ length: 40 }, (_, i) => all[Math.floor(i * step)]);
  const { visitor, graph } = await sandboxFor("sf");
  type Trip = { platform: string; from: string; to: string; offThrough: boolean; outcome: "rerouted" | "no step-free route" | "through the broken elevator" | "unaffected"; extraMinutes: number | null };
  const trips: Trip[] = [];
  const skipped: string[] = [];
  try {
    for (const p of platforms) {
      const ctx = ctxFor(visitor, graph);
      const wrote = await reportElevator(ctx, { station: p.station, stationName: names.get(p.station) ?? p.station, route: p.route, working: false, syncTicket: false });
      if (wrote.outcome !== "answered") {
        skipped.push(`${p.station}:${p.route}`);
        continue;
      }
      for (const [from, to] of [
        [p.station, p.dest],
        [p.dest, p.station],
      ]) {
        const off = await routeRider(ctxFor(visitor, graph), { from, to, stepFree: true, useMemory: false });
        const on = await routeRider(ctxFor(visitor, graph), { from, to, stepFree: true });
        const offThrough = uses(off.data.answer, p.station, p.route);
        const onThrough = uses(on.data.answer, p.station, p.route);
        trips.push({
          platform: `${names.get(p.station)} (${p.route})`,
          from,
          to,
          offThrough,
          outcome: !offThrough ? "unaffected" : !on.data.answer ? "no step-free route" : onThrough ? "through the broken elevator" : "rerouted",
          extraMinutes: offThrough && on.data.answer && off.data.answer ? round(on.data.answer.minutes - off.data.answer.minutes, 1) : null,
        });
      }
      await reportElevator(ctxFor(visitor, graph), { station: p.station, stationName: names.get(p.station) ?? p.station, route: p.route, working: true, syncTicket: false });
    }
  } finally {
    await dropSandbox(visitor).catch(() => undefined);
  }
  const affected = trips.filter((t) => t.offThrough);
  const share = (xs: Trip[], f: (t: Trip) => boolean) => round(xs.filter(f).length / Math.max(1, xs.length));
  const extra = affected.filter((t) => t.outcome === "rerouted" && t.extraMinutes !== null).map((t) => t.extraMinutes!).sort((a, b) => a - b);
  return {
    question: "A wheelchair user asks for a step-free route. An elevator on the way is out of service, and memory knows it.",
    method: [
      `${platforms.length} accessible station-and-line platforms, taken at even steps from the ${all.length} in the network (sorted by station and line); ${skipped.length} already had an outage in memory and were skipped.`,
      "For each: report_elevator writes the outage as a Finding, then two step-free trips to and from an accessible station 3 to 8 stops along the line are routed with route_rider, once with memory off (outages ignored) and once on. The outage is then closed by a report that the elevator works again.",
      "A trip counts when, with memory off, its route boards or leaves the train at the broken platform.",
    ],
    n: { platforms: platforms.length - skipped.length, trips: trips.length, affected: affected.length },
    through: { memoryOff: share(affected, (t) => t.offThrough), memoryOn: share(affected, (t) => t.outcome === "through the broken elevator") },
    outcomes: {
      rerouted: share(affected, (t) => t.outcome === "rerouted"),
      noStepFreeRoute: share(affected, (t) => t.outcome === "no step-free route"),
      throughBrokenElevator: share(affected, (t) => t.outcome === "through the broken elevator"),
    },
    allTrips: { memoryOff: share(trips, (t) => t.offThrough), memoryOn: share(trips, (t) => t.outcome === "through the broken elevator") },
    medianExtraMinutes: extra.length ? extra[Math.floor(extra.length / 2)] : null,
    examples: affected.slice(0, 4).map((t) => ({ platform: t.platform, trip: `${names.get(t.from)} → ${names.get(t.to)}`, outcome: t.outcome, extraMinutes: t.extraMinutes })),
  };
}

/* 3. Bus sizing from procedural memory, leave one out */

interface PastShuttle {
  id: string;
  routes: string[];
  openedMs: number;
  busesPerHour: number;
  planned: number;
  observed: number;
  synthetic: boolean;
}

const BUS_RIDERS = 70;

/** The scripted controller's rule: buses an hour divided by the remembered share of plan, capped at 60. */
const sized = (bph: number, share: number | null) => (share ? Math.min(60, Math.ceil(bph / share)) : bph);

async function busEval(network: Network) {
  const { visitor, graph } = await sandboxFor("bus");
  const r = rng(SEED + 3);
  const firstPattern = (route: string) => network.routes.find((x) => x.id === route)?.patterns[0] ?? [];
  // Corridors with a known share of plan their buses really carry; one runs at plan, where memory should change nothing.
  const corridors = [
    { routes: ["L"], from: "120", to: "101", ratio: 0.79 },
    { routes: ["A", "C"], from: "636", to: "628", ratio: 0.93 },
    { routes: ["G"], from: firstPattern("G")[1], to: firstPattern("G")[3], ratio: 0.72 },
    { routes: ["7"], from: firstPattern("7")[2], to: firstPattern("7")[4], ratio: 0.86 },
    { routes: ["J", "Z"], from: firstPattern("J")[1], to: firstPattern("J")[3], ratio: 1.0 },
  ];
  const synthetic: PastShuttle[] = [];
  corridors.forEach((c, ci) => {
    for (let j = 0; j < 6; j++) {
      const bph = 12 + Math.floor(r() * 25);
      const share = Math.min(1.04, c.ratio + (r() - 0.5) * 0.12);
      synthetic.push({
        id: `SYN-${c.routes.join("")}-${j + 1}`,
        routes: c.routes,
        openedMs: Date.parse("2025-01-10T08:00:00Z") + (j * corridors.length + ci) * 9 * 86_400_000,
        busesPerHour: bph,
        planned: bph * BUS_RIDERS,
        observed: Math.round(bph * BUS_RIDERS * share),
        synthetic: true,
      });
    }
  });
  type Row = PastShuttle & { withMemory: number | null; online: number | null };
  const rows: Row[] = [];
  try {
    for (const [i, s] of synthetic.entries()) {
      const c = corridors.find((x) => x.routes.join() === s.routes.join())!;
      await run(
        graph,
        `CREATE (i:Incident {id: $id, title: $title, report: $title, routes: $routes, stretch: [$from, $to], status: 'resolved',
           example: true, synthetic: true, openedMs: $openedMs})
         WITH i
         MATCH (a:Station {id: $from}), (b:Station {id: $to})
         CREATE (s:Shuttle {busesPerHour: $bph, planned: $planned, observed: $observed, synthetic: true})-[:FOR]->(i), (s)-[:FROM]->(a), (s)-[:TO]->(b)`,
        { id: s.id, title: `Synthetic ${s.routes.join("/")} bus bridge ${i + 1}`, routes: s.routes, from: c.from, to: c.to, openedMs: s.openedMs, bph: s.busesPerHour, planned: s.planned, observed: s.observed },
      );
    }
    const seeded = await run<{ id: string; routes: string[]; openedMs: number; bph: number; planned: number; observed: number }>(
      graph,
      `MATCH (s:Shuttle)-[:FOR]->(i:Incident) WHERE i.synthetic IS NULL
       RETURN i.id AS id, i.routes AS routes, i.openedMs AS openedMs, s.busesPerHour AS bph, s.planned AS planned, s.observed AS observed`,
      {},
      { readOnly: true },
    );
    const history: PastShuttle[] = [
      ...seeded.rows.map((x) => ({ id: x.id, routes: x.routes, openedMs: x.openedMs, busesPerHour: x.bph, planned: x.planned, observed: x.observed, synthetic: false })),
      ...synthetic,
    ];
    for (const h of history) {
      // Hide the held-out incident from recall (recall reads closed incidents only), ask, then put it back.
      const before = await run<{ status: string }>(graph, "MATCH (i:Incident {id: $id}) WITH i, i.status AS status SET i.status = 'open' RETURN status", { id: h.id });
      const memory = await recall(ctxFor(visitor, graph, "controller"), { routes: h.routes });
      await run(graph, "MATCH (i:Incident {id: $id}) SET i.status = $status", { id: h.id, status: before.rows[0]?.status ?? "closed" });
      const share = shuttleShare(memory.data.incidents);
      // Online: only incidents before this one, the same rule (5 most recent on these routes, as recall reads them).
      const earlier = history
        .filter((x) => x.openedMs < h.openedMs && x.routes.some((rt) => h.routes.includes(rt)))
        .sort((a, b) => b.openedMs - a.openedMs)
        .slice(0, 5)
        .map((x): RememberedIncident => ({ id: x.id, title: x.id, openedMs: x.openedMs, example: true, shuttles: [{ from: "", to: "", bph: x.busesPerHour, planned: x.planned, observed: x.observed }] }));
      rows.push({ ...h, withMemory: share?.ratio ?? null, online: shuttleShare(earlier)?.ratio ?? null });
    }
  } finally {
    await dropSandbox(visitor).catch(() => undefined);
  }
  // Error: riders the bridge carries (buses × 70 × the share it really achieves) against the riders it was sized for.
  const error = (x: Row, share: number | null) => Math.abs(sized(x.busesPerHour, share) * BUS_RIDERS * (x.observed / x.planned) - x.planned);
  const mae = (xs: Row[], pick: (x: Row) => number | null) => round(mean(xs.map((x) => error(x, pick(x)))), 0);
  const gain = (pick: (x: Row) => number | null) => (xs: Row[]) => mean(xs.map((x) => error(x, null) - error(x, pick(x))));
  const within = (xs: Row[], pick: (x: Row) => number | null) => round(xs.filter((x) => error(x, pick(x)) <= 0.05 * x.planned).length / Math.max(1, xs.length));
  return {
    question: "A bus bridge is planned for so many riders an hour. How close does what it carries come to that?",
    method: [
      `${rows.length} past shuttle incidents: ${rows.filter((x) => !x.synthetic).length} seeded (the L and A/C bridges) and ${rows.filter((x) => x.synthetic).length} synthetic, six on each of ${corridors.length} corridors whose buses carry a known share of plan (${corridors.map((c) => `${c.routes.join("/")} ${Math.round(c.ratio * 100)}%`).join(", ")}) give or take 6 points, from a seeded generator.`,
      "Leave one out: each incident is hidden, recall reads the rest from FalkorDB, and the bridge is sized the way the scripted controller sizes it: buses an hour divided by the lowest share of plan a recalled shuttle carried, when under 97%.",
      `Without memory the buses run at the raw estimate. Carried = buses × ${BUS_RIDERS} riders × the share that incident's buses really achieved; the error is its distance from the riders planned.`,
      "Online: the same rule fed only incidents that came earlier. 95% interval: seeded bootstrap over incidents.",
    ],
    n: rows.length,
    mae: {
      withoutMemory: mae(rows, () => null),
      withMemory: mae(rows, (x) => x.withMemory),
      online: mae(rows, (x) => x.online),
    },
    improvement: { value: round(gain((x) => x.withMemory)(rows), 0), ci: clusterBootstrap(rows, (x) => x.id, gain((x) => x.withMemory), SEED + 4).map((v) => Math.round(v)) },
    withinFivePercent: { withoutMemory: within(rows, () => null), withMemory: within(rows, (x) => x.withMemory), online: within(rows, (x) => x.online) },
    byCorridor: corridors.map((c) => {
      const xs = rows.filter((x) => x.routes.join() === c.routes.join());
      return { routes: c.routes.join("/"), n: xs.length, withoutMemory: mae(xs, () => null), withMemory: mae(xs, (x) => x.withMemory) };
    }),
  };
}

/* 4. Across sessions */

async function sessionEval(network: Network) {
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  const { visitor, graph } = await sandboxFor("ses");
  const ada = network.stations.filter((s) => s.ada === 1).map((s) => s.id).sort();
  const r = rng(SEED + 5);
  const pairs: [string, string][] = [];
  while (pairs.length < 30) {
    const a = ada[Math.floor(r() * ada.length)];
    const b = ada[Math.floor(r() * ada.length)];
    if (a !== b && !pairs.some(([x, y]) => x === a && y === b)) pairs.push([a, b]);
  }
  // The busiest accessible stations' first platforms get an outage in session A.
  const busiest = network.stations
    .filter((s) => s.ada === 1 && s.routes.length)
    .sort((a, b) => b.entries + b.exits - (a.entries + a.exits))
    .slice(0, 5)
    .map((s) => ({ station: s.id, route: [...s.routes].sort()[0] }));
  try {
    const riders = await listRiders(ctxFor(visitor, graph));
    type Q = { label: string; ask: (ctx: ToolContext, useMemory: boolean) => Promise<RouteAnswer | null> };
    const questions: Q[] = [
      ...riders.map((rider) => ({ label: `${rider.name}'s commute${rider.stepFree ? " (step-free)" : ""}`, ask: async (ctx: ToolContext, useMemory: boolean) => (await routeRider(ctx, { riderId: rider.id, useMemory })).data.answer })),
      ...pairs.map(([a, b]) => ({ label: `${names.get(a)} → ${names.get(b)} (step-free)`, ask: async (ctx: ToolContext, useMemory: boolean) => (await routeRider(ctx, { from: a, to: b, stepFree: true, useMemory })).data.answer })),
    ];
    const answerAll = async (agent: string, useMemory: boolean) => {
      const out: string[] = [];
      for (const q of questions) out.push(signature(await q.ask(ctxFor(visitor, graph, agent), useMemory)));
      return out;
    };
    const describe = async (agent: string) => (await routeRider(ctxFor(visitor, graph, agent), { riderId: "aisha" })).summary;

    const before = await answerAll("rider-desk", true);
    const beforeOff = await answerAll("rider-desk", false);
    const aishaBefore = await describe("rider-desk");

    // Session A: the rider desk learns that Aisha's elevator works again, and of outages at five busy stations.
    const session = ctxFor(visitor, graph, "rider-desk");
    const facts = [await reportElevator(session, { station: "630", stationName: names.get("630") ?? "630", route: "L", working: true, syncTicket: false })];
    for (const b of busiest) facts.push(await reportElevator(ctxFor(visitor, graph, "rider-desk"), { station: b.station, stationName: names.get(b.station) ?? b.station, route: b.route, working: false, syncTicket: false }));

    // Session B: a later visit, a different agent, nothing carried over in process memory.
    const after = await answerAll("controller", true);
    const afterOff = await answerAll("controller", false);
    const aishaAfter = await describe("controller");
    const changed = questions.map((q, i) => ({ label: q.label, before: before[i], after: after[i] })).filter((x) => x.before !== x.after);
    return {
      question: "Does a fact written in one session change what a later session answers?",
      method: [
        `Session A writes ${facts.filter((f) => f.outcome === "answered").length} facts through report_elevator: the L platform elevator at Myrtle-Wyckoff Avs works again (Aisha's), and outages at the busiest accessible stations (${busiest.map((b) => `${names.get(b.station)} ${b.route}`).join(", ")}).`,
        `Session B, a later request with a fresh context and another agent, asks ${questions.length} questions: every remembered rider's commute and 30 seeded step-free trips between accessible stations. Each answer is compared with the same question asked before session A.`,
        "Control: the same questions with memory off change nothing.",
      ],
      n: questions.length,
      changed: changed.length,
      changedWithMemoryOff: questions.filter((_, i) => beforeOff[i] !== afterOff[i]).length,
      aisha: { before: aishaBefore, after: aishaAfter },
      examples: changed.slice(0, 5).map((c) => c.label),
    };
  } finally {
    await dropSandbox(visitor).catch(() => undefined);
  }
}

/* 5. Simultaneous reports */

async function raceEval(network: Network) {
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  const { visitor, graph } = await sandboxFor("race");
  const platforms = accessiblePlatforms(network).filter((p) => p.station !== "630");
  const open = async (p: { station: string; route: string }) =>
    (
      await run<{ n: number }>(
        graph,
        `MATCH (f:Finding)-[:ABOUT]->(:Station {id: $station}), (f)-[:ABOUT]->(:Route {id: $route})
         WHERE f.validToMs IS NULL AND f.text STARTS WITH 'Elevator'
         RETURN count(DISTINCT f) AS n`,
        { station: p.station, route: p.route },
        { readOnly: true },
      )
    ).rows[0]?.n ?? 0;
  const runs: { writers: number; sameReport: number; mixedReports: number; written: number }[] = [];
  try {
    for (const [i, writers] of [10, 50, 100].entries()) {
      const p = platforms[i * 7];
      const report = (working: boolean) => reportElevator(ctxFor(visitor, graph), { station: p.station, stationName: names.get(p.station) ?? p.station, route: p.route, working, syncTicket: false });
      const same = await Promise.all(Array.from({ length: writers }, () => report(false)));
      const sameOpen = await open(p);
      await Promise.all(Array.from({ length: writers }, (_, j) => report(j % 2 === 0)));
      const mixedOpen = await open(p);
      runs.push({ writers, sameReport: sameOpen, mixedReports: mixedOpen, written: same.filter((x) => x.outcome === "answered").length });
    }
  } finally {
    await dropSandbox(visitor).catch(() => undefined);
  }
  return {
    question: "Many reports about one elevator arrive at once. Does memory end with exactly one current fact?",
    method: [
      "For 10, 50 and 100 writers: all report the same outage at once, then half report it fixed and half report it broken, all at once. Each writer is its own context; the open elevator facts for the platform are counted after each burst.",
      "remember() writes the new finding and closes the one it supersedes in one query, and FalkorDB runs one write at a time per graph.",
    ],
    runs,
    ok: runs.every((x) => x.sameReport === 1 && x.mixedReports === 1),
  };
}

/* Main */

async function main() {
  if (!process.env.FALKORDB_URL && existsSync(".env.local")) process.loadEnvFile(".env.local");
  const only = (() => {
    const i = process.argv.indexOf("--only");
    return i >= 0 ? process.argv[i + 1].split(",") : null;
  })();
  const want = (part: string) => !only || only.includes(part);
  const previous = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...previous, runAt: new Date().toISOString(), seed: SEED };

  if (want("elevators")) {
    const started = performance.now();
    out.elevators = elevatorEval();
    const e = out.elevators as ReturnType<typeof elevatorEval>;
    console.log(
      `elevators  ${e.n.decisions} decisions · none ${e.arms.none.accuracy} · placebo ${e.arms.placebo.accuracy} · time-aware ${e.arms.timeAware.accuracy} ${JSON.stringify(e.arms.timeAware.ci)} · P@50 ${JSON.stringify(e.failureProne.precision)} (${Math.round(performance.now() - started)} ms)`,
    );
  }
  const graphParts = ["stepfree", "buses", "sessions", "race"].filter(want);
  if (graphParts.length) {
    await ensureBaseGraphs((m) => console.log(`seed: ${m}`), process.argv.includes("--reseed"));
    const network = await loadNetwork();
    if (want("stepfree")) {
      out.stepFree = await stepFreeEval(network);
      const s = out.stepFree as Awaited<ReturnType<typeof stepFreeEval>>;
      console.log(`step-free  ${s.n.affected} affected trips · through a broken elevator: memory off ${s.through.memoryOff}, on ${s.through.memoryOn} · ${JSON.stringify(s.outcomes)}`);
    }
    if (want("buses")) {
      out.buses = await busEval(network);
      const b = out.buses as Awaited<ReturnType<typeof busEval>>;
      console.log(`buses      ${b.n} incidents · MAE without ${b.mae.withoutMemory}, with ${b.mae.withMemory}, online ${b.mae.online} riders an hour`);
    }
    if (want("sessions")) {
      out.sessions = await sessionEval(network);
      const s = out.sessions as Awaited<ReturnType<typeof sessionEval>>;
      console.log(`sessions   ${s.changed} of ${s.n} answers changed (memory off: ${s.changedWithMemoryOff})`);
    }
    if (want("race")) {
      out.race = await raceEval(network);
      const r = out.race as Awaited<ReturnType<typeof raceEval>>;
      console.log(`race       ${JSON.stringify(r.runs)} ok=${r.ok}`);
    }
    await (await connect()).close();
  }
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(`wrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
