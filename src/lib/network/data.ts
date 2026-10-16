import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Demand, Network, NetworkMeta } from "./types";

/**
 * Server-side access to the built network files in data/nyc. They ship with every deployment
 * (see outputFileTracingIncludes in next.config.ts) so an empty FalkorDB can be re-seeded.
 */
const dataDir = () => join(process.cwd(), "data", "nyc");

const cache = new Map<string, Promise<unknown>>();

function load<T>(file: string): Promise<T> {
  let hit = cache.get(file) as Promise<T> | undefined;
  if (!hit) {
    hit = readFile(join(dataDir(), file), "utf8").then((text) => JSON.parse(text) as T);
    hit.catch(() => cache.delete(file));
    cache.set(file, hit);
  }
  return hit;
}

export const loadNetwork = () => load<Network>("network.json");
export const loadDemand = () => load<Demand>("demand.json");
export const loadMeta = () => load<NetworkMeta>("meta.json");

export interface Scenario {
  id: string;
  title: string;
  report: string;
  routes: string[];
  stations: string[];
}

export function loadScenarios(): Promise<Scenario[]> {
  const file = join(process.cwd(), "data", "scenarios.json");
  let hit = cache.get(file) as Promise<Scenario[]> | undefined;
  if (!hit) {
    hit = readFile(file, "utf8").then((text) => JSON.parse(text) as Scenario[]);
    cache.set(file, hit);
  }
  return hit;
}
