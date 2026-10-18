import { normalizePlace } from "../graph/tools/places";
import { SEED_FINDINGS, SEED_INCIDENTS, SEED_PLAYBOOKS } from "../graph/seed-memory";
import type { Demand, Network, Station } from "../network/types";
import type { Expect } from "./grade";
import { closeLine, fastestTrip, impact, platformGraph, reachable, stepFreeRule, transfersOf, type Closure } from "./gold";

/**
 * The eval set, generated with a fixed seed and split into dev and held-out before any run. Every expected answer
 * comes from gold.ts (plain code over data/nyc), the NetworkX verifier's committed output or the seeded memory;
 * none comes from FalkorDB.
 */
export type Category =
  | "impact"
  | "capacity"
  | "bottleneck"
  | "route"
  | "step_free"
  | "lines"
  | "cut_off"
  | "memory"
  | "not_in_graph"
  | "unknown_entity";

/** Questions the agent should decline or answer with "not connected": the abstention set. */
export const ABSTAIN: Category[] = ["not_in_graph", "unknown_entity"];

export type Split = "dev" | "heldout";

export interface EvalQuestion {
  id: string;
  split: Split;
  category: Category;
  /** Questions about the same closure, trip or fact share a group and always land in the same split. */
  group: string;
  question: string;
  expect: Expect;
  source: string;
  /** The tools a graph answer needs (tool-choice accuracy). */
  needs: string[];
  /** For the depth pairs: stops from the closure. */
  depth?: number;
}

export interface VerifyFlow {
  required: number;
  absorbed: number;
  unmet: number;
  cut: { bottlenecks: { runs: { from: string }[] } };
}

export interface VerifyOutput {
  displaced: Record<string, { riders: number }>;
  depthCounts: { k: number; riders: number }[];
  flow: Record<string, VerifyFlow>;
  peakDirection: string;
}

export interface Scenario {
  id: string;
  routes: string[];
  stations: string[];
}

export interface Inputs {
  network: Network;
  demand: Demand;
  scenarios: Scenario[];
  verify: Record<string, VerifyOutput>;
}

export const SEED = 20261018;
export const DEV_SHARE = 0.3;

/** mulberry32: a small seeded generator, so the same seed always gives the same questions and split. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const NX = "NetworkX verifier, data/nyc/verify";
const GOLD = "src/lib/eval/gold.ts over data/nyc";
const SHUTTLES = new Set(["GS", "FS", "H", "SI"]);
const NEEDS = {
  impact: ["resolve_places", "close_line", "affected_riders"],
  capacity: ["resolve_places", "close_line", "measure_capacity"],
  route: ["resolve_places", "route_rider"],
  cutOff: ["resolve_places", "close_line", "route_rider"],
  lines: ["resolve_places"],
};

/** Places that are not in the subway: checked below against every word of every station name. */
const FICTIONAL = [
  "Hogsmeade",
  "Diagon Alley",
  "Gotham Central",
  "Penny Lane",
  "Kings Landing",
  "Emerald City",
  "Bikini Bottom",
  "Narnia Av",
  "Atlantis Plaza",
  "Mordor St",
  "Wakanda Blvd",
  "Rivendell",
  "Duckburg",
  "Bedrock Sq",
  "Hill Valley",
  "Sunnydale",
];
/** Line letters and numbers the network does not have (the T is planned, the K, V and 9 are retired). */
const FICTIONAL_ROUTES = ["T", "K", "V", "9"];

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Whether resolve_places could match the name: its full-text query needs every term, exact for short terms and
 * within one edit (its fuzzy pass) for longer ones. A name with one unmatched term resolves to nothing.
 */
export function couldResolve(name: string, network: Network): boolean {
  const words = new Set(network.stations.flatMap((s) => normalizePlace(`${s.name} ${s.label}`).split(" ")));
  return normalizePlace(name)
    .split(" ")
    .every((t) => (t.length < 4 ? words.has(t) : [...words].some((w) => editDistanceAtMostOne(t, w))));
}

const linesText = (routes: string[]) =>
  routes.length === 1 ? `the ${routes[0]} train is` : `the ${routes.slice(0, -1).join(", ")} and ${routes[routes.length - 1]} trains are`;

