import type { BrainSource, SourceKind } from "../brain/types";
import { loadNetwork } from "../network/data";
import { COMPLAINTS_SINCE, DATASETS, nyStamp, nyTime, parseSodaDate, quarterOf, type DatasetId } from "./agency-feeds";
import { extractMentions } from "./intake";
import { AGENCY_GRAPH } from "./names";
import { ORG_PEOPLE, ORG_TEAMS } from "./seed-org";
import { routesIn, searchTerms } from "./tools/brain";
import { result, type ToolContext, type ToolResult } from "./tools/types";

/**
 * The brain's tools over the shared agency graph of real MTA records. Each returns its facts and the records
 * behind them as sources with receipts: the record's own words, its dataset and URL, and when it was fetched.
 * `latestOnly` answers from the newest feed state alone (no resolved outages, ended alerts, alert history or
 * complaint counts); the evaluation uses it to measure what the graph's history adds.
 */

export interface AgencyOptions {
  graph?: string;
  latestOnly?: boolean;
  now?: number;
}

type Props = Record<string, unknown>;
type GNode = { id: number; labels: string[]; properties: Props };

const g = (opts: AgencyOptions) => opts.graph ?? AGENCY_GRAPH;
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));
const numOr = (v: unknown) => (typeof v === "number" ? v : null);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- sources with receipts

const KIND: Record<string, SourceKind> = {
  Equipment: "equipment",
  Outage: "outage",
  Alert: "alert",
  AlertEvent: "notice",
  Notice: "notice",
  Complaints: "complaints",
  Project: "project",
  Milestone: "milestone",
  AltRoute: "alternative",
};

const labelOf = (n: GNode) => n.labels.find((l) => l !== "Record") ?? n.labels[0];
const deviceWord = (kind: unknown) => (kind === "escalator" ? "Escalator" : "Elevator");

function receipt(p: Props, quote: string, dataset?: DatasetId, url?: string | null) {
  const ds = (dataset ?? (str(p.dataset) as DatasetId)) || "mta-ene-equipment";
  return {
    dataset: ds,
    source: DATASETS[ds]?.name ?? ds,
    url: url ?? str(p.url) ?? DATASETS[ds]?.page ?? "",
    fetchedMs: numOr(dataset === "94fv-bak7" ? p.assetFetchedMs : p.fetchedMs),
    quote,
    hash: str(dataset === "94fv-bak7" ? p.assetHash : p.hash),
  };
}

/** A record of the agency graph as a citable source. */
function toAgencySource(n: GNode): BrainSource {
  const p = n.properties;
  const label = labelOf(n);
  const kind = KIND[label] ?? "document";
  const lines = list(p.lines ?? p.routes);
  const station = str(p.stationName);
  const about = [...(station ? [station] : []), ...lines];
  const base = { kind, id: String(p.id), by: "MTA", team: null, about, origin: "mta" as const };
  switch (label) {
    case "Equipment":
      return {
        ...base,
        title: `${deviceWord(p.kind)} ${p.id} at ${station}${p.short ? `: ${p.short}` : ""}`,
        atMs: numOr(p.fetchedMs),
        status: p.active === false ? "inactive" : null,
        snippet: null,
        receipt: receipt(p, `serving: ${p.serving ?? ""}; ADA: ${p.ada ? "Y" : "N"}; lines: ${lines.join("/")}${p.nextAdaNorth ? `; nextadanorth: ${p.nextAdaNorth}` : ""}${p.nextAdaSouth ? `; nextadasouth: ${p.nextAdaSouth}` : ""}`),
      };
    case "Outage": {
      const planned = p.status === "upcoming";
      return {
        ...base,
        title: `${deviceWord(p.kind)} ${p.equipment} at ${station}: ${planned ? "planned outage" : p.status === "resolved" ? "outage, resolved" : "out of service"}`,
        atMs: numOr(p.openedMs),
        status: str(p.status),
        snippet: `Reason: ${p.reason}. ${p.estReturnMs ? `Estimated return ${nyStamp(p.estReturnMs as number)}.` : "No estimated return given."}${p.resolvedMs ? ` Left the feed by ${nyStamp(p.resolvedMs as number)}.` : ""}`,
        receipt: receipt(p, String(p.quote ?? p.text ?? "")),
      };
    }
    case "AltRoute":
      return {
        ...base,
        about: [],
        title: `MTA alternative route when ${p.equipment} is out`,
        atMs: numOr(p.fetchedMs),
        status: null,
        snippet: null,
        receipt: receipt(p, String(p.text ?? "")),
      };
    case "Alert":
      return {
        ...base,
        title: clip(String(p.header ?? ""), 160),
        atMs: numOr(p.startMs) ?? numOr(p.createdMs),
        status: str(p.status),
        snippet: p.description ? clip(String(p.description), 240) : null,
        receipt: receipt(p, `${p.header}${p.description ? ` | ${p.description}` : ""}`),
      };
    case "AlertEvent":
      return {
        ...base,
        title: clip(String(p.lastHeader ?? ""), 160),
        atMs: numOr(p.lastMs),
        status: `${plural(Number(p.updates) || 0, "update")}`,
        snippet: p.firstHeader && p.firstHeader !== p.lastHeader ? `First update: ${clip(String(p.firstHeader), 200)}` : null,
        receipt: receipt(p, String(p.lastHeader ?? ""), "7kct-peq7"),
      };
    case "Notice":
      return {
        ...base,
        title: clip(String(p.header ?? ""), 160),
        atMs: numOr(p.atMs),
        status: str(p.status),
        snippet: `Update ${p.update} of event ${String(p.event ?? "").replace(/^EV-/, "")}`,
        receipt: receipt(p, String(p.header ?? "")),
      };
    case "Complaints":
      return {
        ...base,
        about: [],
        title: String(p.text ?? ""),
        atMs: null,
        status: str(p.quarter),
        snippet: null,
        receipt: receipt(p, `location_name: ${p.location}; subcategory: Elevator / escalator outage; ${p.quarter}: ${p.count}`),
      };
    case "Project":
      return {
        ...base,
        title: `Capital project ${p.record}: ${p.title}`,
        atMs: numOr(p.startMs),
        status: str(p.stage),
        snippet: p.description ? clip(String(p.description), 240) : null,
        receipt: receipt(p, `title: ${p.title}; stage: ${p.stage ?? ""}; phase: ${p.phase ?? ""}`),
      };
    case "Milestone":
      return {
        ...base,
        about: [],
        title: `${p.phase ?? "Phase"}${p.title ? `: ${p.title}` : ""}`,
        atMs: numOr(p.atMs) ?? numOr(p.phaseEndMs),
        status: str(p.state),
        snippet: p.description ? clip(String(p.description), 240) : null,
        receipt: receipt(p, String(p.text ?? "")),
      };
    default:
      return { ...base, title: String(p.text ?? p.id), atMs: null, status: null, snippet: null, receipt: receipt(p, String(p.text ?? "")) };
  }
}

