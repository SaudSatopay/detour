import { linesOf, nyStamp, parseMtaDate, parseSodaDate, quarterOf, stationFromLocation, type AgencySnapshot, type StationRef } from "./agency-feeds";

/**
 * The brain's held-out evaluation, minus the database: questions generated from the committed snapshot with their
 * correct answers computed here in plain code from the raw feed records (never through FalkorDB), a fixed-seed
 * split that holds out whole stations, and the grading (exact match, set F1, correct refusals, bootstrap intervals).
 * scripts/eval/brain-eval.ts asks each question of the brain's graph tools and of two baselines.
 */

export const EVAL_SEED = 20261019;
/** Share of keys (stations, alerts, events, projects) held out. */
const HELD_OUT = 0.6;

export type QuestionType =
  | "status"
  | "return_time"
  | "alternative"
  | "maintainer"
  | "alert_lines"
  | "alert_stations"
  | "alert_outages"
  | "station_outages"
  | "line_outages"
  | "outages_since"
  | "resolved_since"
  | "project_stage"
  | "milestone_date"
  | "complaints"
  | "chain_count"
  | "chain_last"
  | "decision_basis"
  | "decision_by";

export const TYPE_LABEL: Record<QuestionType, string> = {
  status: "Is a unit in service now",
  return_time: "Outage's estimated return",
  alternative: "The MTA's alternative route",
  maintainer: "Who maintains a unit",
  alert_lines: "Lines an alert affects",
  alert_stations: "Stations an alert affects",
  alert_outages: "Units out at an alert's stations (3 hops)",
  station_outages: "Units out at a station, by name",
  line_outages: "Stations on a line with outages",
  outages_since: "Outages begun since a time",
  resolved_since: "Outages resolved since a time",
  project_stage: "Capital project stage",
  milestone_date: "Capital project milestone date",
  complaints: "Outage complaints per station and quarter",
  chain_count: "Updates in an alert event",
  chain_last: "An alert event's last update",
  decision_basis: "What a decision rests on (sample org)",
  decision_by: "Who made a decision (sample org)",
};

export interface EvalQuestion {
  id: string;
  type: QuestionType;
  question: string;
  /** The question in its generated wording, before rewording (the keyword baseline reads its parameters from it). */
  canonical: string;
  /** The correct answer as a set of normalized strings; null when the records do not hold an answer (a refusal is right). */
  gold: string[] | null;
  /** True when the answer is a set (scored by F1); false when it is one value. */
  set: boolean;
  /** What the split is keyed on: a station complex id, an alert or event id, a project, a line. */
  key: string;
  split: "dev" | "heldout";
}

// ---------------------------------------------------------------- seeded randomness

/** mulberry32: a small, fast, seeded generator. */
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

/** FNV-1a, for a split that depends only on the key and the seed. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function splitOf(key: string, seed = EVAL_SEED): "dev" | "heldout" {
  return hash32(`${seed}:${key}`) / 4294967296 < HELD_OUT ? "heldout" : "dev";
}

function sample<T>(items: T[], n: number, rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ---------------------------------------------------------------- normalizing and grading

/** Lowercase, straight quotes, single spaces, no trailing punctuation: how answers and gold are compared. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?]+$/g, "")
    .trim();
}

export interface Grade {
  /** 1 when the answer set equals the gold set (both normalized); a correct refusal also scores 1. */
  em: number;
  /** Set F1 between answer and gold; 1 for a correct refusal, 0 for a wrong one or a missed answer. */
  f1: number;
  /** Unanswerable questions only: 1 when the arm refused. */
  refused: number | null;
  /** Answerable questions only: 1 when the arm refused although the records hold the answer. */
  falseRefusal: number | null;
}

export function grade(gold: string[] | null, answer: string[] | null): Grade {
  if (gold === null) {
    const ok = answer === null ? 1 : 0;
    return { em: ok, f1: ok, refused: ok, falseRefusal: null };
  }
  if (answer === null) return { em: 0, f1: 0, refused: null, falseRefusal: 1 };
  const g = new Set(gold.map(normalize));
  const a = new Set(answer.map(normalize));
  if (!g.size && !a.size) return { em: 1, f1: 1, refused: null, falseRefusal: 0 };
  const hit = [...a].filter((x) => g.has(x)).length;
  const precision = a.size ? hit / a.size : 0;
  const recall = g.size ? hit / g.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const em = g.size === a.size && hit === g.size ? 1 : 0;
  return { em, f1, refused: null, falseRefusal: 0 };
}

