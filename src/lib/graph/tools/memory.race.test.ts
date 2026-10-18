import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteGraph, listGraphs, run } from "../db";
import { Tracer } from "../trace";
import { reportElevator } from "./memory";

/*
 * Integration: many simultaneous reports about one elevator leave exactly one open fact. Runs against a live
 * FalkorDB on a small graph of its own, and skips itself when FALKORDB_URL is unset.
 */
const live = Boolean(process.env.FALKORDB_URL);
const graph = `detour:test:race-${Date.now().toString(36)}`;
const ctx = () => ({ visitorId: "race", sandbox: graph, agentId: "rider-desk", tracer: new Tracer() });

async function openFacts(station: string, route: string): Promise<number> {
  const res = await run<{ n: number }>(
    graph,
    `MATCH (f:Finding)-[:ABOUT]->(:Station {id: $station}), (f)-[:ABOUT]->(:Route {id: $route})
     WHERE f.validToMs IS NULL AND f.text STARTS WITH 'Elevator'
     RETURN count(DISTINCT f) AS n`,
    { station, route },
    { readOnly: true },
  );
  return res.rows[0]?.n ?? 0;
}

describe.skipIf(!live)("remember under concurrent writers", () => {
  beforeAll(async () => {
    await run(
      graph,
      `CREATE (:Agent {id: 'rider-desk', name: 'Rider desk'}), (:Route {id: 'L'})
       WITH 1 AS x
       UNWIND ['s10', 's50', 's100'] AS id
       CREATE (:Station {id: id, name: id})`,
    );
  });

  afterAll(async () => {
    if ((await listGraphs()).includes(graph)) await deleteGraph(graph);
  });

  it.each([10, 50, 100])("%i writers leave exactly one open elevator fact", async (writers) => {
    const station = `s${writers}`;
    const report = (working: boolean) => reportElevator(ctx(), { station, stationName: station, route: "L", working, syncTicket: false });
    const same = await Promise.all(Array.from({ length: writers }, () => report(false)));
    expect(same.filter((r) => r.outcome === "answered")).toHaveLength(1);
    expect(await openFacts(station, "L")).toBe(1);
    await Promise.all(Array.from({ length: writers }, (_, i) => report(i % 2 === 0)));
    expect(await openFacts(station, "L")).toBe(1);
  });
});
