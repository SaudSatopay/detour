import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNetwork } from "../network/data";
import {
  DATASETS,
  fetchArchive,
  fetchLive,
  parseSnapshot,
  type AgencyRecords,
  type AgencySnapshot,
  type Alert,
  type DatasetId,
  type Equipment,
  type Outage,
  type Provenance,
} from "./agency-feeds";
import { deleteGraph, run, type GraphParams } from "./db";
import { graphExists, releaseLock, takeLock } from "./meta";
import { AGENCY_GRAPH } from "./names";

/**
 * The shared agency graph: one copy for every visitor, never copied into sandboxes. It holds the MTA's real
 * elevators and escalators (linked to Detour's stations and routes), every outage the feed has listed (an outage
 * that leaves the feed is resolved with a time, never deleted), live service alerts, the alert archive's
 * update chains, rider complaint counts, and accessibility capital projects with their milestones. Every node
 * carries its provenance: dataset, record key, URL, fetch time and content hash.
 */

/** Bump when the agency graph's model changes; an older graph is rebuilt from the snapshot. */
const AGENCY_VERSION = 1;
const BATCH = 800;
const LOCK_MS = 150_000;

export type AgencyTier = "live" | "archive";

// ---------------------------------------------------------------- the snapshot

let snapshot: Promise<AgencySnapshot> | null = null;

/**
 * data/agency/snapshot.json, read from disk (it ships with the server functions through outputFileTracingIncludes).
 * Read rather than imported: type-checking a 3 MB JSON module costs minutes.
 */
export function loadSnapshot(): Promise<AgencySnapshot> {
  snapshot ??= readFile(join(/* turbopackIgnore: true */ process.cwd(), "data", "agency", "snapshot.json"), "utf8").then((text) => JSON.parse(text) as AgencySnapshot);
  snapshot.catch(() => (snapshot = null));
  return snapshot;
}

async function networkRefs() {
  const network = await loadNetwork();
  return {
    stations: network.stations.map((s) => ({ id: s.id, name: s.name, routes: s.routes })),
    routes: network.routes.map((r) => r.id),
  };
}

export async function parseAgency(s: AgencySnapshot): Promise<AgencyRecords> {
  return parseSnapshot(s, await networkRefs());
}

// ---------------------------------------------------------------- upsert planning (pure)

export type OutageStatus = "open" | "upcoming" | "resolved";

export interface OutagePlan {
  /** Outages in the feed now, with the status the feed gives them. */
  upsert: (Outage & { status: OutageStatus })[];
  /** Outages the graph has open or planned that the feed no longer lists: resolved now, never deleted. */
  resolve: string[];
  /** Ids new to the graph, and ids that were resolved and came back. */
  opened: string[];
  reopened: string[];
}

/** What one outage feed capture changes, given what the graph already holds. */
export function planOutages(known: { id: string; status: string }[], current: Outage[]): OutagePlan {
  const byId = new Map(known.map((k) => [k.id, k.status]));
  const now = new Set(current.map((o) => o.id));
  const upsert = current.map((o) => ({ ...o, status: (o.upcoming ? "upcoming" : "open") as OutageStatus }));
  return {
    upsert,
    resolve: known.filter((k) => k.status !== "resolved" && !now.has(k.id)).map((k) => k.id),
    opened: current.filter((o) => !byId.has(o.id)).map((o) => o.id),
    reopened: current.filter((o) => byId.get(o.id) === "resolved").map((o) => o.id),
  };
}

export interface AlertPlan {
  upsert: Alert[];
  /** Alerts the graph has active that the feed dropped: ended now. */
  end: string[];
  started: string[];
}

export function planAlerts(known: { id: string; status: string }[], current: Alert[]): AlertPlan {
  const byId = new Map(known.map((k) => [k.id, k.status]));
  const now = new Set(current.map((a) => a.id));
  return {
    upsert: current,
    end: known.filter((k) => k.status === "active" && !now.has(k.id)).map((k) => k.id),
    started: current.filter((a) => byId.get(a.id) !== "active").map((a) => a.id),
  };
}

// ---------------------------------------------------------------- writing

const provProps = (p: Provenance) => ({ dataset: p.dataset, record: p.record, url: p.url, fetchedMs: p.fetchedMs, hash: p.hash, origin: "mta" });

/** "n.a = r.a, n.b = r.b" for a fixed key list, so a property set to null is removed rather than rejected. */
const setAll = (alias: string, keys: string[]) => keys.map((k) => `${alias}.${k} = r.${k}`).join(", ");