/** Mean with a seeded percentile bootstrap 95% interval. */
export function bootstrap(values: number[], seed = EVAL_SEED, rounds = 1000): { mean: number; lo: number; hi: number; n: number } {
  const n = values.length;
  if (!n) return { mean: 0, lo: 0, hi: 0, n: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const rand = rng(seed);
  const means: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rand() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(rounds * 0.025)], hi: means[Math.min(rounds - 1, Math.floor(rounds * 0.975))], n };
}

// ---------------------------------------------------------------- question generation

export interface SampleDecision {
  id: string;
  basedOn: string[];
  by: string;
}

/** Route ids the GTFS feeds use, as Detour's (express variants folded). */
function foldRoute(raw: string, known: Set<string>): string | null {
  const r = raw.toUpperCase();
  if (known.has(r)) return r;
  const folded: Record<string, string> = { "6X": "6", "7X": "7", FX: "F", SS: "SI", SIR: "SI", SR: "H", "5X": "5" };
  return folded[r] && known.has(folded[r]) ? folded[r] : null;
}

const day = (ms: number) => nyStamp(ms).slice(0, 10);
const device = (code: string) => (code.startsWith("ES") ? "escalator" : "elevator");

/**
 * At least 300 questions with their answers, from the snapshot's raw records. About a third have no answer in the
 * records (units, alerts, events, projects and lines that do not exist; units with no outage or no published
 * alternative; quarters the complaint data does not cover), so refusing is scored as well as answering.
 */