export function closurePhrase(routes: string[], a: string, b: string): string {
  return `At 8 a.m. on a weekday, ${linesText(routes)} suspended in both directions between ${a} and ${b}.`;
}

export const ASK = {
  total: "How many riders an hour have trips that cross the closed stretch?",
  depth: (k: number) =>
    `Of the riders whose trips cross it, how many an hour start their trip within ${k} stop${k === 1 ? "" : "s"} of the closed stretch (stations in the stretch count as zero stops)?`,
  fits: "If the displaced riders were spread perfectly over the spare capacity of the open lines and walking links (max flow), could the network carry all of them in both directions? Answer yes or no.",
  absorbed: "Spreading displaced riders perfectly over spare capacity (max flow), how many riders an hour in the peak direction could the open network carry?",
  unmet: "Spreading displaced riders perfectly over spare capacity (max flow), how many riders an hour in the peak direction still could not move?",
  cut: "Which station's riders have no open alternative at all, so that no spare capacity elsewhere can move them (the min cut of the max flow)?",
  cutOff: (a: string, b: string) => `While it is closed, can a rider get from ${a} to ${b} by subway and the walking transfers between stations? Answer yes or no.`,
  minutes: (a: string, b: string) =>
    `At 8 a.m. on a weekday, how many minutes does the fastest subway trip from ${a} to ${b} take, counting riding, walking transfers and, at each boarding, a 3-minute penalty plus half the scheduled headway?`,
  transfers: (a: string, b: string) =>
    `At 8 a.m. on a weekday, how many times does a rider change trains on the fastest subway trip from ${a} to ${b} (counting riding, walking transfers and, at each boarding, a 3-minute penalty plus half the headway)?`,
  stepFree: (a: string, b: string) =>
    `Is there a step-free subway route from ${a} to ${b} at 8 a.m. on a weekday, with an accessible station at every boarding, transfer and exit and no platform whose elevator is out of service? Answer yes or no.`,
  stepFreeMinutes: (a: string, b: string) =>
    `At 8 a.m. on a weekday, how many minutes does the fastest step-free subway trip from ${a} to ${b} take (accessible stations at every boarding, transfer and exit, no platform whose elevator is out of service, same cost of riding, walking and boarding)?`,
  lines: (a: string) => `Which subway lines stop at ${a} in the weekday 8 a.m. hour? List the line letters or numbers.`,
  reach: (a: string, b: string) => `Can a rider get from ${a} to ${b} using only subway trains and the walking transfers in the subway network? Answer yes or no.`,
  elevatorSince: (route: string, a: string) => `Since what date has the elevator to the ${route} platform at ${a} been out of service?`,
};

