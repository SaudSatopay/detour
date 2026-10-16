import type { AdaLevel, Borough } from "./types";

/** Compact tuples shipped to the browser (public/map/nyc.json). */
export interface MapData {
  /** [id, name, label, lat, lon, routes "A C E", ada, cbd 0|1, borough, entries 8-9 a.m.] */
  stations: [string, string, string, number, number, string, AdaLevel, 0 | 1, Borough, number][];
  /** [id, short, color, textColor, patterns] */
  routes: [string, string, string, string, string[][]][];
  /** [eid, route, from, to, capacity, load, tph] */
  segments: [number, string, string, string, number, number, number][];
  /** [wid, from, to] */
  walks: [number, string, string][];
}

export interface MapStation {
  id: string;
  name: string;
  label: string;
  lat: number;
  lon: number;
  routes: string[];
  ada: AdaLevel;
  cbd: boolean;
  borough: Borough;
  entries: number;
  x: number;
  y: number;
}

export interface MapRoute {
  id: string;
  short: string;
  color: string;
  textColor: string;
  patterns: string[][];
}

export interface MapSegment {
  eid: number;
  route: string;
  from: string;
  to: string;
  capacity: number;
  load: number;
  tph: number;
}

export interface MapModel {
  stations: Map<string, MapStation>;
  routes: Map<string, MapRoute>;
  segments: Map<number, MapSegment>;
  walks: Map<number, { wid: number; from: string; to: string }>;
  /** Undirected station pairs with the routes drawn along them, in a stable order. */
  corridors: { key: string; a: string; b: string; routes: string[] }[];
  width: number;
  height: number;
}

/** Web-Mercator-ish projection around New York, scaled to a fixed viewBox. */
export function buildMapModel(data: MapData, width = 1000): MapModel {
  const lat0 = 40.73;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const raw = data.stations.map(([id, name, label, lat, lon, routes, ada, cbd, borough, entries]) => ({
    id,
    name,
    label,
    lat,
    lon,
    routes: routes ? routes.split(" ") : [],
    ada,
    cbd: cbd === 1,
    borough,
    entries,
    px: lon * k,
    py: -lat,
  }));
  const minX = Math.min(...raw.map((s) => s.px));
  const maxX = Math.max(...raw.map((s) => s.px));
  const minY = Math.min(...raw.map((s) => s.py));
  const maxY = Math.max(...raw.map((s) => s.py));
  const pad = 24;
  const scale = (width - pad * 2) / (maxX - minX);
  const height = Math.round((maxY - minY) * scale + pad * 2);
  const stations = new Map<string, MapStation>(
    raw.map((s) => [
      s.id,
      { id: s.id, name: s.name, label: s.label, lat: s.lat, lon: s.lon, routes: s.routes, ada: s.ada, cbd: s.cbd, borough: s.borough, entries: s.entries, x: pad + (s.px - minX) * scale, y: pad + (s.py - minY) * scale },
    ]),
  );
  const routes = new Map<string, MapRoute>(data.routes.map(([id, short, color, textColor, patterns]) => [id, { id, short, color, textColor, patterns }]));
  const segments = new Map<number, MapSegment>(
    data.segments.map(([eid, route, from, to, capacity, load, tph]) => [eid, { eid, route, from, to, capacity, load, tph }]),
  );
  const walks = new Map(data.walks.map(([wid, from, to]) => [wid, { wid, from, to }]));

  const corridorMap = new Map<string, { key: string; a: string; b: string; routes: Set<string> }>();
  for (const s of segments.values()) {
    const [a, b] = s.from < s.to ? [s.from, s.to] : [s.to, s.from];
    const key = `${a}~${b}`;
    const c = corridorMap.get(key) ?? { key, a, b, routes: new Set<string>() };
    c.routes.add(s.route);
    corridorMap.set(key, c);
  }
  const order = new Map(data.routes.map(([id], i) => [id, i]));
  const corridors = [...corridorMap.values()].map((c) => ({
    key: c.key,
    a: c.a,
    b: c.b,
    routes: [...c.routes].sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0)),
  }));
  return { stations, routes, segments, walks, corridors, width, height };
}