export function buildQuestions(
  snap: AgencySnapshot,
  network: { stations: StationRef[]; routes: string[] },
  decisions: SampleDecision[],
  seed = EVAL_SEED,
): EvalQuestion[] {
  const rand = rng(seed);
  const known = new Set(network.routes);
  const stations = new Map(network.stations.map((s) => [s.id, s]));
  const qs: Omit<EvalQuestion, "id" | "split" | "canonical">[] = [];
  const add = (type: QuestionType, question: string, gold: string[] | null, key: string, set = false) => qs.push({ type, question, gold, set, key });

  const latest = snap.outageCaptures[snap.outageCaptures.length - 1];
  const units = snap.equipment;
  const unitById = new Map(units.map((u) => [u.equipmentno, u]));
  const current = new Map<string, (typeof latest.outages)[number]>();
  for (const o of latest?.outages ?? []) if (o.isupcomingoutage !== "Y") current.set(o.equipment, o);
  const assets = new Map(snap.assets.map((a) => [a.equipment_code, a]));
  const stationKey = (code: string) => unitById.get(code)?.stationcomplexid ?? assets.get(code)?.station_complex_mrn ?? code;
  // Codes that look real and are not: the same prefixes with numbers no unit uses.
  const fakes: string[] = [];
  for (let n = 901; fakes.length < 80 && n < 999; n += 1) {
    const code = `${n % 2 ? "EL" : "ES"}${n}`;
    if (!unitById.has(code) && !assets.has(code)) fakes.push(code);
  }

  // Unit status and return time: every unit out now, a sample of units in service, and made-up units.
  const outUnits = units.filter((u) => current.has(u.equipmentno));
  const inUnits = sample(units.filter((u) => !current.has(u.equipmentno)), 80, rand);
  for (const u of [...outUnits, ...inUnits]) {
    add("status", `Is ${device(u.equipmentno)} ${u.equipmentno} in service right now?`, [current.has(u.equipmentno) ? "out of service" : "in service"], u.stationcomplexid);
  }
  for (const code of fakes.slice(0, 30)) add("status", `Is ${device(code)} ${code} in service right now?`, null, code);
  for (const u of outUnits) {
    const ret = parseMtaDate(current.get(u.equipmentno)!.estimatedreturntoservice);
    add("return_time", `When is ${device(u.equipmentno)} ${u.equipmentno} expected back in service?`, ret === null ? null : [nyStamp(ret)], u.stationcomplexid);
  }
  for (const u of sample(units.filter((u) => !current.has(u.equipmentno)), 60, rand)) {
    add("return_time", `When is ${device(u.equipmentno)} ${u.equipmentno} expected back in service?`, null, u.stationcomplexid);
  }

  // The MTA's alternative route: units that have one, units that do not, made-up units.
  const withAlt = units.filter((u) => u.alternativeroute?.trim());
  const withoutAlt = units.filter((u) => !u.alternativeroute?.trim());
  for (const u of sample(withAlt, 80, rand)) add("alternative", `What is the MTA's alternative route when ${device(u.equipmentno)} ${u.equipmentno} is out of service?`, [u.alternativeroute.trim()], u.stationcomplexid);
  for (const u of sample(withoutAlt, 50, rand)) add("alternative", `What is the MTA's alternative route when ${device(u.equipmentno)} ${u.equipmentno} is out of service?`, null, u.stationcomplexid);
  for (const code of fakes.slice(30, 45)) add("alternative", `What is the MTA's alternative route when ${device(code)} ${code} is out of service?`, null, code);

  // Who maintains a unit: the asset inventory's maintainer.
  for (const a of sample(snap.assets.filter((x) => x.maintained_by?.trim()), 100, rand)) {
    add("maintainer", `Who maintains ${device(a.equipment_code)} ${a.equipment_code}?`, [a.maintained_by!.trim()], stationKey(a.equipment_code));
  }
  for (const code of fakes.slice(45, 70)) add("maintainer", `Who maintains ${device(code)} ${code}?`, null, code);

  // Alerts: the lines and stations each live alert names.
  const alerts = snap.alerts.alerts;
  for (const a of sample(alerts, 90, rand)) {
    const routes = [...new Set(a.entities.map((e) => (e.route ? foldRoute(e.route, known) : null)).filter((r): r is string => Boolean(r)))];
    add("alert_lines", `Which subway lines does MTA alert ${a.id} affect?`, routes, a.id, true);
  }
  for (const a of sample(alerts.filter((x) => x.entities.some((e) => e.stop)), 50, rand)) {
    const ids = [
      ...new Set(
        a.entities.map((e) => (e.stop ? (snap.stops[e.stop] ?? snap.stops[e.stop.replace(/[NS]$/, "")] ?? null) : null)).filter((id): id is string => Boolean(id) && stations.has(id!)),
      ),
    ];
    add("alert_stations", `Which stations does MTA alert ${a.id} affect?`, ids, a.id, true);
  }
  for (let i = 0; i < 30; i++) {
    const id = `lmm:alert:${990000 + i * 7}`;
    add(i % 2 ? "alert_lines" : "alert_stations", i % 2 ? `Which subway lines does MTA alert ${id} affect?` : `Which stations does MTA alert ${id} affect?`, null, id, true);
  }

  // Three hops: an alert's stations, their units, and which of those are out now.
  const outByStation = new Map<string, string[]>();
  for (const [code] of current) {
    const u = unitById.get(code);
    if (u && stations.has(u.stationcomplexid)) outByStation.set(u.stationcomplexid, [...(outByStation.get(u.stationcomplexid) ?? []), code]);
  }
  const alertStations = (a: (typeof alerts)[number]) =>
    new Set(a.entities.map((e) => (e.stop ? (snap.stops[e.stop] ?? snap.stops[e.stop.replace(/[NS]$/, "")] ?? null) : null)).filter((id): id is string => Boolean(id) && stations.has(id!)));
  const touching = alerts.filter((a) => [...alertStations(a)].some((id) => outByStation.has(id)));
  const quiet = alerts.filter((a) => alertStations(a).size && ![...alertStations(a)].some((id) => outByStation.has(id)));
  for (const a of [...sample(touching, 45, rand), ...sample(quiet, 15, rand)]) {
    const ids = [...alertStations(a)].filter((id) => outByStation.has(id));
    add("alert_outages", `Which stations named in MTA alert ${a.id} have an elevator or escalator out of service right now?`, ids, a.id, true);
  }
  for (let i = 0; i < 10; i++) {
    const id = `lmm:planned_work:${880000 + i * 11}`;
    add("alert_outages", `Which stations named in MTA alert ${id} have an elevator or escalator out of service right now?`, null, id, true);
  }

  // A station by its name: which of its units are out now (stations whose name is unique in the network).
  const nameCount = new Map<string, number>();
  for (const s of network.stations) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
  const unique = network.stations.filter((s) => nameCount.get(s.name) === 1);
  const equipped = new Set(units.map((u) => u.stationcomplexid));
  const withOut = unique.filter((s) => outByStation.has(s.id));
  const withoutOut = unique.filter((s) => equipped.has(s.id) && !outByStation.has(s.id));
  for (const s of [...withOut, ...sample(withoutOut, 30, rand)]) {
    add("station_outages", `Which elevators and escalators at ${s.name} are out of service right now?`, outByStation.get(s.id) ?? [], s.id, true);
  }
  for (const name of ["Atlantis Av", "Gotham Sq", "Mars Pkwy", "Hogwarts Blvd", "Narnia Rd", "Elsewhere St", "Utopia Plaza", "Shangri-La Av", "Brigadoon St", "Avalon Sq"]) {
    add("station_outages", `Which elevators and escalators at ${name} are out of service right now?`, null, `fake:${name}`, true);
  }

  // Stations on each line with a unit out of service now.
  for (const route of network.routes) {
    const ids = new Set<string>();
    for (const [code] of current) {
      const u = unitById.get(code);
      if (!u || !stations.has(u.stationcomplexid)) continue;
      if (linesOf(u.linesservedbyelevator || u.trainno, stations.get(u.stationcomplexid), known).includes(route)) ids.add(u.stationcomplexid);
    }
    add("line_outages", `Which stations on the ${route} have an elevator or escalator out of service right now?`, [...ids], `line:${route}`, true);
  }
  for (const fake of ["K", "V", "T", "8", "9", "P"]) add("line_outages", `Which stations on the ${fake} have an elevator or escalator out of service right now?`, null, `line:${fake}`, true);

  // What changed since a time: outages that began, and (across captures) outages that left the feed.
  const seen = new Map<string, { code: string; opened: number | null; upcoming: boolean }>();
  for (const c of snap.outageCaptures) {
    for (const o of c.outages) seen.set(`${o.equipment}|${o.outagedate}`, { code: o.equipment, opened: parseMtaDate(o.outagedate), upcoming: o.isupcomingoutage === "Y" });
  }
  const begun = [...seen.values()].filter((o) => !o.upcoming && o.opened !== null).sort((a, b) => b.opened! - a.opened!);
  const cuts = new Set<number>();
  for (let i = 0; i < Math.min(begun.length, 60); i += 2) cuts.add(begun[i].opened! - 60_000);
  for (const t of [...cuts].slice(0, 30)) {
    const ids = [...new Set(begun.filter((o) => o.opened! >= t).map((o) => o.code))];
    add("outages_since", `Which elevator and escalator outages began since ${nyStamp(t)}?`, ids, `since:${t}`, true);
  }
  if (snap.outageCaptures.length > 1) {
    // An outage resolves at the first capture that no longer lists it.
    const resolvedAt = new Map<string, number>();
    for (let i = 1; i < snap.outageCaptures.length; i++) {
      const now = new Set(snap.outageCaptures[i].outages.map((o) => `${o.equipment}|${o.outagedate}`));
      for (const o of snap.outageCaptures[i - 1].outages) {
        const k = `${o.equipment}|${o.outagedate}`;
        if (!now.has(k) && !resolvedAt.has(k)) resolvedAt.set(k, snap.outageCaptures[i].fetchedMs);
      }
      // One that came back is open again.
      for (const k of now) resolvedAt.delete(k);
    }
    for (const c of snap.outageCaptures.slice(0, -1)) {
      const t = c.fetchedMs;
      const ids = [...new Set([...resolvedAt.entries()].filter(([, at]) => at >= t).map(([k]) => k.split("|")[0]))];
      add("resolved_since", `Which elevator and escalator outages were resolved since ${nyStamp(t)}?`, ids, `resolved:${t}`, true);
    }
  }

  // Capital projects: stage, and the date of each named milestone.
  for (const p of snap.projects) add("project_stage", `What stage is MTA capital project ${p.project_id} in?`, p.stage ? [p.stage] : null, `project:${p.project_id}`);
  for (const id of ["1234", "4321", "7777", "5150", "8008", "2468", "1357", "9090", "3141", "2718"]) add("project_stage", `What stage is MTA capital project ${id} in?`, null, `project:${id}`);
  const byTitle = new Map<string, string[]>();
  for (const m of snap.milestones) {
    if (!m.activity_title || !m.activity_date) continue;
    const k = `${m.project_id}|${m.activity_title}`;
    byTitle.set(k, [...(byTitle.get(k) ?? []), day(parseSodaDate(m.activity_date)!)]);
  }
  for (const [k, dates] of sample([...byTitle.entries()], 60, rand)) {
    const [pid, title] = k.split("|");
    add("milestone_date", `When did MTA capital project ${pid} reach the milestone "${title}"?`, [...new Set(dates)], `project:${pid}`, true);
  }
  for (const p of sample(snap.projects, 20, rand)) add("milestone_date", `When did MTA capital project ${p.project_id} reach the milestone "Ribbon cutting ceremony"?`, null, `project:${p.project_id}`, true);

  // Complaints per station and quarter, for stations whose name is unique in the network.
  const counts = new Map<string, number>();
  const located = new Map<string, string | null>();
  let lastMonth = 0;
  for (const c of snap.complaints) {
    if (!c.location_name) continue;
    const at = parseSodaDate(c.month);
    if (at === null) continue;
    lastMonth = Math.max(lastMonth, at);
    if (!located.has(c.location_name)) located.set(c.location_name, stationFromLocation(c.location_name, network.stations, known));
    const s = located.get(c.location_name);
    if (!s) continue;
    const k = `${s}|${quarterOf(at)}`;
    counts.set(k, (counts.get(k) ?? 0) + (Number(c.n) || 0));
  }
  const quarters: string[] = [];
  for (let at = parseSodaDate("2025-01-01")!; at <= lastMonth; at += 92 * 86_400_000) quarters.push(quarterOf(at));
  const window = [...new Set(quarters)];
  const withComplaints = unique.filter((s) => window.some((q) => counts.has(`${s.id}|${q}`)));
  for (const s of sample(withComplaints, 70, rand)) {
    const q = window.filter((x) => counts.has(`${s.id}|${x}`))[Math.floor(rand() * window.filter((x) => counts.has(`${s.id}|${x}`)).length)];
    add("complaints", `How many rider complaints about elevator or escalator outages were filed for ${s.name} in ${q}?`, [String(counts.get(`${s.id}|${q}`))], s.id);
  }
  for (const s of sample(unique.filter((x) => !withComplaints.includes(x) && equipped.has(x.id)), 15, rand)) {
    const q = window[Math.floor(rand() * window.length)];
    add("complaints", `How many rider complaints about elevator or escalator outages were filed for ${s.name} in ${q}?`, ["0"], s.id);
  }
  for (const s of sample(withComplaints, 40, rand)) {
    const q = ["2019 Q2", "2021 Q4", "2023 Q1", "2024 Q3", "2027 Q2"][Math.floor(rand() * 5)];
    add("complaints", `How many rider complaints about elevator or escalator outages were filed for ${s.name} in ${q}?`, null, s.id);
  }

  // The alert archive: how many updates an event had, and what its last one said.
  const events = new Map<string, { n: number; last: { u: number; at: number; header: string } }>();
  for (const n of snap.notices) {
    const at = parseSodaDate(n.date) ?? 0;
    const u = Number(n.update_number) || 0;
    const e = events.get(n.event_id) ?? { n: 0, last: { u: -1, at: -1, header: "" } };
    e.n += 1;
    if (u > e.last.u || (u === e.last.u && at > e.last.at)) e.last = { u, at, header: (n.header ?? "").trim() };
    events.set(n.event_id, e);
  }
  const chained = [...events.entries()].filter(([, e]) => e.n >= 2);
  for (const [id, e] of sample(chained, 60, rand)) add("chain_count", `How many updates did MTA subway alert event ${id} have?`, [String(e.n)], `event:${id}`);
  for (const [id, e] of sample(chained, 50, rand)) add("chain_last", `What did the last update of MTA subway alert event ${id} say?`, [e.last.header], `event:${id}`);
  for (let i = 0; i < 30; i++) {
    const id = String(99000 + i * 13);
    add(i % 2 ? "chain_count" : "chain_last", i % 2 ? `How many updates did MTA subway alert event ${id} have?` : `What did the last update of MTA subway alert event ${id} say?`, null, `event:${id}`);
  }

  // The sample org's decisions: what each rests on and who made it.
  for (const d of decisions) {
    add("decision_basis", `What does decision ${d.id} rest on?`, d.basedOn, `decision:${d.id}`, true);
    add("decision_by", `Who made decision ${d.id}?`, [d.by], `decision:${d.id}`);
  }
  for (const id of ["DEC-0101-FARE", "DEC-0230-NIGHT"]) {
    add("decision_basis", `What does decision ${id} rest on?`, null, `decision:${id}`, true);
    add("decision_by", `Who made decision ${id}?`, null, `decision:${id}`);
  }

  // Each question is asked in one of several wordings, picked by a generator of its own so the questions and their
  // answers do not depend on the wording.
  const say = rng(seed ^ 0x5eed);
  return qs.map((q, i) => ({ ...q, canonical: q.question, question: reword(q.type, q.question, say), id: `Q${String(i + 1).padStart(4, "0")}`, split: splitOf(q.key, seed) }));
}