/** The asset inventory's line for a unit (maintainer, installer, status), cited as its own source. */
function assetSource(e: GNode): BrainSource | null {
  const p = e.properties;
  if (!p.maintainedBy) return null;
  return {
    kind: "asset",
    id: `ASSET-${p.id}`,
    title: `Asset inventory: ${p.id} is maintained by ${p.maintainedBy}`,
    by: "MTA",
    team: null,
    atMs: numOr(p.assetFetchedMs),
    status: str(p.serviceStatus),
    snippet: [p.installer ? `Installed by ${p.installer}` : null, p.installedMs ? `in service since ${nyStamp(p.installedMs as number).slice(0, 10)}` : null].filter(Boolean).join(", ") || null,
    about: [str(p.stationName) ?? ""].filter(Boolean),
    origin: "mta",
    receipt: receipt(
      p,
      `equipment_code: ${p.id}; maintained_by: ${p.maintainedBy}${p.installer ? `; installer: ${p.installer}` : ""}${p.serviceStatus ? `; service_status: ${p.serviceStatus}` : ""}${p.owned ? `; nyct_owned: ${p.owned}` : ""}`,
      "94fv-bak7",
      str(p.assetUrl),
    ),
  };
}

// ---------------------------------------------------------------- resolving names

const UNIT_ID = /\b(E[LS]\d{2,4}[A-Z]?)\b/gi;

export function unitIds(text: string): string[] {
  return [...new Set([...text.matchAll(UNIT_ID)].map((m) => m[1].toUpperCase()))];
}

/** Stations and lines a question names, by the network's own names (longest match wins). */
async function placesIn(text: string): Promise<{ stations: { id: string; name: string; routes: string[] }[]; routes: string[] }> {
  const network = await loadNetwork();
  const routeIds = network.routes.map((r) => r.id);
  const refs = network.stations.map((s) => ({ id: s.id, name: s.name, routes: s.routes }));
  const m = extractMentions(text, refs, routeIds, []);
  const routes = [...new Set([...m.routes, ...routesIn(text, routeIds)])];
  // A station's full name written out wins over the looser variants ("Franklin Av" is also part of "Franklin Av-Medgar Evers College").
  const lower = ` ${text.toLowerCase().replace(/[‐-―]/g, "-")} `;
  const named = refs.filter((s) => new RegExp(`[^a-z0-9]${s.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z0-9]`).test(lower));
  if (named.length) {
    const longest = Math.max(...named.map((s) => s.name.length));
    const top = named.filter((s) => s.name.length === longest);
    const onLine = routes.length ? top.filter((s) => s.routes.some((r) => routes.includes(r))) : [];
    const pick = top.length === 1 ? top[0] : onLine.length === 1 ? onLine[0] : null;
    if (pick) return { stations: [pick, ...m.stations.filter((s) => s.id !== pick.id)], routes };
  }
  return { stations: m.stations, routes };
}

const kindIn = (text: string): "elevator" | "escalator" | null => {
  const el = /\belevators?\b/i.test(text);
  const es = /\bescalators?\b/i.test(text);
  return el && !es ? "elevator" : es && !el ? "escalator" : null;
};

// ---------------------------------------------------------------- equipment_status

