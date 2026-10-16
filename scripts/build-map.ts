/**
 * Slims data/nyc/network.json into the client map file public/map/nyc.json.
 *   pnpm tsx scripts/build-map.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Network } from "../src/lib/network/types";
import type { MapData } from "../src/lib/network/map";

const network = JSON.parse(readFileSync("data/nyc/network.json", "utf8")) as Network;

const map: MapData = {
  stations: network.stations.map((s) => [s.id, s.name, s.label, round(s.lat, 5), round(s.lon, 5), s.routes.join(" "), s.ada, s.cbd ? 1 : 0, s.borough, s.entries]),
  routes: network.routes.map((r) => [r.id, r.short, r.color, r.textColor, r.patterns]),
  segments: network.segments.map((s) => [s.eid, s.route, s.from, s.to, s.capacity, s.load, s.tph]),
  walks: network.walks.map((w) => [w.wid, w.from, w.to]),
};

function round(n: number, places: number) {
  return Math.round(n * 10 ** places) / 10 ** places;
}

mkdirSync("public/map", { recursive: true });
writeFileSync("public/map/nyc.json", JSON.stringify(map));
console.log(`public/map/nyc.json: ${map.stations.length} stations, ${map.segments.length} segments`);