type Wording = (m: RegExpMatchArray) => string;

/** Other ways people ask each question; the first wording in each list is the generated one. */
const WORDINGS: Partial<Record<QuestionType, [RegExp, Wording[]]>> = {
  status: [
    /^Is (elevator|escalator) (\S+) in service right now\?$/,
    [(m) => m[0], (m) => `Is ${m[2]} working right now?`, (m) => `Is the ${m[1]} ${m[2]} running at the moment?`, (m) => `Can riders use ${m[1]} ${m[2]} today?`],
  ],
  return_time: [
    /^When is (elevator|escalator) (\S+) expected back in service\?$/,
    [(m) => m[0], (m) => `When will ${m[2]} be fixed?`, (m) => `What is the estimated return to service for ${m[1]} ${m[2]}?`, (m) => `How long will ${m[1]} ${m[2]} be out?`],
  ],
  alternative: [
    /^What is the MTA's alternative route when (elevator|escalator) (\S+) is out of service\?$/,
    [
      (m) => m[0],
      (m) => `If ${m[1]} ${m[2]} is down, what route does the MTA suggest instead?`,
      (m) => `How do I get around ${m[1]} ${m[2]} being out of service?`,
      (m) => `What's the step-free alternative when ${m[2]} is broken?`,
    ],
  ],
  maintainer: [
    /^Who maintains (elevator|escalator) (\S+)\?$/,
    [(m) => m[0], (m) => `Which organization maintains ${m[2]}?`, (m) => `Who is responsible for maintaining ${m[1]} ${m[2]}?`, (m) => `Who services ${m[2]}?`],
  ],
  alert_lines: [
    /^Which subway lines does MTA alert (\S+) affect\?$/,
    [(m) => m[0], (m) => `What lines are hit by MTA alert ${m[1]}?`, (m) => `Alert ${m[1]}: which routes does it cover?`, (m) => `Which trains does alert ${m[1]} affect?`],
  ],
  alert_stations: [/^Which stations does MTA alert (\S+) affect\?$/, [(m) => m[0], (m) => `Which stops are named in alert ${m[1]}?`, (m) => `Where does MTA alert ${m[1]} apply?`]],
  alert_outages: [
    /^Which stations named in MTA alert (\S+) have an elevator or escalator out of service right now\?$/,
    [
      (m) => m[0],
      (m) => `Do any stations in alert ${m[1]} have a broken elevator or escalator right now?`,
      (m) => `For alert ${m[1]}, which affected stations also have an elevator or escalator outage now?`,
    ],
  ],
  station_outages: [
    /^Which elevators and escalators at (.+) are out of service right now\?$/,
    [(m) => m[0], (m) => `What is out of service at ${m[1]} right now, elevators or escalators?`, (m) => `Are any elevators or escalators broken at ${m[1]}?`, (m) => `${m[1]}: which elevators or escalators are down?`],
  ],
  line_outages: [
    /^Which stations on the (\S+) have an elevator or escalator out of service right now\?$/,
    [
      (m) => m[0],
      (m) => `On the ${m[1]}, where are elevators or escalators out of service right now?`,
      (m) => `Which ${m[1]} stations have a broken elevator or escalator?`,
      (m) => `List the stations along the ${m[1]} with an elevator or escalator outage.`,
    ],
  ],
  outages_since: [
    /^Which elevator and escalator outages began since (.+)\?$/,
    [(m) => m[0], (m) => `What elevator or escalator outages have started since ${m[1]}?`, (m) => `List the outages that began since ${m[1]}.`, (m) => `Since ${m[1]}, which units went out of service?`],
  ],
  resolved_since: [
    /^Which elevator and escalator outages were resolved since (.+)\?$/,
    [(m) => m[0], (m) => `Which outages left the feed since ${m[1]}?`, (m) => `What elevator or escalator outages have been fixed since ${m[1]}?`],
  ],
  project_stage: [/^What stage is MTA capital project (\S+) in\?$/, [(m) => m[0], (m) => `Where does MTA capital project ${m[1]} stand?`, (m) => `Which stage has capital project ${m[1]} reached?`]],
  milestone_date: [
    /^When did MTA capital project (\S+) reach the milestone "(.+)"\?$/,
    [(m) => m[0], (m) => `On what date did capital project ${m[1]} hit "${m[2]}"?`, (m) => `Capital project ${m[1]}: when was "${m[2]}"?`],
  ],
  complaints: [
    /^How many rider complaints about elevator or escalator outages were filed for (.+) in (\d{4} Q[1-4])\?$/,
    [
      (m) => m[0],
      (m) => `How many outage complaints did riders make about ${m[1]} in ${m[2]}?`,
      (m) => `In ${m[2]}, how many elevator or escalator complaints came in for ${m[1]}?`,
    ],
  ],
  chain_count: [/^How many updates did MTA subway alert event (\S+) have\?$/, [(m) => m[0], (m) => `How many times was MTA alert event ${m[1]} updated?`, (m) => `Count the updates to subway alert event ${m[1]}.`]],
  chain_last: [/^What did the last update of MTA subway alert event (\S+) say\?$/, [(m) => m[0], (m) => `What was the final update for alert event ${m[1]}?`, (m) => `How did MTA alert event ${m[1]} end?`]],
  decision_basis: [/^What does decision (\S+) rest on\?$/, [(m) => m[0], (m) => `What is decision ${m[1]} based on?`, (m) => `Which records support ${m[1]}?`]],
  decision_by: [/^Who made decision (\S+)\?$/, [(m) => m[0], (m) => `Who decided ${m[1]}?`, (m) => `Whose decision was ${m[1]}?`]],
};

