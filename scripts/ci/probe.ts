/**
 * Prints exactly what the FalkorDB procedures Detour depends on return, on a tiny graph, so the
 * tool code can rely on verified shapes. Run against any instance: FALKORDB_URL=... pnpm tsx scripts/ci/probe.ts
 */
import { existsSync } from "node:fs";
import { connect, run } from "../../src/lib/graph/db";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const db = await waitForDb();
  const info = await db.info("modules");
  console.log("modules:", JSON.stringify(info).slice(0, 400));

  const g = "probe:shapes";
  try {
    await db.selectGraph(g).delete();
  } catch {
    // fresh graph
  }
  await run(
    g,
    `CREATE (s:Hub {id:'S'}), (a:Station {id:'a', loc: point({latitude: 40.70, longitude: -73.95})}),
            (b:Station {id:'b', loc: point({latitude: 40.71, longitude: -73.96})}), (t:Hub {id:'T'}),
            (s)-[:FEED {spare: 5.0}]->(a), (s)-[:FEED {spare: 5.0}]->(b),
            (a)-[:RUNS {eid: 1, spare: 3.0, minutes: 2.0, route: 'L'}]->(t), (a)-[:RUNS {eid: 2, spare: 1.0, minutes: 1.0, route: 'G'}]->(b),
            (b)-[:RUNS {eid: 3, spare: 10.0, minutes: 4.0, route: 'J'}]->(t)`,
  );

  const probes: [string, string][] = [
    [
      "maxFlow raw",
      `MATCH (s:Hub {id:'S'}), (t:Hub {id:'T'})
       CALL algo.maxFlow({sourceNodes: [s], targetNodes: [t], relationshipTypes: ['FEED','RUNS'], capacityProperty: 'spare'})
       YIELD nodes, edges, edgeFlows, maxFlow
       RETURN maxFlow, edgeFlows, size(edges) AS ne, size(nodes) AS nn`,
    ],
    [
      "maxFlow projected",
      `MATCH (s:Hub {id:'S'}), (t:Hub {id:'T'})
       CALL algo.maxFlow({sourceNodes: [s], targetNodes: [t], relationshipTypes: ['FEED','RUNS'], capacityProperty: 'spare'})
       YIELD maxFlow, edges, edgeFlows
       RETURN maxFlow, [e IN edges | [type(e), coalesce(e.eid, e.wid, e.bid, -1), startNode(e).id, endNode(e).id, e.spare]] AS es, edgeFlows AS flows`,
    ],
    [
      "SSpaths",
      `MATCH (a:Station {id:'a'})
       CALL algo.SSpaths({sourceNode: a, relTypes: ['RUNS'], weightProp: 'minutes'})
       YIELD path, pathWeight
       WITH path, pathWeight, nodes(path)[size(nodes(path)) - 1] AS t
       RETURN t.id AS t, pathWeight, [r IN relationships(path) | r.eid] AS eids`,
    ],
    [
      "SPpaths k=3",
      `MATCH (a:Station {id:'a'}), (t:Hub {id:'T'})
       CALL algo.SPpaths({sourceNode: a, targetNode: t, relTypes: ['RUNS'], weightProp: 'minutes', pathCount: 3})
       YIELD path, pathWeight
       RETURN pathWeight, [r IN relationships(path) | r.eid] AS eids ORDER BY pathWeight`,
    ],
    [
      "UNWIND + SSpaths",
      `UNWIND [{o: 'a', ds: ['T', 'b']}] AS row
       MATCH (o:Station {id: row.o})
       CALL algo.SSpaths({sourceNode: o, relTypes: ['RUNS'], weightProp: 'minutes'})
       YIELD path, pathWeight
       WITH row, path, pathWeight, nodes(path)[size(nodes(path)) - 1] AS t
       WHERE t.id IN row.ds
       RETURN row.o AS o, t.id AS d, pathWeight`,
    ],
    ["harmonic", "CALL algo.HarmonicCentrality({nodeLabels: ['Station','Hub'], relationshipTypes: ['RUNS']}) YIELD node, score RETURN node.id AS id, score"],
    ["distance", "MATCH (a:Station {id:'a'}), (b:Station {id:'b'}) RETURN distance(a.loc, b.loc) AS meters"],
    [
      "var-length upstream",
      "MATCH p = (o)-[:RUNS*0..3]->(t:Hub {id:'T'}) RETURN o.id AS id, min(length(p)) AS hops",
    ],
    ["list any", "MATCH ()-[r:RUNS]->() WHERE any(e IN [1,3] WHERE e = r.eid) RETURN collect(r.eid) AS hit"],
  ];

  for (const [label, q] of probes) {
    try {
      const res = await run(g, q, {}, { readOnly: !q.includes("CREATE") });
      console.log(`\n# ${label} (${res.ms.toFixed(1)} ms)\n${JSON.stringify(res.rows, null, 1).slice(0, 1500)}`);
    } catch (error) {
      console.log(`\n# ${label} FAILED: ${(error as Error).message}`);
    }
  }
  await db.selectGraph(g).delete();
  await db.close();
}

async function waitForDb() {
  const until = Date.now() + 90_000;
  for (;;) {
    try {
      const db = await connect();
      await db.list();
      return db;
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