async function batched(graph: string, cypher: string, rows: GraphParams[], extra: GraphParams = {}) {
  for (let i = 0; i < rows.length; i += BATCH) await run(graph, cypher, { rows: rows.slice(i, i + BATCH), ...extra }, { timeoutMs: 60_000 });
}

const EQUIPMENT_KEYS = [
  "kind",
  "station",
  "stationName",
  "lines",
  "serving",
  "short",
  "ada",
  "active",
  "nonNYCT",
  "nextAdaNorth",
  "nextAdaSouth",
  "redundant",
  "buses",
  "altRoute",
  "maintainedBy",
  "installer",
  "serviceStatus",
  "owned",
  "installedMs",
  "text",
  "dataset",
  "record",
  "url",
  "fetchedMs",
  "hash",
  "origin",
  "assetUrl",
  "assetHash",
];

async function writeNetwork(graph: string) {
  const net = await networkRefs();
  await batched(graph, "UNWIND $rows AS r MERGE (s:Station {id: r.id}) SET s.name = r.name, s.routes = r.routes", net.stations.map((s) => ({ ...s })));
  await run(graph, "UNWIND $ids AS id MERGE (:Route {id: id})", { ids: net.routes });
  await run(graph, "MATCH (r:Route), (s:Station) WHERE r.id IN s.routes MERGE (r)-[:SERVES]->(s)");
}

async function writeEquipment(graph: string, list: Equipment[]) {
  const rows = list.map((e) => ({
    id: e.id,
    kind: e.kind,
    station: e.station,
    stationName: e.stationName,
    lines: e.lines,
    serving: e.serving,
    short: e.short,
    ada: e.ada,
    active: e.active,
    nonNYCT: e.nonNYCT,
    nextAdaNorth: e.nextAdaNorth,
    nextAdaSouth: e.nextAdaSouth,
    redundant: e.redundant,
    buses: e.buses,
    altRoute: e.altRoute,
    maintainedBy: e.maintainedBy,
    installer: e.installer,
    serviceStatus: e.serviceStatus,
    owned: e.owned,
    installedMs: e.installedMs,
    text: e.text,
    ...provProps(e.prov),
    assetUrl: e.asset?.url ?? null,
    assetHash: e.asset?.hash ?? null,
    assetFetchedMs: e.asset?.fetchedMs ?? null,
  }));
  // An unchanged unit (same hash) is not rewritten.
  await batched(
    graph,
    `UNWIND $rows AS r
     MERGE (e:Record:Equipment {id: r.id})
     SET e.fetchedMs = r.fetchedMs, e.assetFetchedMs = r.assetFetchedMs
     WITH e, r WHERE e.hash IS NULL OR e.hash <> r.hash OR coalesce(e.assetHash, '') <> coalesce(r.assetHash, '')
     SET ${setAll("e", EQUIPMENT_KEYS)}`,
    rows,
  );
  await batched(
    graph,
    `UNWIND $rows AS r
     MATCH (e:Equipment {id: r.id}), (s:Station {id: r.station})
     MERGE (e)-[a:AT]->(s) SET a.src = 'mta-ene-equipment'`,
    rows.filter((r) => r.station),
  );
  await batched(
    graph,
    `UNWIND $rows AS r
     MATCH (e:Equipment {id: r.e}), (l:Route {id: r.route})
     MERGE (e)-[x:ON_LINE]->(l) SET x.src = 'mta-ene-equipment'`,
    list.flatMap((e) => e.lines.map((route) => ({ e: e.id, route }))),
  );
  // The real maintaining organisation from the asset inventory, replacing whatever was there before.
  await run(graph, "MATCH (:Organization)-[m:MAINTAINS]->(:Equipment) DELETE m");
  await batched(
    graph,
    `UNWIND $rows AS r
     MATCH (e:Equipment {id: r.id})
     MERGE (o:Organization {id: r.org}) ON CREATE SET o.name = r.org, o.origin = 'mta', o.dataset = '94fv-bak7'
     MERGE (o)-[m:MAINTAINS]->(e) SET m.src = '94fv-bak7', m.url = r.url`,
    list.filter((e) => e.maintainedBy).map((e) => ({ id: e.id, org: e.maintainedBy!, url: e.asset?.url ?? null })),
  );
  // The MTA's step-free alternative for each unit, as a document of its own.
  await batched(
    graph,
    `UNWIND $rows AS r
     MATCH (e:Equipment {id: r.id})
     MERGE (d:Record:AltRoute {id: r.doc})
     SET d.text = r.text, d.equipment = r.id, d.dataset = r.dataset, d.record = r.id, d.url = r.url, d.fetchedMs = r.fetchedMs, d.hash = r.hash, d.origin = 'mta'
     MERGE (d)-[f:FOR]->(e) SET f.src = r.dataset`,
    list
      .filter((e) => e.altRoute)
      .map((e) => ({ id: e.id, doc: `ALT-${e.id}`, text: e.altRoute!, dataset: e.prov.dataset, url: e.prov.url, fetchedMs: e.prov.fetchedMs, hash: e.prov.hash })),
  );
  await run(graph, "MATCH (d:AltRoute) WHERE NOT d.equipment IN $ids DETACH DELETE d", { ids: list.filter((e) => e.altRoute).map((e) => e.id) });
}