export function buildQuestions(inputs: Inputs, seed = SEED): EvalQuestion[] {
  const { network, demand, scenarios, verify } = inputs;
  const random = rng(seed);
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  const byId = new Map(network.stations.map((s) => [s.id, s]));
  const name = (id: string) => byId.get(id)!.name;
  const nameCount = new Map<string, number>();
  for (const s of network.stations) nameCount.set(normalizePlace(s.name), (nameCount.get(normalizePlace(s.name)) ?? 0) + 1);
  /** A station whose name no other station shares, outside Staten Island, served by a train line. */
  const plain = (s: Station) => nameCount.get(normalizePlace(s.name)) === 1 && s.borough !== "SI" && s.routes.some((r) => !SHUTTLES.has(r));
  const plainStations = network.stations.filter(plain).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const routeIds = network.routes.map((r) => r.id);
  const trainRoutes = network.routes.filter((r) => !SHUTTLES.has(r.id));
  const graph = platformGraph(network);
  const outages = SEED_FINDINGS.filter((f) => f.kind === "accessibility" && !f.validTo).flatMap((f) =>
    (f.about.stations ?? []).map((station) => ({ station, routes: f.about.routes ?? [] })),
  );
  const stepOk = stepFreeRule(network, outages);

  const out: Omit<EvalQuestion, "split">[] = [];
  const add = (q: Omit<EvalQuestion, "split">) => out.push(q);

  // ---- closures: the three presets (with the verifier's max flow) and random stretches on many lines
  type Named = Closure & { key: string; a: string; b: string; preset?: string };
  const closures: Named[] = [];
  for (const sc of scenarios) {
    const c = closeLine(network, sc.routes, sc.stations[0], sc.stations[sc.stations.length - 1])!;
    closures.push({ ...c, key: sc.id, a: sc.stations[0], b: sc.stations[sc.stations.length - 1], preset: sc.id });
  }
  const used = new Map<string, number>();
  for (let attempt = 0; closures.length < scenarios.length + 12 && attempt < 5000; attempt++) {
    const route = pick(trainRoutes);
    if ((used.get(route.id) ?? 0) >= 1) continue;
    const pattern = pick(route.patterns);
    const len = 2 + Math.floor(random() * 4);
    if (pattern.length < len + 2) continue;
    const start = 1 + Math.floor(random() * (pattern.length - len - 1));
    const a = pattern[start];
    const b = pattern[start + len - 1];
    if (!plain(byId.get(a)!) || !plain(byId.get(b)!)) continue;
    // Now and then a second line that shares the stretch, like the 4 and 5.
    const partner = trainRoutes.find((r) => r.id !== route.id && r.patterns.some((p) => p.includes(a) && p.includes(b)));
    const routes = partner && random() < 0.35 ? [route.id, partner.id].sort() : [route.id];
    const c = closeLine(network, routes, a, b);
    if (!c || !c.closedEids.length) continue;
    const key = `${routes.join("")}-${a}-${b}`;
    if (closures.some((x) => x.key === key || x.closedEids.join() === c.closedEids.join())) continue;
    const imp = impact(network, demand.pairs, c);
    if (imp.total < 1000 || imp.byDepth[4] < imp.byDepth[1] + 200) continue;
    used.set(route.id, (used.get(route.id) ?? 0) + 1);
    closures.push({ ...c, key, a, b });
  }

  for (const c of closures) {
    const imp = impact(network, demand.pairs, c);
    const phrase = closurePhrase(c.routes, name(c.a), name(c.b));
    const group = `closure-${c.key}`;
    const v = c.preset ? verify[c.preset] : undefined;
    const source = c.preset ? `${GOLD}; equals the ${NX}` : GOLD;
    const total = v ? Math.round(Object.values(v.displaced).reduce((s, d) => s + d.riders, 0)) : imp.total;
    add({ id: `impact-${c.key}-total`, category: "impact", group, question: `${phrase} ${ASK.total}`, expect: { kind: "number", value: total, tolerance: 0.03 }, source, needs: NEEDS.impact });
    for (const k of [1, 4]) {
      add({
        id: `impact-${c.key}-depth${k}`,
        category: "impact",
        group,
        question: `${phrase} ${ASK.depth(k)}`,
        expect: { kind: "number", value: imp.byDepth[k], tolerance: 0.03 },
        source,
        needs: NEEDS.impact,
        depth: k,
      });
    }
    if (v) {
      const peak = v.flow[v.peakDirection];
      const fits = Object.values(v.flow).every((f) => f.unmet < 1);
      add({ id: `capacity-${c.key}-fits`, category: "capacity", group, question: `${phrase} ${ASK.fits}`, expect: { kind: "yesno", value: fits ? "yes" : "no" }, source: NX, needs: NEEDS.capacity });
      add({ id: `capacity-${c.key}-absorbed`, category: "capacity", group, question: `${phrase} ${ASK.absorbed}`, expect: { kind: "number", value: Math.round(peak.absorbed), tolerance: 0.03 }, source: NX, needs: NEEDS.capacity });
      add({ id: `capacity-${c.key}-unmet`, category: "capacity", group, question: `${phrase} ${ASK.unmet}`, expect: { kind: "number", value: Math.round(peak.unmet), tolerance: 0.05 }, source: NX, needs: NEEDS.capacity });
      if (!fits) {
        const cut = [...new Set(peak.cut.bottlenecks.runs.map((r) => name(r.from)))];
        add({ id: `bottleneck-${c.key}-cut`, category: "bottleneck", group, question: `${phrase} ${ASK.cut}`, expect: { kind: "contains", any: cut }, source: NX, needs: NEEDS.capacity });
      }
    }
  }

  // ---- cut off by a closure: can a rider in the stretch still get out?
  const cutYes: Omit<EvalQuestion, "split">[] = [];
  const cutNo: Omit<EvalQuestion, "split">[] = [];
  for (const c of closures) {
    for (const id of c.stretch.slice(1, -1)) {
      const s = byId.get(id)!;
      if (!plain(s)) continue;
      const reach = reachable(network, id, c.closedEids);
      const cutOff = reach.size < 5;
      const targets = plainStations.filter((t) => t.id !== id && !c.stretch.includes(t.id) && (cutOff ? !reach.has(t.id) : reach.has(t.id)));
      if (!targets.length) continue;
      const t = pick(targets);
      const q = {
        id: `cutoff-${c.key}-${id}`,
        category: "cut_off" as const,
        group: `closure-${c.key}`,
        question: `${closurePhrase(c.routes, name(c.a), name(c.b))} ${ASK.cutOff(s.name, t.name)}`,
        expect: { kind: "yesno" as const, value: cutOff ? ("no" as const) : ("yes" as const) },
        source: `breadth-first search over open segments and walks, ${GOLD}`,
        needs: NEEDS.cutOff,
      };
      (cutOff ? cutNo : cutYes).push(q);
    }
  }
  for (const q of [...shuffle(cutNo, random).slice(0, 4), ...shuffle(cutYes, random).slice(0, 4)]) add(q);

  // ---- fastest trips: minutes, and transfers where every fastest path agrees on them
  let trips = 0;
  let transferQs = 0;
  for (let attempt = 0; trips < 12 && attempt < 4000; attempt++) {
    const a = pick(plainStations);
    const b = pick(plainStations);
    if (a.id === b.id || (a.borough === b.borough && random() < 0.5)) continue;
    const trip = fastestTrip(graph, a.id, b.id);
    if (!trip || trip.minutes < 15 || trip.minutes > 80) continue;
    const group = `trip-${a.id}-${b.id}`;
    if (out.some((q) => q.group === group)) continue;
    trips++;
    add({ id: `route-${a.id}-${b.id}-minutes`, category: "route", group, question: ASK.minutes(a.name, b.name), expect: { kind: "number", value: trip.minutes, tolerance: 0.05 }, source: `Dijkstra on the platform layer, ${GOLD}`, needs: NEEDS.route });
    if (trip.minBoardings === trip.maxBoardings && transferQs < 8) {
      transferQs++;
      add({ id: `route-${a.id}-${b.id}-transfers`, category: "route", group, question: ASK.transfers(a.name, b.name), expect: { kind: "number", value: transfersOf(trip.minBoardings), tolerance: 0, abs: 0 }, source: `Dijkstra on the platform layer, ${GOLD}`, needs: NEEDS.route });
    }
  }

  // ---- step-free: yes when a fastest path is already step-free, no when no step-free path exists at all
  const sfYes: Omit<EvalQuestion, "split">[] = [];
  const sfNo: Omit<EvalQuestion, "split">[] = [];
  for (let attempt = 0; (sfYes.length < 3 || sfNo.length < 4) && attempt < 4000; attempt++) {
    const a = pick(plainStations);
    const b = pick(plainStations);
    if (a.id === b.id) continue;
    const any = fastestTrip(graph, a.id, b.id);
    if (!any || any.minutes > 80) continue;
    const sf = fastestTrip(graph, a.id, b.id, { stepOk });
    const q = (value: "yes" | "no") => ({
      id: `stepfree-${a.id}-${b.id}`,
      category: "step_free" as const,
      group: `stepfree-${a.id}-${b.id}`,
      question: ASK.stepFree(a.name, b.name),
      expect: { kind: "yesno" as const, value },
      source: `Dijkstra with boarding and exits only at ADA stations without a current outage in memory, ${GOLD}`,
      needs: NEEDS.route,
    });
    if (sf && Math.abs(sf.minutes - any.minutes) <= 0.05 && sfYes.length < 3) sfYes.push(q("yes"));
    else if (!sf && sfNo.length < 4) sfNo.push(q("no"));
  }
  for (const q of [...sfYes, ...sfNo]) add(q);
  // Aisha's trip: the L platform elevator at Myrtle-Wyckoff Avs is out (memory), so the step-free route takes the M.
  const aisha = fastestTrip(graph, "630", "601", { stepOk })!;
  add({ id: "stepfree-630-601", category: "step_free", group: "stepfree-630-601", question: ASK.stepFree(name("630"), name("601")), expect: { kind: "yesno", value: "yes" }, source: `${GOLD} with the F-ELEV-2 outage from seeded memory`, needs: NEEDS.route });
  add({ id: "stepfree-630-601-minutes", category: "step_free", group: "stepfree-630-601", question: ASK.stepFreeMinutes(name("630"), name("601")), expect: { kind: "number", value: aisha.minutes, tolerance: 0.05 }, source: `${GOLD} with the F-ELEV-2 outage from seeded memory`, needs: NEEDS.route });

  // ---- which lines stop at a station
  for (const s of shuffle(plainStations.filter((s) => s.routes.length >= 2 && s.routes.every((r) => !SHUTTLES.has(r))), random).slice(0, 10)) {
    add({ id: `lines-${s.id}`, category: "lines", group: `lines-${s.id}`, question: ASK.lines(s.name), expect: { kind: "set", items: [...s.routes].sort(), universe: routeIds }, source: "station routes in data/nyc/network.json", needs: NEEDS.lines });
  }

  // ---- memory: facts with their dates, from the seeded memory
  const finding = (id: string) => SEED_FINDINGS.find((f) => f.id === id)!;
  const day = (iso: string) => iso.slice(0, 10);
  const june = SEED_INCIDENTS.find((i) => i.id === "INC-0612")!;
  const sept = SEED_INCIDENTS.find((i) => i.id === "INC-0903")!;
  const playbook = SEED_PLAYBOOKS.find((p) => p.id === "PB-L-TUBE")!;
  const share = (s: { planned: number; observed: number }) => Math.round((s.observed / s.planned) * 100);
  const mem = (id: string, group: string, question: string, expect: Expect, source: string, needs = ["recall_memory"]) =>
    add({ id: `memory-${id}`, category: "memory", group: `memory-${group}`, question, expect, source: `seeded memory, ${source}`, needs });
  const stationMemory = ["resolve_places", "recall_memory"];
  mem("myrtle-elevator-since", "elev2", ASK.elevatorSince("L", name("630")), { kind: "date", iso: day(finding("F-ELEV-2").validFrom) }, "F-ELEV-2", stationMemory);
  mem("union-sq-elevator-now", "elev1", `Is the elevator to the L platform at ${name("602")} out of service right now? Answer yes or no.`, { kind: "yesno", value: "no" }, "F-ELEV-1 (closed)", stationMemory);
  mem("union-sq-elevator-back", "elev1", `On what date was the elevator to the L platform at ${name("602")} reported back in service?`, { kind: "date", iso: day(finding("F-ELEV-1").validTo!) }, "F-ELEV-1", stationMemory);
  mem("union-sq-elevator-out", "elev1", `On what date was the elevator to the L platform at ${name("602")} first reported out of service?`, { kind: "date", iso: day(finding("F-ELEV-1").validFrom) }, "F-ELEV-1", stationMemory);
  mem("june-share", "inc0612", "What share of its planned riders did the shuttle bus carry during the remembered Canarsie Tube incident on the L? Give a percentage.", { kind: "number", value: share(june.shuttles[0]), tolerance: 0.02 }, "INC-0612");
  mem("june-planned", "inc0612", "How many riders an hour was the shuttle bus planned to carry during the remembered Canarsie Tube incident on the L?", { kind: "number", value: june.shuttles[0].planned, tolerance: 0.01 }, "INC-0612");
  mem("june-buses", "inc0612", "How many buses an hour ran on the shuttle during the remembered Canarsie Tube incident on the L?", { kind: "number", value: june.shuttles[0].busesPerHour, tolerance: 0, abs: 0 }, "INC-0612");
  mem("june-date", "inc0612", "On what date did the remembered smoke condition in the Canarsie Tube (L train) happen?", { kind: "date", iso: day(june.openedAt) }, "INC-0612");
  mem("sept-share", "inc0903", "What share of its planned riders did the shuttle bus carry during the remembered Cranberry Street Tunnel incident on the A and C? Give a percentage.", { kind: "number", value: share(sept.shuttles[0]), tolerance: 0.02 }, "INC-0903");
  mem("sept-observed", "inc0903", "How many riders an hour did the shuttle bus actually carry during the remembered Cranberry Street Tunnel incident on the A and C?", { kind: "number", value: sept.shuttles[0].observed, tolerance: 0.01 }, "INC-0903");
  mem("sept-date", "inc0903", "On what date did the remembered water condition in the Cranberry Street Tunnel (A and C trains) happen?", { kind: "date", iso: day(sept.openedAt) }, "INC-0903");
  const crowding = Number(/(\d+) minutes in/.exec(finding("F-0612-2").text)![1]);
  mem("g-crowding", "f06122", "During the remembered L closure, how many minutes in did crowding on the G platform at Metropolitan Av/Lorimer St hit the safety limit?", { kind: "number", value: crowding, tolerance: 0, abs: 0 }, "F-0612-2");
  const busShare = Number(/carried (\d+)% of plan/.exec(playbook.steps.join(" "))![1]);
  mem("playbook-bus-share", "pbltube", "According to the remembered playbook for a Canarsie Tube closure on the L, what share of its plan did the June 12 bus bridge carry? Give a percentage.", { kind: "number", value: busShare, tolerance: 0, abs: 0 }, "PB-L-TUBE");

  // ---- not in the graph: real names, relations that do not exist
  const remembered = new Set(SEED_FINDINGS.flatMap((f) => f.about.stations ?? []));
  const rememberedRoutes = new Set(SEED_FINDINGS.flatMap((f) => f.about.routes ?? []));
  let unserved = 0;
  for (let attempt = 0; unserved < 4 && attempt < 2000; attempt++) {
    const route = pick(trainRoutes);
    const on = plainStations.filter((s) => route.patterns.some((p) => p.includes(s.id)));
    const off = plainStations.filter((s) => !s.routes.includes(route.id) && !route.patterns.some((p) => p.includes(s.id)));
    if (!on.length || !off.length) continue;
    const a = pick(on);
    const b = pick(off);
    if (closeLine(network, [route.id], a.id, b.id)) continue;
    const id = `nig-unserved-${route.id}-${a.id}-${b.id}`;
    if (out.some((q) => q.id === id)) continue;
    unserved++;
    add({ id, category: "not_in_graph", group: id, question: `${closurePhrase([route.id], a.name, b.name)} ${ASK.total}`, expect: { kind: "decline" }, source: `no ${route.id} stop pattern serves both stations (network.json)`, needs: ["resolve_places"] });
  }
  const siStations = shuffle(network.stations.filter((s) => s.borough === "SI" && nameCount.get(normalizePlace(s.name)) === 1), random);
  const mainland = shuffle(plainStations.filter((s) => s.borough === "M"), random);
  for (let i = 0; i < 3; i++) {
    const a = siStations[i];
    const b = mainland[i];
    const reach = reachable(network, a.id).has(b.id);
    add({ id: `nig-reach-${a.id}-${b.id}`, category: "not_in_graph", group: `nig-si-${a.id}`, question: ASK.reach(a.name, b.name), expect: { kind: "yesno", value: reach ? "yes" : "no" }, source: "breadth-first search over data/nyc/network.json", needs: NEEDS.route });
    const c = siStations[i + 3];
    const d = mainland[i + 3];
    add({ id: `nig-route-${c.id}-${d.id}`, category: "not_in_graph", group: `nig-si-${c.id}`, question: ASK.minutes(c.name, d.name), expect: fastestTrip(graph, c.id, d.id) ? { kind: "number", value: fastestTrip(graph, c.id, d.id)!.minutes, tolerance: 0.05 } : { kind: "decline" }, source: `no path in the platform layer, ${GOLD}`, needs: NEEDS.route });
  }
  for (const s of shuffle(plainStations.filter((s) => !remembered.has(s.id) && !s.routes.some((r) => rememberedRoutes.has(r) || SHUTTLES.has(r))), random).slice(0, 2)) {
    add({ id: `nig-elevator-${s.id}`, category: "not_in_graph", group: `nig-elevator-${s.id}`, question: ASK.elevatorSince(s.routes[0], s.name), expect: { kind: "decline" }, source: "no elevator finding about this station in seeded memory", needs: ["resolve_places", "recall_memory"] });
  }

  // ---- unknown names: places and lines that are not in the subway at all
  const fake = shuffle(FICTIONAL.filter((n) => !couldResolve(n, network)), random);
  let f = 0;
  const nextFake = () => fake[f++ % fake.length];
  const real = shuffle(plainStations, random);
  for (let i = 0; i < 4; i++) {
    const route = real[i].routes.find((r) => !SHUTTLES.has(r))!;
    const fakeName = nextFake();
    add({ id: `unk-closure-${i + 1}`, category: "unknown_entity", group: `unk-${fakeName}`, question: `${closurePhrase([route], real[i].name, fakeName)} ${ASK.total}`, expect: { kind: "decline" }, source: `"${fakeName}" is not a station`, needs: ["resolve_places"] });
  }
  for (let i = 0; i < 3; i++) {
    const route = FICTIONAL_ROUTES[i];
    const a = real[4 + i];
    const b = real[10 + i];
    add({ id: `unk-route-${route}`, category: "unknown_entity", group: `unk-route-${route}`, question: `${closurePhrase([route], a.name, b.name)} ${ASK.total}`, expect: { kind: "decline" }, source: `there is no ${route} train in the network`, needs: ["resolve_places"] });
  }
  for (let i = 0; i < 3; i++) {
    const fakeName = nextFake();
    add({ id: `unk-trip-${i + 1}`, category: "unknown_entity", group: `unk-${fakeName}`, question: i % 2 ? ASK.minutes(real[14 + i].name, fakeName) : ASK.minutes(fakeName, real[14 + i].name), expect: { kind: "decline" }, source: `"${fakeName}" is not a station`, needs: ["resolve_places"] });
  }
  for (let i = 0; i < 3; i++) {
    const fakeName = nextFake();
    add({ id: `unk-lines-${i + 1}`, category: "unknown_entity", group: `unk-${fakeName}`, question: ASK.lines(fakeName), expect: { kind: "decline" }, source: `"${fakeName}" is not a station`, needs: ["resolve_places"] });
  }
  for (let i = 0; i < 2; i++) {
    const fakeName = nextFake();
    add({ id: `unk-stepfree-${i + 1}`, category: "unknown_entity", group: `unk-${fakeName}`, question: ASK.stepFree(fakeName, real[18 + i].name), expect: { kind: "decline" }, source: `"${fakeName}" is not a station`, needs: ["resolve_places"] });
  }
  {
    const fakeName = nextFake();
    add({ id: "unk-elevator-1", category: "unknown_entity", group: `unk-${fakeName}`, question: ASK.elevatorSince("A", fakeName), expect: { kind: "decline" }, source: `"${fakeName}" is not a station`, needs: ["resolve_places"] });
  }
  add({ id: "unk-route-V-trip", category: "unknown_entity", group: "unk-route-V", question: `How many stops does the V train make between ${real[20].name} and ${real[21].name} at 8 a.m. on a weekday?`, expect: { kind: "decline" }, source: "there is no V train in the network", needs: ["resolve_places"] });

  return split(out, seed);
}

/**
 * Splits by group, per category, with its own seeded shuffle: about 30% of each category's groups go to dev, the
 * rest are held out. Questions about one closure or trip never straddle the split.
 */
export function split(questions: Omit<EvalQuestion, "split">[], seed = SEED): EvalQuestion[] {
  const random = rng(seed ^ 0x5eed);
  const dev = new Set<string>();
  const categories = [...new Set(questions.map((q) => q.category))].sort();
  const assigned = new Set<string>();
  for (const c of categories) {
    const groups = [...new Set(questions.filter((q) => q.category === c && !assigned.has(q.group)).map((q) => q.group))].sort();
    for (const g of groups) assigned.add(g);
    for (const g of shuffle(groups, random).slice(0, Math.round(groups.length * DEV_SHARE))) dev.add(g);
  }
  return questions.map((q) => ({ ...q, split: dev.has(q.group) ? "dev" : "heldout" }));
}
