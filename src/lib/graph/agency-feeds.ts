import { createHash } from "node:crypto";

/**
 * The agency's real records: the MTA's public elevator and escalator feeds, its live subway alerts, and
 * data.ny.gov datasets (the equipment asset inventory, the service alert archive, rider complaints about
 * outages, and accessibility capital projects). This module fetches them, keeps the raw shapes for the
 * committed snapshot (data/agency/snapshot.json), and parses them into records with provenance: the dataset,
 * the record's key and URL, when it was fetched, and a hash of its content. No key is needed for any of them.
 */

// ---------------------------------------------------------------- sources

export type DatasetId =
  | "mta-ene-equipment"
  | "mta-ene-outages"
  | "mta-ene-upcoming"
  | "mta-subway-alerts"
  | "39hk-dx4f"
  | "94fv-bak7"
  | "7kct-peq7"
  | "nh7m-at3e"
  | "9hy6-8j6t"
  | "nswv-d6bz";

export interface Dataset {
  id: DatasetId;
  name: string;
  /** Where riders and judges can read it. */
  page: string;
  /** Live feeds are refreshed on demand; archives once a day. */
  tier: "live" | "archive";
}

const MTA_FEED = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/";
const SODA = "https://data.ny.gov/resource/";

export const DATASETS: Record<DatasetId, Dataset> = {
  "mta-ene-equipment": { id: "mta-ene-equipment", name: "MTA elevator and escalator equipment feed", page: `${MTA_FEED}nyct%2Fnyct_ene_equipments.json`, tier: "live" },
  "mta-ene-outages": { id: "mta-ene-outages", name: "MTA elevator and escalator outages feed", page: `${MTA_FEED}nyct%2Fnyct_ene.json`, tier: "live" },
  "mta-ene-upcoming": { id: "mta-ene-upcoming", name: "MTA planned elevator and escalator outages feed", page: `${MTA_FEED}nyct%2Fnyct_ene_upcoming.json`, tier: "live" },
  "mta-subway-alerts": { id: "mta-subway-alerts", name: "MTA subway service alerts feed (GTFS-realtime)", page: `${MTA_FEED}camsys%2Fsubway-alerts.json`, tier: "live" },
  "39hk-dx4f": { id: "39hk-dx4f", name: "MTA Subway Stations (data.ny.gov)", page: "https://data.ny.gov/d/39hk-dx4f", tier: "archive" },
  "94fv-bak7": { id: "94fv-bak7", name: "MTA Subway Elevator and Escalator Asset Inventory (data.ny.gov)", page: "https://data.ny.gov/d/94fv-bak7", tier: "archive" },
  "7kct-peq7": { id: "7kct-peq7", name: "MTA Service Alerts: Beginning April 2020 (data.ny.gov)", page: "https://data.ny.gov/d/7kct-peq7", tier: "archive" },
  "nh7m-at3e": { id: "nh7m-at3e", name: "MTA Customer Feedback: Beginning 2018 (data.ny.gov)", page: "https://data.ny.gov/d/nh7m-at3e", tier: "archive" },
  "9hy6-8j6t": { id: "9hy6-8j6t", name: "MTA Capital Project Details (data.ny.gov)", page: "https://data.ny.gov/d/9hy6-8j6t", tier: "archive" },
  "nswv-d6bz": { id: "nswv-d6bz", name: "MTA Capital Project Schedules (data.ny.gov)", page: "https://data.ny.gov/d/nswv-d6bz", tier: "archive" },
};

/** The URL that returns one record, so a citation can be checked against the source. */
export function recordUrl(dataset: DatasetId, key: string): string {
  const q = encodeURIComponent(key);
  switch (dataset) {
    case "94fv-bak7":
      return `${SODA}94fv-bak7.json?equipment_code=${q}`;
    case "7kct-peq7":
      return `${SODA}7kct-peq7.json?alert_id=${q}`;
    case "9hy6-8j6t":
    case "nswv-d6bz":
      return `${SODA}${dataset}.json?project_id=${q}`;
    case "39hk-dx4f":
      return `${SODA}39hk-dx4f.json?complex_id=${q}`;
    case "nh7m-at3e":
      return `${SODA}nh7m-at3e.json?$where=${encodeURIComponent(`subcategory='Elevator / escalator outage' AND location_name='${key.replace(/'/g, "''")}'`)}`;
    default:
      return DATASETS[dataset].page;
  }
}

// ---------------------------------------------------------------- raw shapes (as the feeds publish them, trimmed)

export interface RawEquipment {
  station: string;
  borough: string;
  trainno: string;
  equipmentno: string;
  equipmenttype: string;
  serving: string;
  ADA: string;
  isactive: string;
  nonNYCT: string;
  shortdescription: string;
  linesservedbyelevator: string;
  elevatorsgtfsstopid: string;
  elevatormrn: string;
  stationcomplexid: string;
  nextadanorth: string;
  nextadasouth: string;
  redundant: number;
  busconnections: string;
  alternativeroute: string;
}