const OUTAGE_KEYS = [
  "equipment",
  "kind",
  "station",
  "stationName",
  "lines",
  "serving",
  "ada",
  "reason",
  "openedMs",
  "estReturnMs",
  "upcoming",
  "maintenance",
  "quote",
  "text",
  "status",
  "dataset",
  "record",
  "url",
  "fetchedMs",
  "hash",
  "origin",
];

/** Applies one capture of the outage feed: upserts what it lists, resolves what it dropped. */
export async function applyOutages(graph: string, current: Outage[], now: number): Promise<{ opened: number; resolved: number; reopened: number }> {
  const known = await run<{ id: string; status: string }>(graph, "MATCH (o:Outage) RETURN o.id AS id, o.status AS status", {}, { readOnly: true });
  const plan = planOutages(known.rows, current);
  await batched(
    graph,
    `UNWIND $rows AS r
     MERGE (o:Record:Outage {id: r.id})
     ON CREATE SET o.firstSeenMs = $now
     SET ${setAll("o", OUTAGE_KEYS)}, o.lastSeenMs = $now, o.resolvedMs = null`,
    plan.upsert.map((o) => ({
      id: o.id,
      equipment: o.equipment,
      kind: o.kind,
      station: o.station,
      stationName: o.stationName,
      lines: o.lines,
      serving: o.serving,
      ada: o.ada,
      reason: o.reason,
      openedMs: o.openedMs,
      estReturnMs: o.estReturnMs,
      upcoming: o.upcoming,
      maintenance: o.maintenance,
      quote: o.quote,
      text: o.text,
      status: o.status,
      ...provProps(o.prov),
    })),
    { now },
  );
  await batched(
    graph,
    `UNWIND $rows AS r
     MATCH (o:Outage {id: r.id}), (e:Equipment {id: r.equipment})
     MERGE (o)-[x:OF]->(e) SET x.src = 'mta-ene-outages'`,
    plan.opened.concat(plan.reopened).map((id) => ({ id, equipment: id.split("@")[0] })),
  );
  if (plan.resolve.length) {
    await run(
      graph,
      `UNWIND $ids AS id MATCH (o:Outage {id: id})
       SET o.status = 'resolved', o.resolvedMs = $now,
           o.text = o.text + ' Left the feed (resolved) by ' + $stamp + '.'`,
      { ids: plan.resolve, now, stamp: new Date(now).toISOString() },
    );
  }
  return { opened: plan.opened.length, resolved: plan.resolve.length, reopened: plan.reopened.length };
}

async function applyAlerts(graph: string, current: Alert[], now: number): Promise<{ started: number; ended: number }> {
  const known = await run<{ id: string; status: string }>(graph, "MATCH (a:Alert) RETURN a.id AS id, a.status AS status", {}, { readOnly: true });
  const plan = planAlerts(known.rows, current);
  const keys = ["header", "description", "type", "startMs", "endMs", "starts", "ends", "createdMs", "updatedMs", "routes", "stations", "text", "dataset", "record", "url", "fetchedMs", "hash", "origin"];
  await batched(
    graph,
    `UNWIND $rows AS r
     MERGE (a:Record:Alert {id: r.id})
     ON CREATE SET a.firstSeenMs = $now
     SET ${setAll("a", keys)}, a.status = 'active', a.lastSeenMs = $now, a.endedMs = null`,
    plan.upsert.map((a) => ({
      id: a.id,
      header: a.header,
      description: a.description,
      type: a.type,
      startMs: a.startMs,
      endMs: a.endMs,
      // Active periods as two parallel lists (graph properties cannot hold maps); 0 is an open end.
      starts: a.periods.map((p) => p.start ?? 0),
      ends: a.periods.map((p) => p.end ?? 0),
      createdMs: a.createdMs,
      updatedMs: a.updatedMs,
      routes: a.routes,
      stations: a.stations,
      text: a.text,
      ...provProps(a.prov),
    })),
    { now },
  );
  await linkPairs(graph, "Alert", "AFFECTS", "mta-subway-alerts", plan.upsert.flatMap((a) => [...a.routes.map((t) => ["Route", a.id, t]), ...a.stations.map((t) => ["Station", a.id, t])]) as Pair[]);
  if (plan.end.length) await run(graph, "UNWIND $ids AS id MATCH (a:Alert {id: id}) SET a.status = 'ended', a.endedMs = $now", { ids: plan.end, now });
  return { started: plan.started.length, ended: plan.end.length };
}