/** One of the question's wordings, chosen by the generator. */
function reword(type: QuestionType, question: string, pick: () => number): string {
  const w = WORDINGS[type];
  const m = w ? question.match(w[0]) : null;
  if (!w || !m) return question;
  return w[1][Math.floor(pick() * w[1].length)](m);
}

// ---------------------------------------------------------------- reporting

export type Arm = "graph" | "keyword" | "latest";

export const ARM_LABEL: Record<Arm, string> = {
  graph: "Graph tools",
  keyword: "Keyword retrieval",
  latest: "Latest snapshot only",
};

export interface ArmScore {
  em: { mean: number; lo: number; hi: number; n: number };
  f1: { mean: number; lo: number; hi: number; n: number };
  /** Share of unanswerable questions refused. */
  refusals: { mean: number; n: number };
  /** Share of answerable questions wrongly refused. */
  falseRefusals: { mean: number; n: number };
}

export function score(grades: Grade[], seed = EVAL_SEED): ArmScore {
  const refusals = grades.map((g) => g.refused).filter((x): x is number => x !== null);
  const falses = grades.map((g) => g.falseRefusal).filter((x): x is number => x !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  return {
    em: bootstrap(grades.map((g) => g.em), seed),
    f1: bootstrap(grades.map((g) => g.f1), seed + 1),
    refusals: { mean: mean(refusals), n: refusals.length },
    falseRefusals: { mean: mean(falses), n: falses.length },
  };
}

/** What data/eval/brain.json holds; the proof page renders it. */
export interface BrainEvalReport {
  generatedMs: number;
  seed: number;
  snapshot: { fetched: Record<string, number>; outageCaptures: number[] };
  questions: { total: number; dev: number; heldout: number; unanswerable: number; heldoutUnanswerable: number };
  arms: Arm[];
  /** Held-out split, every arm. */
  overall: Record<Arm, ArmScore>;
  byType: { type: QuestionType; label: string; n: number; unanswerable: number; arms: Record<Arm, { em: number; f1: number }> }[];
  /** The dev split, for comparison (questions the brain's tools were tuned on). */
  dev: Record<Arm, { em: number; f1: number; n: number }>;
  /** Every held-out question with its gold answer and each arm's answer (null is a refusal). */
  heldout: { id: string; type: QuestionType; question: string; gold: string[] | null; answers: Record<Arm, string[] | null>; em: Record<Arm, number> }[];
  ms: Record<Arm, number>;
}
