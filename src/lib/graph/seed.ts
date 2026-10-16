import { connect, deleteGraph, listGraphs, run, type GraphParams } from "./db";
import { DEMAND_GRAPH, TEMPLATE_GRAPH } from "./names";
import { loadDemand, loadMeta, loadNetwork } from "../network/data";
import { SEED_AGENTS, SEED_FINDINGS, SEED_INCIDENTS, SEED_PLAYBOOKS, SEED_RIDERS } from "./seed-memory";

/** Bump when the graph model or seed data changes; an older graph is rebuilt. */
export const SEED_VERSION = 3;

const BATCH = 1500;

async function batched<T>(rows: T[], size: number, write: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

async function seedDemand(log: (msg: string) => void) {
  const [network, demand] = await Promise.all([loadNetwork(), loadDemand()]);
  const g = DEMAND_GRAPH;
  await run(g, "UNWIND $ids AS id CREATE (:Station {id: id})", { ids: network.stations.map((s) => s.id) });
  await run(g, "CREATE INDEX FOR (s:Station) ON (s.id)");
  let written = 0;
  await batched(demand.pairs, BATCH, async (chunk) => {
    const rows: GraphParams[] = chunk.map(([o, d, riders, minutes, via, walks]) => ({ o, d, riders, minutes, via, walks }));
    await run(
      g,
      `UNWIND $rows AS r
       MATCH (o:Station {id: r.o}), (d:Station {id: r.d})
       CREATE (o)-[:DEMAND {riders: r.riders, minutes: r.minutes, via: r.via, walks: r.walks}]->(d)`,
      { rows },
      { timeoutMs: 60_000 },
    );
    written += chunk.length;
  });
  await run(g, "CREATE (:Meta {version: $v, pairs: $n})", { v: SEED_VERSION, n: written });
  log(`demand: ${written} origin-destination pairs`);
}

async function seedTemplate(log: (msg: string) => void) {
  const [network, meta] = await Promise.all([loadNetwork(), loadMeta()]);
  const g = TEMPLATE_GRAPH;

  await run(
    g,
    `UNWIND $stations AS s
     CREATE (:Station {id: s.id, name: s.name, label: s.label, lat: s.lat, lon: s.lon,
       loc: point({latitude: s.lat, longitude: s.lon}), borough: s.borough, cbd: s.cbd,
       ada: s.ada, adaNotes: s.adaNotes, routes: s.routes, entries: s.entries, exits: s.exits})`,
    {
      stations: network.stations.map((s) => ({
        id: s.id,
        name: s.name,
        label: s.label,
        lat: s.lat,
        lon: s.lon,
        borough: s.borough,
        cbd: s.cbd,
        ada: s.ada,
        adaNotes: s.adaNotes,
        routes: s.routes,
        entries: s.entries,
        exits: s.exits,
      })),
    },
  );
  await run(g, "CREATE INDEX FOR (s:Station) ON (s.id)");
  await run(
    g,
    `UNWIND $routes AS r
     CREATE (:Route {id: r.id, short: r.short, longName: r.longName, color: r.color,
       textColor: r.textColor, trainCapacity: r.trainCapacity, sort: r.sort})`,
    {
      routes: network.routes.map((r) => ({
        id: r.id,
        short: r.short,
        longName: r.longName,
        color: r.color,
        textColor: r.textColor,
        trainCapacity: r.trainCapacity,
        sort: r.sort,
      })),
    },
  );
  await run(g, "CREATE INDEX FOR (r:Route) ON (r.id)");
  await run(g, "MATCH (r:Route), (s:Station) WHERE r.id IN s.routes CREATE (r)-[:SERVES]->(s)");

  await batched(network.segments, BATCH, (chunk) =>
    run(
      g,
      `UNWIND $segs AS e
       MATCH (a:Station {id: e.from}), (b:Station {id: e.to})
       CREATE (a)-[:RUNS {eid: e.eid, route: e.route, tph: e.tph, minutes: e.minutes, baseMinutes: e.minutes,
         capacity: e.capacity, load: e.load, spare: e.spare, closed: false}]->(b)`,
      {
        segs: chunk.map((e) => ({
          eid: e.eid,
          route: e.route,
          from: e.from,
          to: e.to,
          tph: e.tph,
          minutes: e.minutes,
          capacity: e.capacity,
          load: e.load,
          spare: Math.max(0, e.capacity - e.load),
        })),
      },
    ),
  );
  await run(g, "CREATE INDEX FOR ()-[e:RUNS]-() ON (e.eid)");
  await run(
    g,
    `UNWIND $walks AS w
     MATCH (a:Station {id: w.from}), (b:Station {id: w.to})
     CREATE (a)-[:WALK {wid: w.wid, meters: w.meters, minutes: w.minutes, capacity: w.capacity, spare: w.capacity}]->(b)`,
    { walks: network.walks.map((w) => ({ wid: w.wid, from: w.from, to: w.to, meters: w.meters, minutes: w.minutes, capacity: w.capacity })) },
  );
  await run(g, "CREATE INDEX FOR ()-[w:WALK]-() ON (w.wid)");
  await run(g, "CALL db.idx.fulltext.createNodeIndex('Station', 'name', 'label')");

  // Memory: agents, example incidents with their shuttles, findings, playbooks, riders.
  await run(g, "UNWIND $agents AS a CREATE (:Agent {id: a.id, role: a.role, name: a.name})", {
    agents: SEED_AGENTS.map((a) => ({ ...a })),
  });
  await run(g, "CREATE INDEX FOR (a:Agent) ON (a.id)");

  for (const inc of SEED_INCIDENTS) {
    await run(
      g,
      `CREATE (i:Incident {id: $id, title: $title, report: $report, routes: $routes, stretch: $stations,
         status: 'closed', example: true, openedAt: localdatetime($openedAt), closedAt: localdatetime($closedAt),
         openedMs: $openedMs})
       WITH i
       UNWIND $shuttles AS sh
       MATCH (a:Station {id: sh.from}), (b:Station {id: sh.to})
       CREATE (p:Shuttle {busesPerHour: sh.busesPerHour, planned: sh.planned, observed: sh.observed})-[:FOR]->(i),
              (p)-[:FROM]->(a), (p)-[:TO]->(b)`,
      {
        id: inc.id,
        title: inc.title,
        report: inc.report,
        routes: inc.routes,
        stations: inc.stations,
        openedAt: inc.openedAt,
        closedAt: inc.closedAt,
        openedMs: Date.parse(inc.openedAt),
        shuttles: inc.shuttles.map((s) => ({ ...s })),
      },
    );
  }
  await run(g, "CREATE INDEX FOR (i:Incident) ON (i.id)");

  for (const f of SEED_FINDINGS) {
    await run(
      g,
      `MATCH (ag:Agent {id: $agent})
       CREATE (ag)-[:WROTE]->(:Finding {id: $id, text: $text, kind: $kind, confidence: $confidence, example: true,
         validFrom: localdatetime($validFrom), validFromMs: $validFromMs, learnedMs: $validFromMs})`,
      {
        agent: f.agent,
        id: f.id,
        text: f.text,
        kind: f.kind,
        confidence: f.confidence,
        validFrom: f.validFrom,
        validFromMs: Date.parse(f.validFrom),
      },
    );
    if (f.incident) {
      await run(g, "MATCH (f:Finding {id: $id}), (i:Incident {id: $incident}) CREATE (f)-[:FROM]->(i)", {
        id: f.id,
        incident: f.incident,
      });
    }
    await run(g, "MATCH (f:Finding {id: $id}), (s:Station) WHERE s.id IN $stations CREATE (f)-[:ABOUT]->(s)", {
      id: f.id,
      stations: f.about.stations ?? [],
    });
    await run(g, "MATCH (f:Finding {id: $id}), (r:Route) WHERE r.id IN $routes CREATE (f)-[:ABOUT]->(r)", {
      id: f.id,
      routes: f.about.routes ?? [],
    });
    if (f.validTo) {
      await run(g, "MATCH (f:Finding {id: $id}) SET f.validTo = localdatetime($to), f.validToMs = $toMs", {
        id: f.id,
        to: f.validTo,
        toMs: Date.parse(f.validTo),
      });
    }
  }
  await run(g, "CREATE INDEX FOR (f:Finding) ON (f.id)");

  for (const p of SEED_PLAYBOOKS) {
    await run(
      g,
      `CREATE (p:Playbook {id: $id, title: $title, steps: $steps, uses: $uses, lastUsedMs: $lastUsedMs, example: true})
       WITH p
       MATCH (r:Route) WHERE r.id IN $routes
       CREATE (p)-[:FOR]->(r)`,
      { id: p.id, title: p.title, steps: p.steps, uses: p.uses, lastUsedMs: Date.parse(p.lastUsed), routes: p.routes },
    );
  }

  for (const r of SEED_RIDERS) {
    await run(
      g,
      `MATCH (a:Station {id: $from}), (b:Station {id: $to})
       CREATE (rider:Rider {id: $id, name: $name, persona: $persona, departs: $departs, stepFree: $stepFree, synthetic: true}),
              (rider)-[:STARTS_AT]->(a), (rider)-[:ENDS_AT]->(b)
       WITH rider
       UNWIND $prefs AS p
       CREATE (rider)-[:PREFERS {validFromMs: p.sinceMs}]->(:Preference {key: p.key, value: p.value})`,
      {
        from: r.from,
        to: r.to,
        id: r.id,
        name: r.name,
        persona: r.persona,
        departs: r.departs,
        stepFree: r.stepFree,
        prefs: r.preferences.map((p) => ({ key: p.key, value: p.value, sinceMs: Date.parse(p.since) })),
      },
    );
  }
  await run(g, "CREATE INDEX FOR (r:Rider) ON (r.id)");

  // Each rider's usual trip: the weighted shortest path over the open network, stored as segment ids.
  for (const r of SEED_RIDERS) {
    await run(
      g,
      `MATCH (rider:Rider {id: $id})-[:STARTS_AT]->(a:Station), (rider)-[:ENDS_AT]->(b:Station)
       CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: ['RUNS', 'WALK'], weightProp: 'minutes'})
       YIELD path, pathWeight
       WITH rider, path, pathWeight LIMIT 1
       SET rider.usualEids = [r IN relationships(path) WHERE type(r) = 'RUNS' | r.eid],
           rider.usualStations = [n IN nodes(path) | n.id],
           rider.usualMinutes = pathWeight`,
      { id: r.id },
    );
  }

  await run(
    g,
    "CREATE (:Meta {version: $v, builtAt: $builtAt, stations: $stations, segments: $segments, totalRiders: $riders})",
    {
      v: SEED_VERSION,
      builtAt: meta.builtAt,
      stations: network.stations.length,
      segments: network.segments.length,
      riders: meta.ridership.totalRiders,
    },
  );
  log(`template: ${network.stations.length} stations, ${network.segments.length} segments, ${network.walks.length} walks, ${SEED_RIDERS.length} riders`);
}

async function graphVersion(name: string): Promise<number | null> {
  try {
    const res = await run<{ v: number }>(name, "MATCH (m:Meta) RETURN m.version AS v LIMIT 1", {}, { readOnly: true });
    return res.rows[0]?.v ?? null;
  } catch {
    return null;
  }
}

/** Seeds (or rebuilds) the shared graphs. Safe to call repeatedly; only missing or stale graphs are rebuilt. */
export async function ensureBaseGraphs(log: (msg: string) => void = () => {}, force = false): Promise<void> {
  const db = await connect();
  const existing = new Set(await listGraphs());
  const lockKey = "detour:seed-lock";
  for (const [name, seed] of [
    [DEMAND_GRAPH, seedDemand],
    [TEMPLATE_GRAPH, seedTemplate],
  ] as const) {
    const fresh = existing.has(name) && (await graphVersion(name)) === SEED_VERSION;
    if (fresh && !force) continue;
    const got = await db.connection.then((c) =>
      c.set(lockKey, name, { condition: "NX", expiration: { type: "PX", value: 120_000 } }),
    );
    if (got !== "OK") throw new Error("Another process is seeding the graphs; retry in a minute.");
    try {
      if (existing.has(name)) await deleteGraph(name);
      log(`seeding ${name}`);
      await seed(log);
    } finally {
      await db.connection.then((c) => c.del(lockKey));
    }
  }
}