type Pair = ["Route" | "Station", string, string];

/** (from)-[type]->(Route or Station) for each pair, matched by index rather than by scanning every node. */
async function linkPairs(graph: string, from: string, type: string, src: string, pairs: Pair[]) {
  for (const label of ["Route", "Station"] as const) {
    await batched(
      graph,
      `UNWIND $rows AS r MATCH (a:${from} {id: r.a}), (n:${label} {id: r.b}) MERGE (a)-[x:${type}]->(n) SET x.src = $src`,
      pairs.filter((p) => p[0] === label).map(([, a, b]) => ({ a, b })),
      { src },
    );
  }
}

async function writeArchive(graph: string, r: AgencyRecords) {
  const noticeKeys = ["event", "update", "atMs", "status", "routes", "affected", "header", "dataset", "record", "url", "fetchedMs", "hash", "origin"];
  await batched(
    graph,
    `UNWIND $rows AS r MERGE (e:Record:AlertEvent {id: r.id})
     SET e.routes = r.routes, e.firstMs = r.firstMs, e.lastMs = r.lastMs, e.updates = r.updates, e.status = r.status,
         e.firstHeader = r.firstHeader, e.lastHeader = r.lastHeader, e.text = r.text, e.dataset = '7kct-peq7', e.origin = 'mta',
         e.record = r.record, e.url = r.url`,
    r.events.map((e) => ({ ...e, record: e.id.slice(3), url: `https://data.ny.gov/resource/7kct-peq7.json?event_id=${e.id.slice(3)}` })),
  );
  await batched(
    graph,
    `UNWIND $rows AS r MERGE (n:Notice {id: r.id}) SET ${setAll("n", noticeKeys)}
     WITH n, r MATCH (e:AlertEvent {id: r.event}) MERGE (n)-[x:UPDATE_OF]->(e) SET x.src = '7kct-peq7'`,
    r.notices.map((n) => ({ id: n.id, event: n.event, update: n.update, atMs: n.atMs, status: n.status, routes: n.routes, affected: n.affected, header: n.header, ...provProps(n.prov) })),
  );
  await linkPairs(graph, "AlertEvent", "AFFECTS", "7kct-peq7", r.events.flatMap((e) => e.routes.map((t) => ["Route", e.id, t] as Pair)));

  const complaintKeys = ["location", "station", "quarter", "count", "text", "dataset", "record", "url", "fetchedMs", "hash", "origin"];
  await batched(
    graph,
    `UNWIND $rows AS r MERGE (c:Record:Complaints {id: r.id}) SET ${setAll("c", complaintKeys)}
     WITH c, r MATCH (s:Station {id: r.station}) MERGE (c)-[x:AT]->(s) SET x.src = 'nh7m-at3e'`,
    r.complaints.map((c) => ({ id: c.id, location: c.location, station: c.station ?? "", quarter: c.quarter, count: c.count, text: c.text, ...provProps(c.prov) })),
  );

  const projectKeys = ["record", "title", "stage", "phase", "description", "routes", "stations", "contractor", "startMs", "goalMs", "estimatedMs", "goalCost", "estimatedCost", "text", "dataset", "url", "fetchedMs", "hash", "origin"];
  await batched(
    graph,
    `UNWIND $rows AS r MERGE (p:Record:Project {id: r.id}) SET ${setAll("p", projectKeys)}`,
    r.projects.map((p) => {
      const { prov, id, ...rest } = p;
      return { id, ...rest, ...provProps(prov), record: p.record };
    }),
  );
  await linkPairs(graph, "Project", "AFFECTS", "9hy6-8j6t", r.projects.flatMap((p) => [...p.routes.map((t) => ["Route", p.id, t]), ...p.stations.map((t) => ["Station", p.id, t])]) as Pair[]);
  const milestoneKeys = ["project", "phase", "sequence", "state", "title", "description", "atMs", "phaseEndMs", "text", "dataset", "record", "url", "fetchedMs", "hash", "origin"];
  await batched(
    graph,
    `UNWIND $rows AS r MERGE (m:Record:Milestone {id: r.id}) SET ${setAll("m", milestoneKeys)}
     WITH m, r MATCH (p:Project {id: r.project}) MERGE (p)-[x:HAS_MILESTONE]->(m) SET x.src = 'nswv-d6bz'`,
    r.milestones.map((m) => {
      const { prov, ...rest } = m;
      return { ...rest, ...provProps(prov) };
    }),
  );
}