export interface UnitFacts {
  id: string;
  kind: string;
  station: string | null;
  stationName: string;
  lines: string[];
  serving: string;
  ada: boolean;
  /** "out of service" when the feed lists a current outage; planned outages leave it "in service". */
  state: "out of service" | "in service";
  current: { id: string; reason: string; sinceMs: number | null; estReturnMs: number | null } | null;
  planned: { id: string; reason: string; sinceMs: number | null; estReturnMs: number | null }[];
  resolved: { id: string; reason: string; sinceMs: number | null; resolvedMs: number | null }[];
  maintainedBy: string | null;
  installer: string | null;
  inventoryStatus: string | null;
  altRoute: string | null;
  nextAda: { north: string | null; south: string | null };
  /** Person-level assignment of a real outage to the sample maintenance team; sample data, labeled as such. */
  sampleAssignee: { name: string; role: string; team: string } | null;
}

export interface EquipmentData {
  asked: string[];
  unknown: string[];
  station: { id: string; name: string } | null;
  units: UnitFacts[];
  sources: BrainSource[];
}

const EE = ORG_TEAMS.find((t) => t.id === "EE")!;
const EE_PEOPLE = ORG_PEOPLE.filter((p) => p.team === "EE");

/** Which sample person "holds" a real outage: a fixed pick by the outage id, labeled sample wherever it shows. */
export function sampleAssignee(outageId: string): { name: string; role: string; team: string } {
  let h = 0;
  for (const c of outageId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const p = EE_PEOPLE[h % EE_PEOPLE.length];
  return { name: p.name, role: p.role, team: EE.name };
}

/** Units by id, or the units at a station: in service or not, the outage and its estimated return, who maintains it, the MTA's alternative. */
export async function equipmentStatus(ctx: ToolContext, input: { query: string }, opts: AgencyOptions = {}): Promise<ToolResult<EquipmentData>> {
  const graph = g(opts);
  const asked = unitIds(input.query);
  let station: EquipmentData["station"] = null;
  let units: GNode[] = [];
  if (asked.length) {
    const res = await ctx.tracer.run<{ e: GNode }>("the units asked about", graph, "MATCH (e:Equipment) WHERE e.id IN $ids RETURN e", { ids: asked }, { readOnly: true });
    units = res.rows.map((r) => r.e);
  } else {
    const places = await placesIn(input.query);
    const s = places.stations[0];
    if (!s) {
      return result(ctx, "equipment_status", "unknown_entity", "The question names no elevator, escalator or station the graph knows.", { asked, unknown: [], station: null, units: [], sources: [] });
    }
    station = { id: s.id, name: s.name };
    const kind = kindIn(input.query);
    const res = await ctx.tracer.run<{ e: GNode; id: string }>(
      "the elevators and escalators at the station",
      graph,
      `MATCH (e:Equipment {station: $station}) WHERE $kind = '' OR e.kind = $kind
       RETURN e, e.id AS id ORDER BY id LIMIT 80`,
      { station: s.id, kind: kind ?? "" },
      { readOnly: true },
    );
    units = res.rows.map((r) => r.e);
    // A line named in the question narrows the station's units to the ones serving it.
    const onLine = places.routes.length ? units.filter((u) => list(u.properties.lines).some((l) => places.routes.includes(l))) : [];
    if (onLine.length) units = onLine;
  }
  const found = new Set(units.map((u) => String(u.properties.id)));
  const unknown = asked.filter((id) => !found.has(id));
  if (!units.length) {
    return result(
      ctx,
      "equipment_status",
      asked.length ? "unknown_entity" : "not_in_graph",
      asked.length ? `No elevator or escalator ${unknown.join(", ")} in the MTA's equipment list.` : `The MTA lists no ${kindIn(input.query) ?? "elevator or escalator"} at ${station?.name}.`,
      { asked, unknown, station, units: [], sources: [] },
    );
  }
  const ids = [...found];
  const outages = await ctx.tracer.run<{ o: GNode; t: number | null }>(
    opts.latestOnly ? "their outages in the newest feed" : "their outages, current, planned and resolved",
    graph,
    `MATCH (o:Outage) WHERE o.equipment IN $ids AND ($history OR o.status <> 'resolved')
     RETURN o, o.openedMs AS t ORDER BY t DESC`,
    { ids, history: !opts.latestOnly },
    { readOnly: true },
  );
  const alts = await ctx.tracer.run<{ d: GNode }>(
    "the MTA's alternative routes for them",
    graph,
    "MATCH (d:AltRoute)-[:FOR]->(e:Equipment) WHERE e.id IN $ids RETURN d",
    { ids },
    { readOnly: true },
  );
  const altBy = new Map(alts.rows.map((r) => [String(r.d.properties.equipment), r.d]));
  const byUnit = new Map<string, GNode[]>();
  for (const r of outages.rows) {
    const k = String(r.o.properties.equipment);
    byUnit.set(k, [...(byUnit.get(k) ?? []), r.o]);
  }
  const brief = (o: GNode) => ({ id: String(o.properties.id), reason: String(o.properties.reason ?? ""), sinceMs: numOr(o.properties.openedMs), estReturnMs: numOr(o.properties.estReturnMs) });
  const facts: UnitFacts[] = units.map((u) => {
    const p = u.properties;
    const os = byUnit.get(String(p.id)) ?? [];
    const current = os.find((o) => o.properties.status === "open") ?? null;
    return {
      id: String(p.id),
      kind: String(p.kind),
      station: str(p.station),
      stationName: String(p.stationName ?? ""),
      lines: list(p.lines),
      serving: String(p.serving ?? ""),
      ada: Boolean(p.ada),
      state: current ? "out of service" : "in service",
      current: current ? brief(current) : null,
      planned: os.filter((o) => o.properties.status === "upcoming").map(brief),
      resolved: os.filter((o) => o.properties.status === "resolved").map((o) => ({ ...brief(o), resolvedMs: numOr(o.properties.resolvedMs) })),
      maintainedBy: str(p.maintainedBy),
      installer: str(p.installer),
      inventoryStatus: str(p.serviceStatus),
      altRoute: str(altBy.get(String(p.id))?.properties.text),
      nextAda: { north: str(p.nextAdaNorth), south: str(p.nextAdaSouth) },
      sampleAssignee: current ? sampleAssignee(String(current.properties.id)) : null,
    };
  });
  const sources: BrainSource[] = [];
  for (const u of units) {
    const id = String(u.properties.id);
    for (const o of (byUnit.get(id) ?? []).slice(0, 3)) sources.push(toAgencySource(o));
    sources.push(toAgencySource(u));
    const asset = assetSource(u);
    if (asset) sources.push(asset);
    const alt = altBy.get(id);
    if (alt) sources.push(toAgencySource(alt));
  }
  const out = facts.filter((f) => f.state === "out of service");
  const summary = asked.length
    ? facts
        .map((f) =>
          f.current
            ? `${f.id} at ${f.stationName} is out of service (${f.current.reason}) since ${f.current.sinceMs ? nyStamp(f.current.sinceMs) : "an unknown time"}, estimated back ${f.current.estReturnMs ? nyStamp(f.current.estReturnMs) : "at no given time"}.`
            : `${f.id} at ${f.stationName} is in service${f.planned.length ? `, with a planned outage from ${f.planned[0].sinceMs ? nyStamp(f.planned[0].sinceMs) : "a time not given"}` : ""}.`,
        )
        .join(" ") + (unknown.length ? ` No unit ${unknown.join(", ")} in the MTA's list.` : "")
    : `${station?.name}: ${plural(facts.length, "unit")}, ${out.length} out of service${out.length ? ` (${out.map((f) => f.id).join(", ")})` : ""}.`;
  return result(ctx, "equipment_status", "answered", summary, { asked, unknown, station, units: facts, sources: sources.slice(0, 12) });
}

// ---------------------------------------------------------------- line_outages

export interface LineOutagesData {
  route: string | null;
  kind: "elevator" | "escalator" | null;
  stations: { id: string | null; name: string; units: { id: string; kind: string; reason: string; estReturnMs: number | null }[] }[];
  sources: BrainSource[];
}

/** Stations on a line with an elevator or escalator out of service now. */
export async function lineOutages(ctx: ToolContext, input: { query: string }, opts: AgencyOptions = {}): Promise<ToolResult<LineOutagesData>> {
  const { routes } = await placesIn(input.query);
  const route = routes[0] ?? null;
  const kind = kindIn(input.query);
  if (!route) return result(ctx, "line_outages", "unknown_entity", "The question names no subway line.", { route, kind, stations: [], sources: [] });
  const res = await ctx.tracer.run<{ o: GNode; station: string }>(
    `${kind ?? "elevator and escalator"} outages on the ${route} now`,
    g(opts),
    `MATCH (o:Outage {status: 'open'}) WHERE $route IN o.lines AND ($kind = '' OR o.kind = $kind)
     RETURN o, o.stationName AS station ORDER BY station`,
    { route, kind: kind ?? "" },
    { readOnly: true },
  );
  const byStation = new Map<string, LineOutagesData["stations"][number]>();
  for (const { o } of res.rows) {
    const p = o.properties;
    const key = String(p.station ?? p.stationName);
    const entry = byStation.get(key) ?? { id: str(p.station), name: String(p.stationName), units: [] };
    entry.units.push({ id: String(p.equipment), kind: String(p.kind), reason: String(p.reason), estReturnMs: numOr(p.estReturnMs) });
    byStation.set(key, entry);
  }
  const stations = [...byStation.values()];
  const sources = res.rows.slice(0, 10).map((r) => toAgencySource(r.o));
  if (!stations.length) {
    return result(ctx, "line_outages", "answered", `No ${kind ?? "elevator or escalator"} on the ${route} is out of service in the latest feed.`, { route, kind, stations, sources });
  }
  return result(
    ctx,
    "line_outages",
    "answered",
    `${plural(stations.length, "station")} on the ${route} with a ${kind ?? "unit"} out of service: ${stations.map((s) => `${s.name} (${s.units.map((u) => u.id).join(", ")})`).join("; ")}.`,
    { route, kind, stations, sources },
  );
}

// ---------------------------------------------------------------- alerts

export const ALERT_ID = /\b(lmm:[a-z_]+:\d+(?::\d+)?)\b/i;

export interface AlertsData {
  asked: string | null;
  routes: string[];
  stations: { id: string; name: string }[];
  /** Each alert's stations carry the units out of service there now: alert, station, unit, outage in one walk. */
  alerts: { id: string; header: string; status: string; routes: string[]; stations: { id: string; name: string; out: string[] }[]; startMs: number | null; endMs: number | null }[];
  sources: BrainSource[];
}

/** One alert by id, or the alerts affecting a line or station now: its text, lines, stations and active period. */
export async function alertsFor(ctx: ToolContext, input: { query: string }, opts: AgencyOptions = {}): Promise<ToolResult<AlertsData>> {
  const graph = g(opts);
  const asked = input.query.match(ALERT_ID)?.[1].toLowerCase() ?? null;
  const network = await loadNetwork();
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  let rows: GNode[];
  let routes: string[] = [];
  let stations: { id: string; name: string }[] = [];
  if (asked) {
    const res = await ctx.tracer.run<{ a: GNode }>(
      "the alert asked about",
      graph,
      "MATCH (a:Alert {id: $id}) WHERE $history OR a.status = 'active' RETURN a",
      { id: asked, history: !opts.latestOnly },
      { readOnly: true },
    );
    rows = res.rows.map((r) => r.a);
  } else {
    const places = await placesIn(input.query);
    routes = places.routes;
    stations = places.stations.map((s) => ({ id: s.id, name: s.name }));
    if (!routes.length && !stations.length) {
      return result(ctx, "alerts_for", "unknown_entity", "The question names no alert, line or station.", { asked, routes, stations, alerts: [], sources: [] });
    }
    const res = await ctx.tracer.run<{ a: GNode; t: number | null }>(
      "alerts affecting it now",
      graph,
      `MATCH (a:Alert {status: 'active'})-[:AFFECTS]->(n)
       WHERE (n:Route AND n.id IN $routes) OR (n:Station AND n.id IN $stations)
       WITH DISTINCT a
       RETURN a, coalesce(a.startMs, a.createdMs) AS t ORDER BY t DESC LIMIT 12`,
      { routes, stations: stations.map((s) => s.id) },
      { readOnly: true },
    );
    rows = res.rows.map((r) => r.a);
  }
  const outAt = new Map<string, string[]>();
  if (asked && rows.length) {
    const res = await ctx.tracer.run<{ station: string; units: string[] }>(
      "units out of service at the alert's stations",
      graph,
      `MATCH (a:Alert {id: $id})-[:AFFECTS]->(s:Station)<-[:AT]-(e:Equipment)<-[:OF]-(o:Outage {status: 'open'})
       RETURN s.id AS station, collect(DISTINCT e.id) AS units`,
      { id: asked },
      { readOnly: true },
    );
    for (const r of res.rows) outAt.set(r.station, r.units);
  }
  const alerts = rows.map((a) => {
    const p = a.properties;
    return {
      id: String(p.id),
      header: String(p.header ?? ""),
      status: String(p.status ?? ""),
      routes: list(p.routes),
      stations: list(p.stations).map((id) => ({ id, name: names.get(id) ?? id, out: outAt.get(id) ?? [] })),
      startMs: numOr(p.startMs),
      endMs: numOr(p.endMs),
    };
  });
  const data: AlertsData = { asked, routes, stations, alerts, sources: rows.map(toAgencySource) };
  if (!alerts.length) {
    return result(
      ctx,
      "alerts_for",
      asked ? "unknown_entity" : "answered",
      asked ? `No alert ${asked} in the MTA's alerts feed${opts.latestOnly ? " right now" : ""}.` : `No active MTA alert affects ${[...stations.map((s) => s.name), ...routes.map((r) => `the ${r}`)].join(", ")}.`,
      data,
    );
  }
  const a = alerts[0];
  return result(
    ctx,
    "alerts_for",
    "answered",
    asked
      ? `Alert ${a.id} (${a.status}) affects ${a.routes.length ? `the ${a.routes.join(", ")}` : "no line"}${a.stations.length ? ` at ${plural(a.stations.length, "station")}` : ""}: “${clip(a.header, 120)}”`
      : `${plural(alerts.length, "active alert")}: ${alerts.slice(0, 3).map((x) => `“${clip(x.header, 80)}”`).join("; ")}.`,
    data,
  );
}

// ---------------------------------------------------------------- notice_chain

export interface ChainData {
  event: string | null;
  updates: { id: string; update: number; atMs: number; status: string | null; header: string }[];
  routes: string[];
  sources: BrainSource[];
}

/** Every update of one archived alert event, in order: how the agency kept riders current. */
export async function noticeChain(ctx: ToolContext, input: { query: string }, opts: AgencyOptions = {}): Promise<ToolResult<ChainData>> {
  const m = input.query.match(/\bevent\s*(?:id\s*)?#?\s*(\d{3,9})\b/i);
  const event = m ? `EV-${m[1]}` : null;
  if (!event) return result(ctx, "notice_chain", "unknown_entity", "The question names no alert event.", { event, updates: [], routes: [], sources: [] });
  if (opts.latestOnly) return result(ctx, "notice_chain", "not_in_graph", "Only the live alerts feed is held, not the alert archive.", { event, updates: [], routes: [], sources: [] });
  const res = await ctx.tracer.run<{ n: GNode; k: number; t: number }>(
    "the event's updates, in order",
    g(opts),
    `MATCH (n:Notice)-[:UPDATE_OF]->(e:AlertEvent {id: $event})
     RETURN n, n.update AS k, n.atMs AS t ORDER BY k, t`,
    { event },
    { readOnly: true },
  );
  if (!res.rows.length) return result(ctx, "notice_chain", "unknown_entity", `No alert event ${event.slice(3)} in the MTA's alert archive.`, { event, updates: [], routes: [], sources: [] });
  const updates = res.rows.map(({ n }) => ({ id: String(n.properties.id), update: Number(n.properties.update), atMs: Number(n.properties.atMs), status: str(n.properties.status), header: String(n.properties.header ?? "") }));
  const routes = [...new Set(res.rows.flatMap((r) => list(r.n.properties.routes)))];
  const last = updates[updates.length - 1];
  return result(
    ctx,
    "notice_chain",
    "answered",
    `Event ${event.slice(3)} had ${plural(updates.length, "update")} from ${nyStamp(updates[0].atMs)} to ${nyStamp(last.atMs)}; the last (${last.status ?? "no status"}): “${clip(last.header, 120)}”`,
    { event, updates, routes, sources: [last, ...updates.slice(0, -1).reverse()].slice(0, 6).map((u) => toAgencySource(res.rows.find((r) => String(r.n.properties.id) === u.id)!.n)) },
  );
}

// ---------------------------------------------------------------- agency_changes

export interface AgencyChangesData {
  sinceMs: number;
  opened: { id: string; equipment: string; stationName: string; atMs: number }[];
  resolved: { id: string; equipment: string; stationName: string; atMs: number }[];
  alerts: { id: string; header: string; atMs: number }[];
  notices: number;
  sources: BrainSource[];
}

/** "since 2026-10-15 18:00", "since Oct 15", "in the last 3 days": the instant a question asks about. */
export function sinceOf(text: string, now = Date.now()): number | null {
  const iso = text.match(/\bsince\s+(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/i);
  if (iso) return nyTime(+iso[1], +iso[2], +iso[3], iso[4] ? +iso[4] : 0, iso[5] ? +iso[5] : 0);
  const rel = text.match(/\b(?:last|past)\s+(\d{1,3})\s+(hour|day|week)s?\b/i);
  if (rel) return now - Number(rel[1]) * { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 }[rel[2].toLowerCase() as "hour" | "day" | "week"];
  if (/\btoday\b/i.test(text)) return now - 86_400_000;
  if (/\bthis week\b/i.test(text)) return now - 7 * 86_400_000;
  return null;
}

/** What opened, resolved and was announced since a time: outages, alerts, and archived alert updates. */
export async function agencyChanges(ctx: ToolContext, input: { sinceMs: number }, opts: AgencyOptions = {}): Promise<ToolResult<AgencyChangesData>> {
  const graph = g(opts);
  const since = input.sinceMs;
  const opened = await ctx.tracer.run<{ o: GNode; t: number }>(
    "outages that began since then",
    graph,
    `MATCH (o:Outage) WHERE o.upcoming = false AND o.openedMs >= $since AND ($history OR o.status <> 'resolved')
     RETURN o, o.openedMs AS t ORDER BY t DESC LIMIT 60`,
    { since, history: !opts.latestOnly },
    { readOnly: true },
  );
  const resolved = opts.latestOnly
    ? { rows: [] as { o: GNode; t: number }[] }
    : await ctx.tracer.run<{ o: GNode; t: number }>(
        "outages resolved since then",
        graph,
        "MATCH (o:Outage {status: 'resolved'}) WHERE o.resolvedMs >= $since RETURN o, o.resolvedMs AS t ORDER BY t DESC LIMIT 60",
        { since },
        { readOnly: true },
      );
  const alerts = await ctx.tracer.run<{ a: GNode; t: number }>(
    "alerts issued since then",
    graph,
    `MATCH (a:Alert) WHERE coalesce(a.createdMs, a.startMs, a.firstSeenMs) >= $since AND ($history OR a.status = 'active')
     RETURN a, coalesce(a.createdMs, a.startMs, a.firstSeenMs) AS t ORDER BY t DESC LIMIT 20`,
    { since, history: !opts.latestOnly },
    { readOnly: true },
  );
  const notices = opts.latestOnly
    ? { rows: [{ n: 0 }] }
    : await ctx.tracer.run<{ n: number }>("archived alert updates since then", graph, "MATCH (n:Notice) WHERE n.atMs >= $since RETURN count(n) AS n", { since }, { readOnly: true });
  const row = (o: GNode, t: number) => ({ id: String(o.properties.id), equipment: String(o.properties.equipment), stationName: String(o.properties.stationName), atMs: t });
  const data: AgencyChangesData = {
    sinceMs: since,
    opened: opened.rows.map((r) => row(r.o, r.t)),
    resolved: resolved.rows.map((r) => row(r.o, r.t)),
    alerts: alerts.rows.map((r) => ({ id: String(r.a.properties.id), header: String(r.a.properties.header), atMs: r.t })),
    notices: notices.rows[0]?.n ?? 0,
    sources: [...resolved.rows.slice(0, 4).map((r) => r.o), ...opened.rows.slice(0, 4).map((r) => r.o), ...alerts.rows.slice(0, 2).map((r) => r.a)].map(toAgencySource),
  };
  return result(
    ctx,
    "agency_changes",
    "answered",
    `Since ${nyStamp(since)}: ${plural(data.opened.length, "outage")} began, ${plural(data.resolved.length, "outage")} resolved, ${plural(data.alerts.length, "alert")} issued${data.notices ? `, ${plural(data.notices, "archived alert update")}` : ""}.`,
    data,
  );
}

// ---------------------------------------------------------------- project_trace

export interface ProjectData {
  project: { id: string; record: string; title: string; stage: string | null; phase: string | null; startMs: number | null; goalMs: number | null; estimatedMs: number | null; routes: string[]; contractor: string | null } | null;
  milestones: { id: string; phase: string | null; state: string | null; title: string | null; atMs: number | null }[];
  stations: string[];
  sources: BrainSource[];
}

/** An accessibility capital project (a real agency decision) traced through its dated milestones to the published schedule. */
export async function projectTrace(ctx: ToolContext, input: { query: string }, opts: AgencyOptions = {}): Promise<ToolResult<ProjectData>> {
  const graph = g(opts);
  const empty: ProjectData = { project: null, milestones: [], stations: [], sources: [] };
  let id = input.query.match(/\bproject\s*(?:id\s*)?#?\s*(\d{3,8})\b/i)?.[1] ?? null;
  if (!id) {
    const terms = searchTerms(input.query).filter((w) => !/^(capital|project|projects|milestone|milestones|stage|ada|accessibility)$/.test(w));
    if (!terms.length) return result(ctx, "project_trace", "unknown_entity", "The question names no capital project.", empty);
    const found = await ctx.tracer.run<{ id: string; score: number }>(
      "find the project by its title",
      graph,
      `CALL db.idx.fulltext.queryNodes('Record', $q) YIELD node, score
       WITH node, score WHERE node:Project
       RETURN node.record AS id, score ORDER BY score DESC LIMIT 1`,
      { q: terms.map((t) => `${t}*`).join("|") },
      { readOnly: true },
    );
    id = found.rows[0]?.id ?? null;
    if (!id) return result(ctx, "project_trace", "not_in_graph", `No accessibility capital project matches ${terms.join(", ")}.`, empty);
  }
  const res = await ctx.tracer.run<{ p: GNode; stations: string[] }>(
    "the project and the stations it names",
    graph,
    `MATCH (p:Project {id: $id})
     OPTIONAL MATCH (p)-[:AFFECTS]->(s:Station)
     RETURN p, collect(s.name) AS stations`,
    { id: `CP-${id}` },
    { readOnly: true },
  );
  const row = res.rows[0];
  if (!row) return result(ctx, "project_trace", "unknown_entity", `No capital project ${id} in the MTA's accessibility projects.`, empty);
  const ms = await ctx.tracer.run<{ m: GNode; k: number; t: number | null }>(
    "its milestones, in order",
    graph,
    `MATCH (:Project {id: $id})-[:HAS_MILESTONE]->(m:Milestone)
     RETURN m, m.sequence AS k, coalesce(m.atMs, m.phaseEndMs) AS t ORDER BY k, t`,
    { id: `CP-${id}` },
    { readOnly: true },
  );
  const p = row.p.properties;
  const project = {
    id: String(p.id),
    record: String(p.record),
    title: String(p.title),
    stage: str(p.stage),
    phase: str(p.phase),
    startMs: numOr(p.startMs),
    goalMs: numOr(p.goalMs),
    estimatedMs: numOr(p.estimatedMs),
    routes: list(p.routes),
    contractor: str(p.contractor),
  };
  const milestones = ms.rows.map(({ m }) => ({ id: String(m.properties.id), phase: str(m.properties.phase), state: str(m.properties.state), title: str(m.properties.title), atMs: numOr(m.properties.atMs) ?? numOr(m.properties.phaseEndMs) }));
  const dated = milestones.filter((m) => m.atMs);
  return result(
    ctx,
    "project_trace",
    "answered",
    `Capital project ${project.record}, “${project.title}”, is in ${project.stage ?? "an unrecorded stage"}${project.estimatedMs ? `, estimated to finish ${nyStamp(project.estimatedMs).slice(0, 10)}` : ""}; ${plural(milestones.length, "milestone")} on record${dated.length ? `, the latest ${dated[dated.length - 1].title ?? dated[dated.length - 1].phase} on ${nyStamp(dated[dated.length - 1].atMs!).slice(0, 10)}` : ""}.`,
    { project, milestones, stations: row.stations ?? [], sources: [toAgencySource(row.p), ...ms.rows.slice(-5).map((r) => toAgencySource(r.m))] },
  );
}

// ---------------------------------------------------------------- complaints_at

export interface ComplaintsData {
  station: { id: string; name: string } | null;
  quarter: string | null;
  /** Rider complaints about elevator or escalator outages, per quarter. */
  quarters: { quarter: string; count: number }[];
  total: number;
  /** The quarters the dataset slice covers. */
  window: { from: string; to: string };
  sources: BrainSource[];
}

/** Rider complaints about elevator and escalator outages at a station, by quarter (MTA customer feedback). */
export async function complaintsAt(ctx: ToolContext, input: { query: string }, opts: AgencyOptions = {}): Promise<ToolResult<ComplaintsData>> {
  const places = await placesIn(input.query);
  const s = places.stations[0] ?? null;
  const qm = input.query.match(/\b(20\d{2})\s*Q([1-4])\b/i) ?? input.query.match(/\bQ([1-4])\s*(?:of\s*)?(20\d{2})\b/i);
  const quarter = qm ? (qm[0].toUpperCase().startsWith("Q") ? `${qm[2]} Q${qm[1]}` : `${qm[1]} Q${qm[2]}`) : null;
  const window = { from: quarterOf(parseSodaDate(COMPLAINTS_SINCE)!), to: quarterOf(opts.now ?? Date.now()) };
  const empty: ComplaintsData = { station: s ? { id: s.id, name: s.name } : null, quarter, quarters: [], total: 0, window, sources: [] };
  if (!s) return result(ctx, "complaints_at", "unknown_entity", "The question names no station the graph knows.", empty);
  if (opts.latestOnly) return result(ctx, "complaints_at", "not_in_graph", "Only the live feeds are held, not the complaint history.", empty);
  const res = await ctx.tracer.run<{ c: GNode; q: string }>(
    "complaints about outages at the station, by quarter",
    g(opts),
    "MATCH (c:Complaints {station: $station}) WHERE $quarter = '' OR c.quarter = $quarter RETURN c, c.quarter AS q ORDER BY q",
    { station: s.id, quarter: quarter ?? "" },
    { readOnly: true },
  );
  const byQ = new Map<string, number>();
  for (const { c } of res.rows) byQ.set(String(c.properties.quarter), (byQ.get(String(c.properties.quarter)) ?? 0) + Number(c.properties.count));
  const quarters = [...byQ.entries()].map(([q, count]) => ({ quarter: q, count }));
  const total = quarters.reduce((n, q) => n + q.count, 0);
  const data: ComplaintsData = { ...empty, quarters, total, sources: res.rows.slice(-6).map((r) => toAgencySource(r.c)) };
  if (quarter && (quarter < window.from || quarter > window.to)) {
    return result(ctx, "complaints_at", "not_in_graph", `The complaint counts cover ${window.from} to ${window.to}; ${quarter} is outside them.`, data);
  }
  return result(
    ctx,
    "complaints_at",
    "answered",
    quarter
      ? `${plural(total, "rider complaint")} about elevator or escalator outages at ${s.name} in ${quarter}.`
      : `${plural(total, "rider complaint")} about elevator or escalator outages at ${s.name} from ${window.from} to ${window.to}${quarters.length ? `, most in ${[...quarters].sort((a, b) => b.count - a.count)[0].quarter}` : ""}.`,
    data,
  );
}

// ---------------------------------------------------------------- agency_search

export interface AgencySearchData {
  terms: string[];
  sources: BrainSource[];
}

/** Full-text search over every real MTA record's text (FalkorDB's full-text index, not a scan). */
export async function agencySearch(ctx: ToolContext, input: { query: string }, opts: AgencyOptions = {}): Promise<ToolResult<AgencySearchData>> {
  const terms = searchTerms(input.query).filter((w) => /^[a-z0-9]+$/.test(w));
  if (!terms.length) return result(ctx, "agency_search", "unknown_entity", "The question has no words to search for.", { terms, sources: [] });
  const res = await ctx.tracer.run<{ node: GNode; score: number }>(
    "full-text search over the MTA's records",
    g(opts),
    `CALL db.idx.fulltext.queryNodes('Record', $q) YIELD node, score
     WITH node, score WHERE $history OR NOT ((node:Outage AND node.status = 'resolved') OR (node:Alert AND node.status = 'ended') OR node:AlertEvent OR node:Complaints)
     RETURN node, score ORDER BY score DESC LIMIT 8`,
    { q: terms.join("|"), history: !opts.latestOnly },
    { readOnly: true },
  );
  const sources = res.rows.map((r) => toAgencySource(r.node));
  if (!sources.length) return result(ctx, "agency_search", "not_in_graph", `No MTA record mentions ${terms.join(", ")}.`, { terms, sources });
  return result(ctx, "agency_search", "answered", `${plural(sources.length, "MTA record")} match ${terms.join(", ")}: ${sources.slice(0, 3).map((s) => `${s.id} “${clip(s.title, 60)}”`).join("; ")}.`, { terms, sources });
}

// ---------------------------------------------------------------- for the brain page

/** The newest current outages, as sources for the brain page. */
export async function latestOutages(ctx: ToolContext, limit = 6, opts: AgencyOptions = {}): Promise<BrainSource[]> {
  const res = await ctx.tracer.run<{ o: GNode; t: number }>(
    "the newest current outages",
    g(opts),
    `MATCH (o:Outage {status: 'open'}) RETURN o, o.openedMs AS t ORDER BY t DESC LIMIT ${Math.max(1, Math.min(20, Math.round(limit)))}`,
    {},
    { readOnly: true },
  );
  return res.rows.map((r) => toAgencySource(r.o));
}