export interface RawOutage {
  station: string;
  borough: string;
  trainno: string;
  equipment: string;
  equipmenttype: string;
  serving: string;
  ADA: string;
  outagedate: string;
  estimatedreturntoservice: string;
  reason: string;
  isupcomingoutage: string;
  ismaintenanceoutage: string;
}

/** A GTFS-realtime alert entity with only the English text kept. */
export interface RawAlert {
  id: string;
  periods: { start?: number; end?: number }[];
  entities: { route?: string; stop?: string }[];
  header: string;
  description: string | null;
  type: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface RawAsset {
  equipment_code: string;
  elevator_or_escalator?: string;
  station_complex_mrn?: string;
  station_name?: string;
  subway_line?: string;
  borough?: string;
  original_installation_date?: string;
  latest_installation_date?: string;
  service_status?: string;
  nyct_owned?: string;
  maintained_by?: string;
  installer?: string;
  notes?: string;
}

export interface RawNotice {
  alert_id: string;
  event_id: string;
  update_number: string;
  date: string;
  status_label?: string;
  affected?: string;
  header?: string;
}

export interface RawComplaintMonth {
  location_name?: string;
  month: string;
  n: string;
}

export interface RawProject {
  project_id: string;
  title: string;
  stage?: string;
  phase?: string;
  description?: string;
  services?: string;
  initiatives?: string;
  prime_contractor?: string;
  start_date?: string;
  goal_completion_date?: string;
  estimated_actual_completion_date?: string;
  goal_project_cost?: string;
  estimated_actual_project_cost?: string;
}

export interface RawMilestone {
  project_id: string;
  phase?: string;
  phase_sequence?: string;
  phase_state?: string;
  phase_est_actual_end_date?: string;
  activity_title?: string;
  activity_description?: string;
  activity_date?: string;
  update_date?: string;
}

export interface OutageCapture {
  fetchedMs: number;
  /** The outages feed, which also lists planned outages (isupcomingoutage = "Y"). */
  outages: RawOutage[];
}

/** The committed snapshot: every source as fetched, with the outage feed kept at several times for history. */
export interface AgencySnapshot {
  version: 1;
  fetched: Partial<Record<DatasetId, number>>;
  equipment: RawEquipment[];
  /** Oldest first; the last one is the current state. */
  outageCaptures: OutageCapture[];
  upcoming: RawOutage[];
  alerts: { fetchedMs: number; feedMs: number | null; alerts: RawAlert[] };
  /** GTFS stop id to station complex id. */
  stops: Record<string, string>;
  assets: RawAsset[];
  notices: RawNotice[];
  complaints: RawComplaintMonth[];
  projects: RawProject[];
  milestones: RawMilestone[];
}

// ---------------------------------------------------------------- fetching

/** How far back the archived alert history and the complaint counts reach. */
const NOTICES_SINCE = "2026-07-01T00:00:00";
export const COMPLAINTS_SINCE = "2025-01-01T00:00:00";

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

const soda = (id: string, query: Record<string, string>) => `${SODA}${id}.json?${new URLSearchParams(query).toString()}`;

type GtfsAlert = {
  id: string;
  alert?: {
    active_period?: { start?: number; end?: number }[];
    informed_entity?: { route_id?: string; stop_id?: string }[];
    header_text?: { translation?: { text: string; language?: string }[] };
    description_text?: { translation?: { text: string; language?: string }[] };
    "transit_realtime.mercury_alert"?: { created_at?: number; updated_at?: number; alert_type?: string };
  };
};

const english = (t?: { translation?: { text: string; language?: string }[] }) =>
  t?.translation?.find((x) => x.language === "en")?.text ?? t?.translation?.find((x) => !x.language)?.text ?? null;

/** Keeps what the brain reads from a GTFS-realtime alert: periods, routes and stops, English text, times. */
export function trimAlert(e: GtfsAlert): RawAlert | null {
  const a = e.alert;
  const header = english(a?.header_text);
  if (!a || !header) return null;
  const m = a["transit_realtime.mercury_alert"];
  return {
    id: e.id,
    periods: (a.active_period ?? []).map((p) => ({ ...(p.start ? { start: p.start } : {}), ...(p.end ? { end: p.end } : {}) })),
    entities: (a.informed_entity ?? []).map((i) => ({ ...(i.route_id ? { route: i.route_id } : {}), ...(i.stop_id ? { stop: i.stop_id } : {}) })),
    header,
    description: english(a.description_text),
    type: m?.alert_type ?? null,
    createdAt: m?.created_at ?? null,
    updatedAt: m?.updated_at ?? null,
  };
}

export interface LiveFeeds {
  fetchedMs: number;
  equipment: RawEquipment[];
  outages: RawOutage[];
  upcoming: RawOutage[];
  alerts: { feedMs: number | null; alerts: RawAlert[] };
}

/** The four live MTA feeds, fetched together. Throws when any of them cannot be read. */
export async function fetchLive(): Promise<LiveFeeds> {
  const fetchedMs = Date.now();
  const [equipment, outages, upcoming, alerts] = await Promise.all([
    getJson<RawEquipment[]>(DATASETS["mta-ene-equipment"].page),
    getJson<RawOutage[]>(DATASETS["mta-ene-outages"].page),
    getJson<RawOutage[]>(DATASETS["mta-ene-upcoming"].page),
    getJson<{ header?: { timestamp?: number }; entity?: GtfsAlert[] }>(DATASETS["mta-subway-alerts"].page),
  ]);
  if (!Array.isArray(equipment) || !Array.isArray(outages) || !Array.isArray(upcoming)) throw new Error("An elevator feed did not return a list.");
  return {
    fetchedMs,
    equipment,
    outages,
    upcoming,
    alerts: {
      feedMs: alerts.header?.timestamp ? alerts.header.timestamp * 1000 : null,
      alerts: (alerts.entity ?? []).map(trimAlert).filter((a): a is RawAlert => Boolean(a)),
    },
  };
}

export interface ArchiveFeeds {
  fetchedMs: number;
  stops: Record<string, string>;
  assets: RawAsset[];
  notices: RawNotice[];
  complaints: RawComplaintMonth[];
  projects: RawProject[];
  milestones: RawMilestone[];
}

const ASSET_FIELDS = [
  "equipment_code",
  "elevator_or_escalator",
  "station_complex_mrn",
  "station_name",
  "subway_line",
  "borough",
  "original_installation_date",
  "latest_installation_date",
  "service_status",
  "nyct_owned",
  "maintained_by",
  "installer",
  "notes",
];

/** The data.ny.gov datasets: stations, asset inventory, the alert archive, complaint counts, accessibility projects. */
export async function fetchArchive(): Promise<ArchiveFeeds> {
  const fetchedMs = Date.now();
  const [stations, assets, notices, complaints, projects] = await Promise.all([
    getJson<{ gtfs_stop_id: string; complex_id: string }[]>(soda("39hk-dx4f", { $select: "gtfs_stop_id,complex_id", $limit: "5000" })),
    getJson<RawAsset[]>(soda("94fv-bak7", { $select: ASSET_FIELDS.join(","), $limit: "5000", $order: "equipment_code" })),
    getJson<RawNotice[]>(
      soda("7kct-peq7", {
        $select: "alert_id,event_id,update_number,date,status_label,affected,header",
        $where: `agency='NYCT Subway' AND date >= '${NOTICES_SINCE}'`,
        $order: "date,alert_id",
        $limit: "50000",
      }),
      60_000,
    ),
    getJson<RawComplaintMonth[]>(
      soda("nh7m-at3e", {
        $select: "location_name,date_trunc_ym(created_at) AS month,count(*) AS n",
        $where: `agency='Subways' AND subcategory='Elevator / escalator outage' AND created_at >= '${COMPLAINTS_SINCE}'`,
        $group: "location_name,month",
        $order: "location_name,month",
        $limit: "50000",
      }),
      60_000,
    ),
    getJson<RawProject[]>(soda("9hy6-8j6t", { $where: "initiatives like '%Accessibility%'", $order: "project_id", $limit: "1000" })),
  ]);
  const ids = projects.map((p) => `'${p.project_id.replace(/'/g, "")}'`).join(",");
  const milestones = ids
    ? await getJson<RawMilestone[]>(soda("nswv-d6bz", { $where: `project_id in (${ids})`, $order: "project_id,phase_sequence,activity_date", $limit: "5000" }))
    : [];
  return {
    fetchedMs,
    stops: Object.fromEntries(stations.filter((s) => s.gtfs_stop_id && s.complex_id).map((s) => [s.gtfs_stop_id, s.complex_id])),
    assets: assets.filter((a) => a.equipment_code),
    notices: notices.filter((n) => n.alert_id && n.event_id),
    complaints,
    projects: projects.map((p) => {
      const { project_id, title, stage, phase, description, services, initiatives, prime_contractor, start_date, goal_completion_date, estimated_actual_completion_date, goal_project_cost, estimated_actual_project_cost } = p;
      return { project_id, title, stage, phase, description, services, initiatives, prime_contractor, start_date, goal_completion_date, estimated_actual_completion_date, goal_project_cost, estimated_actual_project_cost };
    }),
    milestones,
  };
}

// ---------------------------------------------------------------- time

const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** New York's offset from UTC at an instant, in ms (negative: -4 h in summer, -5 h in winter). */
function nyOffset(ms: number): number {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** A wall-clock time in New York as an instant. */
export function nyTime(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = guess - nyOffset(guess);
  ms = guess - nyOffset(ms);
  return ms;
}

/** "10/30/2026 10:00:00 PM" (the elevator feeds, New York time) as an instant; null when blank or unreadable. */
export function parseMtaDate(text: string | null | undefined): number | null {
  const m = text?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i);
  if (!m) return null;
  let h = m[4] ? Number(m[4]) : 0;
  const pm = m[7]?.toUpperCase() === "PM";
  if (m[7]) h = (h % 12) + (pm ? 12 : 0);
  return nyTime(Number(m[3]), Number(m[1]), Number(m[2]), h, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0);
}

/** "2026-08-11T23:51:00.000" (data.ny.gov floating timestamps, New York time) as an instant. */
export function parseSodaDate(text: string | null | undefined): number | null {
  const m = text?.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return nyTime(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0);
}

/** An instant as New York wall-clock "2026-10-31 06:00", the form answers and the evaluation compare. */
export function nyStamp(ms: number): string {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${String(+p.hour % 24).padStart(2, "0")}:${p.minute}`;
}

/** "2026 Q3" for an instant, in New York time. */
export function quarterOf(ms: number): string {
  const [y, m] = nyStamp(ms).split("-").map(Number);
  return `${y} Q${Math.floor((m - 1) / 3) + 1}`;
}

// ---------------------------------------------------------------- parsed records

/** Where a record came from. Stored on every node of the agency graph. */
export interface Provenance {
  dataset: DatasetId;
  /** The record's key in its dataset (equipment code, alert id, project id…). */
  record: string;
  url: string;
  fetchedMs: number;
  /** sha1 of the record as published, so an unchanged record is not rewritten and a changed one is noticed. */
  hash: string;
}

const hashOf = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

const prov = (dataset: DatasetId, record: string, fetchedMs: number, raw: unknown): Provenance => ({
  dataset,
  record,
  url: recordUrl(dataset, record),
  fetchedMs,
  hash: hashOf(raw),
});

export interface StationRef {
  id: string;
  name: string;
  routes: string[];
}

export interface Equipment {
  id: string;
  kind: "elevator" | "escalator";
  station: string | null;
  stationName: string;
  /** Detour route ids the unit serves. */
  lines: string[];
  serving: string;
  short: string;
  ada: boolean;
  active: boolean;
  nonNYCT: boolean;
  nextAdaNorth: string | null;
  nextAdaSouth: string | null;
  redundant: boolean;
  buses: string | null;
  /** The MTA's own step-free alternative, verbatim. */
  altRoute: string | null;
  /** From the asset inventory (94fv-bak7); null when the unit is not in it. */
  maintainedBy: string | null;
  installer: string | null;
  serviceStatus: string | null;
  owned: string | null;
  installedMs: number | null;
  text: string;
  prov: Provenance;
  asset: Provenance | null;
}

export interface Outage {
  /** "EL382@2026-10-30 22:00": one outage of one unit, keyed by the unit and when it went out. */
  id: string;
  equipment: string;
  kind: "elevator" | "escalator";
  station: string | null;
  stationName: string;
  lines: string[];
  serving: string;
  ada: boolean;
  reason: string;
  openedMs: number | null;
  estReturnMs: number | null;
  upcoming: boolean;
  maintenance: boolean;
  /** The feed row as published, quoted in citations. */
  quote: string;
  text: string;
  prov: Provenance;
}

export interface Alert {
  id: string;
  header: string;
  description: string | null;
  type: string | null;
  periods: { start: number | null; end: number | null }[];
  startMs: number | null;
  endMs: number | null;
  createdMs: number | null;
  updatedMs: number | null;
  routes: string[];
  stations: string[];
  text: string;
  prov: Provenance;
}

export interface Notice {
  id: string;
  event: string;
  update: number;
  atMs: number;
  status: string | null;
  routes: string[];
  affected: string | null;
  header: string;
  text: string;
  prov: Provenance;
}

export interface NoticeEvent {
  id: string;
  routes: string[];
  firstMs: number;
  lastMs: number;
  updates: number;
  status: string | null;
  firstHeader: string;
  lastHeader: string;
  text: string;
}

export interface Complaints {
  id: string;
  location: string;
  station: string | null;
  quarter: string;
  count: number;
  text: string;
  prov: Provenance;
}

export interface Project {
  id: string;
  record: string;
  title: string;
  stage: string | null;
  phase: string | null;
  description: string | null;
  routes: string[];
  stations: string[];
  contractor: string | null;
  startMs: number | null;
  goalMs: number | null;
  estimatedMs: number | null;
  goalCost: number | null;
  estimatedCost: number | null;
  text: string;
  prov: Provenance;
}

export interface Milestone {
  id: string;
  project: string;
  phase: string | null;
  sequence: number;
  state: string | null;
  title: string | null;
  description: string | null;
  atMs: number | null;
  phaseEndMs: number | null;
  text: string;
  prov: Provenance;
}

export interface AgencyRecords {
  equipment: Equipment[];
  /** One list per capture, oldest first; the last is current. */
  outageCaptures: { fetchedMs: number; outages: Outage[] }[];
  alerts: Alert[];
  alertsFetchedMs: number;
  notices: Notice[];
  events: NoticeEvent[];
  complaints: Complaints[];
  projects: Project[];
  milestones: Milestone[];
}

const yes = (v: string | undefined) => v?.trim().toUpperCase() === "Y" || v?.trim().toUpperCase() === "YES";
const blank = (v: string | null | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

/** GTFS route ids as Detour's: express variants fold into their line, the Rockaway shuttle is "H". */
export function routeId(raw: string, known: Set<string>): string | null {
  const r = raw.trim().toUpperCase();
  if (known.has(r)) return r;
  const folded: Record<string, string> = { "6X": "6", "7X": "7", FX: "F", SS: "SI", SIR: "SI", SR: "H", "5X": "5" };
  if (folded[r] && known.has(folded[r])) return folded[r];
  return null;
}

/** "B/Q/S" on a unit at a station: each line as a Detour route id; "S" is whichever shuttle stops there. */
export function linesOf(text: string, station: StationRef | undefined, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[/,\s]+/).filter(Boolean)) {
    if (part.toUpperCase() === "S") {
      const shuttle = station?.routes.find((r) => r === "GS" || r === "FS" || r === "H");
      if (shuttle) out.add(shuttle);
      continue;
    }
    const id = routeId(part, known);
    if (id) out.add(id);
  }
  return [...out];
}

const equipmentKind = (t: string) => (t.trim().toUpperCase() === "ES" ? "escalator" : "elevator");

/** The outage feed row as it reads in the feed, for quoting. */
function outageQuote(o: RawOutage): string {
  return [
    `${o.equipment} (${o.equipmenttype}) at ${o.station}, ${o.trainno}`,
    `serving: ${o.serving}`,
    `outagedate: ${o.outagedate}`,
    `estimatedreturntoservice: ${o.estimatedreturntoservice || "not given"}`,
    `reason: ${o.reason}`,
    `isupcomingoutage: ${o.isupcomingoutage}`,
    `ismaintenanceoutage: ${o.ismaintenanceoutage}`,
  ].join("; ");
}

export const outageKey = (equipment: string, openedMs: number | null) => `${equipment}@${openedMs === null ? "unknown" : nyStamp(openedMs)}`;

function parseOutage(o: RawOutage, fetchedMs: number, dataset: DatasetId, eqById: Map<string, Equipment>, stations: Map<string, StationRef>, known: Set<string>): Outage {
  const eq = eqById.get(o.equipment);
  const openedMs = parseMtaDate(o.outagedate);
  const station = eq?.station ?? null;
  const lines = eq?.lines.length ? eq.lines : linesOf(o.trainno, station ? stations.get(station) : undefined, known);
  const quote = outageQuote(o);
  const id = outageKey(o.equipment, openedMs);
  return {
    id,
    equipment: o.equipment,
    kind: equipmentKind(o.equipmenttype),
    station,
    stationName: o.station,
    lines,
    serving: o.serving,
    ada: yes(o.ADA),
    reason: o.reason?.trim() || "not given",
    openedMs,
    estReturnMs: parseMtaDate(o.estimatedreturntoservice),
    upcoming: yes(o.isupcomingoutage),
    maintenance: yes(o.ismaintenanceoutage),
    quote,
    text: `${yes(o.isupcomingoutage) ? "Planned outage" : "Outage"} of ${equipmentKind(o.equipmenttype)} ${o.equipment} at ${o.station} (${o.trainno}), serving ${o.serving}. Out of service since ${o.outagedate}; estimated return ${o.estimatedreturntoservice || "not given"}; reason ${o.reason || "not given"}.`,
    prov: { ...prov(dataset, `${o.equipment} ${o.outagedate}`, fetchedMs, o), url: DATASETS[dataset].page },
  };
}

/** Projects name their lines as "NYCT-B"; other agencies' lines are dropped. */
export function projectRoutes(services: string | undefined, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of (services ?? "").matchAll(/'NYCT-([A-Z0-9]+)'/g)) {
    const id = routeId(m[1], known);
    if (id) out.add(id);
  }
  return [...out];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "av")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** "Hoyt-Schermerhorn (A,C,G) Brooklyn" as the station complex it names, by name and lines; null when unclear. */
export function stationFromLocation(location: string, stations: StationRef[], known: Set<string>): string | null {
  const m = location.match(/^(.*?)\s*\(([^)]*)\)/);
  const name = norm(m ? m[1] : location);
  const routes = m ? m[2].split(/,/).map((r) => routeId(r.trim().split(/[-\s]/)[0], known)).filter((r): r is string => Boolean(r)) : [];
  if (!name) return null;
  const candidates = stations.filter((s) => {
    const n = norm(s.name);
    return n === name || n.split(" ").slice(0, name.split(" ").length).join(" ") === name || n.includes(name) || name.includes(n);
  });
  const exact = candidates.filter((s) => norm(s.name) === name);
  const pool = exact.length ? exact : candidates;
  const onLine = routes.length ? pool.filter((s) => s.routes.some((r) => routes.includes(r))) : pool;
  if (onLine.length === 1) return onLine[0].id;
  if (!routes.length && pool.length === 1) return pool[0].id;
  // Several platforms of one name on the named lines: the one serving the most of them.
  if (onLine.length > 1) {
    const best = [...onLine].sort((a, b) => b.routes.filter((r) => routes.includes(r)).length - a.routes.filter((r) => routes.includes(r)).length);
    const top = best[0].routes.filter((r) => routes.includes(r)).length;
    if (best.filter((s) => s.routes.filter((r) => routes.includes(r)).length === top).length === 1) return best[0].id;
  }
  return null;
}

/** Stations a project's title names, on the project's lines. */
function projectStations(title: string, routes: string[], stations: StationRef[]): string[] {
  const t = ` ${norm(title)} `;
  const found = new Set<string>();
  for (const s of stations) {
    const n = norm(s.name);
    if (n.length < 6 || !t.includes(` ${n} `)) continue;
    if (routes.length && !s.routes.some((r) => routes.includes(r))) continue;
    found.add(s.id);
  }
  return [...found];
}

const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : null);

/** Every snapshot source parsed into records with provenance, wired to Detour's station and route ids. */
export function parseSnapshot(s: AgencySnapshot, network: { stations: StationRef[]; routes: string[] }): AgencyRecords {
  const known = new Set(network.routes);
  const stations = new Map(network.stations.map((x) => [x.id, x]));
  const assets = new Map(s.assets.map((a) => [a.equipment_code, a]));
  const eqFetched = s.fetched["mta-ene-equipment"] ?? 0;
  const assetFetched = s.fetched["94fv-bak7"] ?? 0;

  const equipment: Equipment[] = s.equipment.map((e) => {
    const station = stations.has(e.stationcomplexid) ? e.stationcomplexid : null;
    const a = assets.get(e.equipmentno);
    const kind = equipmentKind(e.equipmenttype);
    const lines = linesOf(e.linesservedbyelevator || e.trainno, station ? stations.get(station) : undefined, known);
    const altRoute = blank(e.alternativeroute);
    const maintainedBy = blank(a?.maintained_by);
    return {
      id: e.equipmentno,
      kind,
      station,
      stationName: e.station,
      lines,
      serving: e.serving,
      short: e.shortdescription,
      ada: yes(e.ADA),
      active: yes(e.isactive),
      nonNYCT: yes(e.nonNYCT),
      nextAdaNorth: blank(e.nextadanorth),
      nextAdaSouth: blank(e.nextadasouth),
      redundant: Number(e.redundant) > 0,
      buses: blank(e.busconnections),
      altRoute,
      maintainedBy,
      installer: blank(a?.installer),
      serviceStatus: blank(a?.service_status),
      owned: blank(a?.nyct_owned),
      installedMs: parseSodaDate(a?.latest_installation_date ?? a?.original_installation_date),
      text: `${kind === "elevator" ? "Elevator" : "Escalator"} ${e.equipmentno} at ${e.station} (${e.trainno}), serving ${e.serving}.${maintainedBy ? ` Maintained by ${maintainedBy}.` : ""}${
        a?.installer ? ` Installed by ${a.installer}.` : ""
      }${a?.service_status ? ` Inventory status: ${a.service_status}.` : ""}${altRoute ? " The MTA publishes an alternative route for it." : ""}`,
      prov: prov("mta-ene-equipment", e.equipmentno, eqFetched, e),
      asset: a ? prov("94fv-bak7", a.equipment_code, assetFetched, a) : null,
    };
  });
  // Units the asset inventory lists that the live feed does not (privately maintained, removed): known by inventory alone.
  const inFeed = new Set(equipment.map((e) => e.id));
  for (const a of s.assets) {
    if (inFeed.has(a.equipment_code)) continue;
    const station = a.station_complex_mrn && stations.has(a.station_complex_mrn) ? a.station_complex_mrn : null;
    const kind = /escalator/i.test(a.elevator_or_escalator ?? "") || a.equipment_code.startsWith("ES") ? "escalator" : "elevator";
    const name = station ? stations.get(station)!.name : (a.station_name ?? "unknown station");
    const maintainedBy = blank(a.maintained_by);
    equipment.push({
      id: a.equipment_code,
      kind,
      station,
      stationName: name,
      lines: [],
      serving: blank(a.notes) ?? "",
      short: blank(a.notes) ?? "",
      ada: false,
      active: !/out of service/i.test(a.service_status ?? ""),
      nonNYCT: a.nyct_owned?.toUpperCase() === "NO",
      nextAdaNorth: null,
      nextAdaSouth: null,
      redundant: false,
      buses: null,
      altRoute: null,
      maintainedBy,
      installer: blank(a.installer),
      serviceStatus: blank(a.service_status),
      owned: blank(a.nyct_owned),
      installedMs: parseSodaDate(a.latest_installation_date ?? a.original_installation_date),
      text: `${kind === "elevator" ? "Elevator" : "Escalator"} ${a.equipment_code} at ${name}${a.notes ? `, ${a.notes}` : ""}.${maintainedBy ? ` Maintained by ${maintainedBy}.` : ""}${a.installer ? ` Installed by ${a.installer}.` : ""}${
        a.service_status ? ` Inventory status: ${a.service_status}.` : ""
      }`,
      prov: prov("94fv-bak7", a.equipment_code, assetFetched, a),
      asset: prov("94fv-bak7", a.equipment_code, assetFetched, a),
    });
  }
  const eqById = new Map(equipment.map((e) => [e.id, e]));

  const outageCaptures = s.outageCaptures.map((c, i) => {
    const last = i === s.outageCaptures.length - 1;
    // The planned-outages feed repeats the planned rows of the outages feed; the latest capture takes both.
    const rows = last ? [...c.outages, ...s.upcoming.filter((u) => !c.outages.some((o) => o.equipment === u.equipment && o.outagedate === u.outagedate))] : c.outages;
    const seen = new Set<string>();
    const outages: Outage[] = [];
    for (const o of rows) {
      const parsed = parseOutage(o, c.fetchedMs, "mta-ene-outages", eqById, stations, known);
      if (seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      outages.push(parsed);
    }
    return { fetchedMs: c.fetchedMs, outages };
  });

  const alerts: Alert[] = s.alerts.alerts.map((a) => {
    const routes = [...new Set(a.entities.map((x) => (x.route ? routeId(x.route, known) : null)).filter((r): r is string => Boolean(r)))];
    const stationIds = [
      ...new Set(
        a.entities
          .map((x) => (x.stop ? (s.stops[x.stop] ?? s.stops[x.stop.replace(/[NS]$/, "")] ?? null) : null))
          .filter((id): id is string => Boolean(id) && stations.has(id!)),
      ),
    ];
    const periods = a.periods.map((p) => ({ start: p.start ? p.start * 1000 : null, end: p.end ? p.end * 1000 : null }));
    const starts = periods.map((p) => p.start).filter((x): x is number => x !== null);
    const ends = periods.map((p) => p.end);
    return {
      id: a.id,
      header: a.header,
      description: a.description,
      type: a.type,
      periods,
      startMs: starts.length ? Math.min(...starts) : null,
      endMs: ends.length && ends.every((x) => x !== null) ? Math.max(...(ends as number[])) : null,
      createdMs: a.createdAt ? a.createdAt * 1000 : null,
      updatedMs: a.updatedAt ? a.updatedAt * 1000 : null,
      routes,
      stations: stationIds,
      text: `Alert ${a.id}${a.type ? ` (${a.type})` : ""} on ${routes.join(", ") || "no line"}: ${a.header}${a.description ? ` ${a.description}` : ""}`,
      prov: { ...prov("mta-subway-alerts", a.id, s.alerts.fetchedMs, a), url: DATASETS["mta-subway-alerts"].page },
    };
  });

  const noticeFetched = s.fetched["7kct-peq7"] ?? 0;
  const notices: Notice[] = s.notices
    .map((n) => {
      const atMs = parseSodaDate(n.date);
      if (atMs === null) return null;
      const routes = [...new Set((n.affected ?? "").split(/[,|;\s]+/).map((r) => routeId(r, known)).filter((r): r is string => Boolean(r)))];
      const header = n.header?.trim() ?? "";
      return {
        id: `NTC-${n.alert_id}`,
        event: `EV-${n.event_id}`,
        update: Number(n.update_number) || 0,
        atMs,
        status: blank(n.status_label),
        routes,
        affected: blank(n.affected),
        header,
        text: `Subway alert event ${n.event_id}, update ${n.update_number} (${n.status_label ?? "no status"}) on ${n.affected ?? "no line"}, ${n.date.slice(0, 16).replace("T", " ")}: ${header}`,
        prov: prov("7kct-peq7", n.alert_id, noticeFetched, n),
      } satisfies Notice;
    })
    .filter((n): n is Notice => n !== null);

  const byEvent = new Map<string, Notice[]>();
  for (const n of notices) byEvent.set(n.event, [...(byEvent.get(n.event) ?? []), n]);
  const events: NoticeEvent[] = [...byEvent.entries()].map(([id, list]) => {
    const sorted = [...list].sort((a, b) => a.update - b.update || a.atMs - b.atMs);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return {
      id,
      routes: [...new Set(sorted.flatMap((n) => n.routes))],
      firstMs: first.atMs,
      lastMs: last.atMs,
      updates: sorted.length,
      status: last.status,
      firstHeader: first.header,
      lastHeader: last.header,
      text: `Subway alert event ${id.slice(3)}: ${sorted.length} update${sorted.length === 1 ? "" : "s"} from ${nyStamp(first.atMs)} to ${nyStamp(last.atMs)}. Latest: ${last.header}`,
    };
  });

  const complaintsFetched = s.fetched["nh7m-at3e"] ?? 0;
  const byQuarter = new Map<string, { location: string; station: string | null; quarter: string; count: number; raw: RawComplaintMonth[] }>();
  const stationList = network.stations;
  const located = new Map<string, string | null>();
  for (const c of s.complaints) {
    if (!c.location_name) continue;
    const at = parseSodaDate(c.month);
    if (at === null) continue;
    if (!located.has(c.location_name)) located.set(c.location_name, stationFromLocation(c.location_name, stationList, known));
    const quarter = quarterOf(at);
    const key = `${c.location_name}|${quarter}`;
    const entry = byQuarter.get(key) ?? { location: c.location_name, station: located.get(c.location_name) ?? null, quarter, count: 0, raw: [] };
    entry.count += Number(c.n) || 0;
    entry.raw.push(c);
    byQuarter.set(key, entry);
  }
  const complaints: Complaints[] = [...byQuarter.values()].map((c) => ({
    id: `CMP-${hashOf(c.location).slice(0, 8)}-${c.quarter.replace(" ", "")}`,
    location: c.location,
    station: c.station,
    quarter: c.quarter,
    count: c.count,
    text: `${c.count} rider complaint${c.count === 1 ? "" : "s"} about elevator or escalator outages at ${c.location} in ${c.quarter}.`,
    prov: prov("nh7m-at3e", c.location, complaintsFetched, c.raw),
  }));

  const projectsFetched = s.fetched["9hy6-8j6t"] ?? 0;
  const projects: Project[] = s.projects.map((p) => {
    const routes = projectRoutes(p.services, known);
    return {
      id: `CP-${p.project_id}`,
      record: p.project_id,
      title: p.title,
      stage: blank(p.stage),
      phase: blank(p.phase),
      description: blank(p.description),
      routes,
      stations: projectStations(p.title, routes, stationList),
      contractor: blank(p.prime_contractor),
      startMs: parseSodaDate(p.start_date),
      goalMs: parseSodaDate(p.goal_completion_date),
      estimatedMs: parseSodaDate(p.estimated_actual_completion_date),
      goalCost: num(p.goal_project_cost),
      estimatedCost: num(p.estimated_actual_project_cost),
      text: `Capital project ${p.project_id}: ${p.title}. Stage: ${p.stage ?? "not given"}.${p.description ? ` ${p.description}` : ""}`,
      prov: prov("9hy6-8j6t", p.project_id, projectsFetched, p),
    };
  });
  const milestonesFetched = s.fetched["nswv-d6bz"] ?? 0;
  const counter = new Map<string, number>();
  const milestones: Milestone[] = s.milestones.map((m) => {
    const key = `${m.project_id}-${m.phase_sequence ?? "0"}`;
    const n = (counter.get(key) ?? 0) + 1;
    counter.set(key, n);
    const atMs = parseSodaDate(m.activity_date);
    return {
      id: `CP-${key}-${n}`,
      project: `CP-${m.project_id}`,
      phase: blank(m.phase),
      sequence: Number(m.phase_sequence) || 0,
      state: blank(m.phase_state),
      title: blank(m.activity_title),
      description: blank(m.activity_description),
      atMs,
      phaseEndMs: parseSodaDate(m.phase_est_actual_end_date),
      text: `Capital project ${m.project_id}, ${m.phase ?? "phase"} (${m.phase_state ?? "no state"})${m.activity_title ? `: ${m.activity_title}` : ""}${atMs ? ` on ${nyStamp(atMs).slice(0, 10)}` : ""}${m.activity_description ? `. ${m.activity_description}` : ""}`,
      prov: prov("nswv-d6bz", m.project_id, milestonesFetched, m),
    };
  });

  return { equipment, outageCaptures, alerts, alertsFetchedMs: s.alerts.fetchedMs, notices, events, complaints, projects, milestones };
}