async function ensureIndexes(graph: string) {
  for (const label of ["Station", "Route", "Equipment", "Outage", "Alert", "AlertEvent", "Notice", "Complaints", "Project", "Milestone", "AltRoute", "Organization"]) {
    await run(graph, `CREATE INDEX FOR (n:${label}) ON (n.id)`).catch(() => undefined);
  }
  for (const [label, field] of [
    ["Outage", "status"],
    ["Alert", "status"],
    ["Equipment", "station"],
    ["Complaints", "station"],
  ]) {
    await run(graph, `CREATE INDEX FOR (n:${label}) ON (n.${field})`).catch(() => undefined);
  }
  // Full-text search over every record's text, and over station names.
  await run(graph, "CALL db.idx.fulltext.createNodeIndex('Record', 'text')").catch(() => undefined);
  await run(graph, "CALL db.idx.fulltext.createNodeIndex('Station', 'name')").catch(() => undefined);
}

export interface RefreshResult {
  ok: boolean;
  /** "feed": fetched just now; "snapshot": the committed snapshot; "skipped": another refresh holds the lock. */
  from: "feed" | "snapshot" | "skipped";
  tier: AgencyTier | "all";
  atMs: number;
  opened: number;
  resolved: number;
  reopened: number;
  alertsStarted: number;
  alertsEnded: number;
  ms: number;
  error?: string;
}

async function logRefresh(graph: string, r: RefreshResult) {
  await run(
    graph,
    `CREATE (:Refresh {id: $id, atMs: $atMs, tier: $tier, from: $from, opened: $opened, resolved: $resolved, reopened: $reopened,
       alertsStarted: $alertsStarted, alertsEnded: $alertsEnded, ms: $ms, error: $error})`,
    { id: `REF-${r.atMs}`, atMs: r.atMs, tier: r.tier, from: r.from, opened: r.opened, resolved: r.resolved, reopened: r.reopened, alertsStarted: r.alertsStarted, alertsEnded: r.alertsEnded, ms: Math.round(r.ms), error: r.error ?? null },
  );
  // Keep the last 60 refreshes.
  await run(graph, "MATCH (x:Refresh) WITH x ORDER BY x.atMs DESC SKIP 60 DELETE x");
}

const asOfKeys: Record<DatasetId, string> = {
  "mta-ene-equipment": "equipmentMs",
  "mta-ene-outages": "outagesMs",
  "mta-ene-upcoming": "outagesMs",
  "mta-subway-alerts": "alertsMs",
  "39hk-dx4f": "archiveMs",
  "94fv-bak7": "assetsMs",
  "7kct-peq7": "noticesMs",
  "nh7m-at3e": "complaintsMs",
  "9hy6-8j6t": "projectsMs",
  "nswv-d6bz": "projectsMs",
};

async function stampMeta(graph: string, fetched: Partial<Record<DatasetId, number>>, from: "feed" | "snapshot") {
  const sets: Record<string, number> = {};
  for (const [id, ms] of Object.entries(fetched)) if (ms) sets[asOfKeys[id as DatasetId]] = Math.max(sets[asOfKeys[id as DatasetId]] ?? 0, ms);
  await run(
    graph,
    `MERGE (m:AgencyMeta {id: 'meta'}) SET m.version = $version, m.from = $from, m.refreshedMs = $now ${Object.keys(sets)
      .map((k) => `, m.${k} = $${k}`)
      .join("")}`,
    { version: AGENCY_VERSION, from, now: Date.now(), ...sets },
  );
}

/** Builds the agency graph from records: the network, the units, every outage capture in order, alerts and archives. */
async function writeAll(graph: string, records: AgencyRecords, fetched: Partial<Record<DatasetId, number>>, from: "feed" | "snapshot"): Promise<RefreshResult> {
  const started = performance.now();
  await writeNetwork(graph);
  await ensureIndexes(graph);
  await writeEquipment(graph, records.equipment);
  let opened = 0;
  let resolved = 0;
  let reopened = 0;
  for (const c of records.outageCaptures) {
    const r = await applyOutages(graph, c.outages, c.fetchedMs);
    opened += r.opened;
    resolved += r.resolved;
    reopened += r.reopened;
  }
  const a = await applyAlerts(graph, records.alerts, records.alertsFetchedMs);
  await writeArchive(graph, records);
  await stampMeta(graph, fetched, from);
  const result: RefreshResult = { ok: true, from, tier: "all", atMs: Date.now(), opened, resolved, reopened, alertsStarted: a.started, alertsEnded: a.ended, ms: performance.now() - started };
  await logRefresh(graph, result);
  return result;
}

/** Installs the agency graph from the committed snapshot (used when the graph is missing or its model changed). */
export async function installFromSnapshot(graph = AGENCY_GRAPH): Promise<RefreshResult> {
  let snap: AgencySnapshot;
  let from: "snapshot" | "feed" = "snapshot";
  try {
    snap = await loadSnapshot();
  } catch {
    // No snapshot on this server: build from the feeds themselves.
    snap = await snapshotFromFeeds();
    from = "feed";
  }
  if (await graphExists(graph)) await deleteGraph(graph);
  return writeAll(graph, await parseAgency(snap), snap.fetched, from);
}

const EMPTY: AgencySnapshot = {
  version: 1,
  fetched: {},
  equipment: [],
  outageCaptures: [],
  upcoming: [],
  alerts: { fetchedMs: 0, feedMs: null, alerts: [] },
  stops: {},
  assets: [],
  notices: [],
  complaints: [],
  projects: [],
  milestones: [],
};

async function snapshotFromFeeds(): Promise<AgencySnapshot> {
  const [live, archive] = await Promise.all([fetchLive(), fetchArchive()]);
  const fetched: AgencySnapshot["fetched"] = {};
  for (const id of ["mta-ene-equipment", "mta-ene-outages", "mta-ene-upcoming", "mta-subway-alerts"] as const) fetched[id] = live.fetchedMs;
  for (const id of ["39hk-dx4f", "94fv-bak7", "7kct-peq7", "nh7m-at3e", "9hy6-8j6t", "nswv-d6bz"] as const) fetched[id] = archive.fetchedMs;
  return {
    version: 1,
    fetched,
    equipment: live.equipment,
    outageCaptures: [{ fetchedMs: live.fetchedMs, outages: live.outages }],
    upcoming: live.upcoming,
    alerts: { fetchedMs: live.fetchedMs, ...live.alerts },
    stops: archive.stops,
    assets: archive.assets,
    notices: archive.notices,
    complaints: archive.complaints,
    projects: archive.projects,
    milestones: archive.milestones,
  };
}

let ready: Promise<void> | null = null;

/** Makes sure the shared agency graph exists at the current version; the first caller installs it from the snapshot. */
export function ensureAgency(graph = AGENCY_GRAPH): Promise<void> {
  if (graph !== AGENCY_GRAPH) return install(graph);
  ready ??= install(graph).catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

async function install(graph: string): Promise<void> {
  if (await graphExists(graph)) {
    const have = await run<{ v: number }>(graph, "MATCH (m:AgencyMeta {id: 'meta'}) RETURN m.version AS v", {}, { readOnly: true }).catch(() => ({ rows: [] as { v: number }[] }));
    if (have.rows[0]?.v === AGENCY_VERSION) return;
  }
  const owner = `install-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (!(await takeLock(`agency:${graph}`, owner, LOCK_MS))) {
    // Another instance is installing it; wait for it rather than writing twice.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      const have = await run<{ v: number }>(graph, "MATCH (m:AgencyMeta {id: 'meta'}) RETURN m.version AS v", {}, { readOnly: true }).catch(() => ({ rows: [] as { v: number }[] }));
      if (have.rows[0]?.v === AGENCY_VERSION) return;
    }
    throw new Error("The agency graph is still being installed. Try again in a minute.");
  }
  try {
    await installFromSnapshot(graph);
  } finally {
    await releaseLock(`agency:${graph}`, owner).catch(() => undefined);
  }
}

/**
 * Refreshes the agency graph from the feeds. "live": the four MTA feeds (outages, units, alerts); "all": also the
 * data.ny.gov archives. Idempotent: unchanged records are left alone, outages that left the feed are resolved.
 * When a feed cannot be reached, nothing is changed and the error is returned.
 */
export async function refreshAgency(tier: AgencyTier | "all" = "live", graph = AGENCY_GRAPH): Promise<RefreshResult> {
  const started = performance.now();
  const empty = { opened: 0, resolved: 0, reopened: 0, alertsStarted: 0, alertsEnded: 0 };
  await ensureAgency(graph);
  const owner = `refresh-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (!(await takeLock(`agency:${graph}`, owner, LOCK_MS))) {
    return { ok: true, from: "skipped", tier, atMs: Date.now(), ...empty, ms: performance.now() - started };
  }
  try {
    let live;
    let archive = null;
    try {
      live = await fetchLive();
      // Without a snapshot on this server the archives come from the feeds too.
      if (tier === "all" || !(await loadSnapshot().catch(() => null))) archive = await fetchArchive();
    } catch (error) {
      const result: RefreshResult = { ok: false, from: "feed", tier, atMs: Date.now(), ...empty, ms: performance.now() - started, error: error instanceof Error ? error.message : String(error) };
      await logRefresh(graph, result).catch(() => undefined);
      return result;
    }
    const snap = (await loadSnapshot().catch(() => null)) ?? EMPTY;
    const merged: AgencySnapshot = {
      ...snap,
      fetched: { ...snap.fetched },
      equipment: live.equipment,
      outageCaptures: [{ fetchedMs: live.fetchedMs, outages: live.outages }],
      upcoming: live.upcoming,
      alerts: { fetchedMs: live.fetchedMs, ...live.alerts },
      ...(archive ? { stops: archive.stops, assets: archive.assets, notices: archive.notices, complaints: archive.complaints, projects: archive.projects, milestones: archive.milestones } : {}),
    };
    for (const id of ["mta-ene-equipment", "mta-ene-outages", "mta-ene-upcoming", "mta-subway-alerts"] as const) merged.fetched[id] = live.fetchedMs;
    if (archive) for (const id of ["39hk-dx4f", "94fv-bak7", "7kct-peq7", "nh7m-at3e", "9hy6-8j6t", "nswv-d6bz"] as const) merged.fetched[id] = archive.fetchedMs;
    const records = await parseAgency(merged);

    // The units keep the inventory fields they already have when the archive was not fetched this time.
    await writeEquipment(graph, records.equipment);
    const o = await applyOutages(graph, records.outageCaptures[0].outages, live.fetchedMs);
    const a = await applyAlerts(graph, records.alerts, live.fetchedMs);
    if (archive) await writeArchive(graph, records);
    await stampMeta(graph, archive ? merged.fetched : { "mta-ene-equipment": live.fetchedMs, "mta-ene-outages": live.fetchedMs, "mta-subway-alerts": live.fetchedMs }, "feed");
    const result: RefreshResult = {
      ok: true,
      from: "feed",
      tier,
      atMs: Date.now(),
      opened: o.opened,
      resolved: o.resolved,
      reopened: o.reopened,
      alertsStarted: a.started,
      alertsEnded: a.ended,
      ms: performance.now() - started,
    };
    await logRefresh(graph, result);
    return result;
  } finally {
    await releaseLock(`agency:${graph}`, owner).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- reading

export interface AgencyStatus {
  /** When each source was last read, as stored on the graph. */
  asOf: { outagesMs: number | null; alertsMs: number | null; equipmentMs: number | null; assetsMs: number | null; noticesMs: number | null; complaintsMs: number | null; projectsMs: number | null };
  from: "feed" | "snapshot" | null;
  counts: { equipment: number; outagesOpen: number; outagesPlanned: number; outagesResolved: number; alerts: number; notices: number; complaints: number; projects: number };
  lastRefresh: { atMs: number; from: string; ok: boolean; opened: number; resolved: number; error: string | null } | null;
  sources: { id: DatasetId; name: string; page: string }[];
}

export async function agencyStatus(graph = AGENCY_GRAPH): Promise<AgencyStatus> {
  const meta = await run<Record<string, number | string | null>>(
    graph,
    `MATCH (m:AgencyMeta {id: 'meta'})
     RETURN m.outagesMs AS outagesMs, m.alertsMs AS alertsMs, m.equipmentMs AS equipmentMs, m.assetsMs AS assetsMs,
            m.noticesMs AS noticesMs, m.complaintsMs AS complaintsMs, m.projectsMs AS projectsMs, m.from AS from`,
    {},
    { readOnly: true },
  );
  const counts = await run<{ label: string; status: string | null; n: number }>(
    graph,
    `MATCH (n) WHERE n:Equipment OR n:Outage OR n:Alert OR n:Notice OR n:Complaints OR n:Project
     RETURN CASE WHEN n:Equipment THEN 'Equipment' WHEN n:Outage THEN 'Outage' WHEN n:Alert THEN 'Alert' WHEN n:Notice THEN 'Notice'
                 WHEN n:Complaints THEN 'Complaints' ELSE 'Project' END AS label, CASE WHEN n:Outage OR n:Alert THEN n.status ELSE null END AS status, count(n) AS n`,
    {},
    { readOnly: true },
  );
  const last = await run<{ atMs: number; from: string; error: string | null; opened: number; resolved: number }>(
    graph,
    "MATCH (r:Refresh) RETURN r.atMs AS atMs, r.from AS from, r.error AS error, r.opened AS opened, r.resolved AS resolved ORDER BY atMs DESC LIMIT 1",
    {},
    { readOnly: true },
  );
  const m = meta.rows[0] ?? {};
  const n = (label: string, status?: string) => counts.rows.filter((r) => r.label === label && (status === undefined || r.status === status)).reduce((s, r) => s + r.n, 0);
  const ms = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : null);
  const l = last.rows[0];
  return {
    asOf: { outagesMs: ms("outagesMs"), alertsMs: ms("alertsMs"), equipmentMs: ms("equipmentMs"), assetsMs: ms("assetsMs"), noticesMs: ms("noticesMs"), complaintsMs: ms("complaintsMs"), projectsMs: ms("projectsMs") },
    from: (m.from as AgencyStatus["from"]) ?? null,
    counts: {
      equipment: n("Equipment"),
      outagesOpen: n("Outage", "open"),
      outagesPlanned: n("Outage", "upcoming"),
      outagesResolved: n("Outage", "resolved"),
      alerts: n("Alert", "active"),
      notices: n("Notice"),
      complaints: n("Complaints"),
      projects: n("Project"),
    },
    lastRefresh: l ? { atMs: l.atMs, from: l.from, ok: !l.error, opened: l.opened ?? 0, resolved: l.resolved ?? 0, error: l.error ?? null } : null,
    sources: Object.values(DATASETS).map((d) => ({ id: d.id, name: d.name, page: d.page })),
  };
}

/** One unit out of service now, for step-free routing. */
export interface StepFreeOutage {
  /** Station complex id (Detour's Station id). */
  station: string;
  /** Detour route ids the unit serves. */
  lines: string[];
  equipment: string;
  kind: "elevator" | "escalator";
  /** The unit is on an ADA-accessible path. */
  ada: boolean;
  serving: string;
  reason: string;
  /** When it went out, and the MTA's estimated return (ms since epoch; null when not given). */
  since: number | null;
  until: number | null;
  /** When the feed last listed it. */
  asOfMs: number;
}

type OutageRow = Omit<StepFreeOutage, "asOfMs"> & { asOfMs: number | null; status: string };

const fromParsed = (o: Outage, asOfMs: number): StepFreeOutage | null =>
  o.station ? { station: o.station, lines: o.lines, equipment: o.equipment, kind: o.kind, ada: o.ada, serving: o.serving, reason: o.reason, since: o.openedMs, until: o.estReturnMs, asOfMs } : null;

/**
 * Elevators and escalators out of service now, from the shared agency graph: every outage the feed lists as
 * current, plus planned outages whose window has started. Falls back to the committed snapshot when the graph
 * cannot be read. Escalators are included; filter on `kind` and `ada` for step-free routing.
 */
export async function currentOutages(opts: { now?: number; graph?: string } = {}): Promise<StepFreeOutage[]> {
  const now = opts.now ?? Date.now();
  const live = (o: { status: string; since: number | null; until: number | null }) =>
    o.status === "open" || (o.status === "upcoming" && o.since !== null && o.since <= now && (o.until === null || o.until > now));
  try {
    await ensureAgency(opts.graph ?? AGENCY_GRAPH);
    const res = await run<OutageRow>(
      opts.graph ?? AGENCY_GRAPH,
      `MATCH (o:Outage) WHERE o.status IN ['open', 'upcoming'] AND o.station IS NOT NULL
       RETURN o.station AS station, o.lines AS lines, o.equipment AS equipment, o.kind AS kind, o.ada AS ada, o.serving AS serving,
              o.reason AS reason, o.openedMs AS since, o.estReturnMs AS until, o.lastSeenMs AS asOfMs, o.status AS status`,
      {},
      { readOnly: true, timeoutMs: 5_000 },
    );
    return res.rows.filter(live).map((o) => ({
      station: o.station,
      lines: o.lines ?? [],
      equipment: o.equipment,
      kind: o.kind,
      ada: o.ada,
      serving: o.serving,
      reason: o.reason,
      since: o.since,
      until: o.until,
      asOfMs: o.asOfMs ?? now,
    }));
  } catch {
    const records = await parseAgency(await loadSnapshot());
    const last = records.outageCaptures[records.outageCaptures.length - 1];
    if (!last) return [];
    return last.outages
      .filter((o) => live({ status: o.upcoming ? "upcoming" : "open", since: o.openedMs, until: o.estReturnMs }))
      .map((o) => fromParsed(o, last.fetchedMs))
      .filter((o): o is StepFreeOutage => Boolean(o));
  }
}
