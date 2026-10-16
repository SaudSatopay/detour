/**
 * Concurrency and isolation benchmark (Track 2: high-concurrency reads and writes, memory per
 * tenant). Rider agents read routes while controller agents write closures and findings, each in
 * their own tenant graph, over separate connections. Reports p50/p95/p99 and checks no tenant
 * sees another tenant's writes.
 *
 *   FALKORDB_URL=... pnpm tsx scripts/ci/bench.ts [seconds]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { FalkorDB } from "falkordb";
import { TEMPLATE_GRAPH } from "../../src/lib/graph/names";

const TENANTS = 6;
const READERS = 48;
const WRITERS = TENANTS;
const CONNECTIONS = 12;

const ROUTE_PAIRS: [string, string][] = [
  ["125", "602"],
  ["120", "618"],
  ["630", "601"],
  ["138", "602"],
  ["636", "628"],
  ["610", "622"],
  ["1", "611"],
  ["345", "628"],
];
const CLOSURES = [
  { routes: ["L"], stretch: ["120", "119", "118", "602", "601", "618"] },
  { routes: ["4", "5"], stretch: ["610", "602", "622"] },
  { routes: ["A", "C"], stretch: ["173", "628"] },
];

function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const seconds = Number(process.argv[2] ?? 12);
  const url = process.env.FALKORDB_URL;
  if (!url) throw new Error("FALKORDB_URL is not set");
  const pool = await Promise.all(Array.from({ length: CONNECTIONS }, () => FalkorDB.connect({ url })));
  const admin = pool[0];

  const tenants = Array.from({ length: TENANTS }, (_, i) => `detour:bench:t${i}`);
  for (const t of tenants) {
    if ((await admin.list()).includes(t)) await admin.selectGraph(t).delete();
    await admin.selectGraph(TEMPLATE_GRAPH).copy(t);
  }

  const reads: number[] = [];
  const writes: number[] = [];
  let errors = 0;
  const deadline = Date.now() + seconds * 1000;
  let rr = 0;
  const conn = () => pool[rr++ % pool.length];

  const reader = async (n: number) => {
    let i = n;
    while (Date.now() < deadline) {
      const tenant = tenants[i % tenants.length];
      const [from, to] = ROUTE_PAIRS[i % ROUTE_PAIRS.length];
      i += 7;
      const started = performance.now();
      try {
        await conn()
          .selectGraph(tenant)
          .roQuery(
            `MATCH (a:Station {id: $from}), (b:Station {id: $to})
             CALL algo.SPpaths({sourceNode: a, targetNode: b, relTypes: ['RUNS', 'WALK', 'BUS'], weightProp: 'minutes'})
             YIELD path, pathWeight RETURN pathWeight, [n IN nodes(path) | n.id] AS stops`,
            { params: { from, to }, TIMEOUT: 10_000 },
          );
        reads.push(performance.now() - started);
      } catch {
        errors += 1;
      }
    }
  };

  const writer = async (n: number) => {
    const tenant = tenants[n];
    const closure = CLOSURES[n % CLOSURES.length];
    let toggle = 0;
    while (Date.now() < deadline) {
      const started = performance.now();
      try {
        const g = conn().selectGraph(tenant);
        if (toggle++ % 2 === 0) {
          await g.query(
            `MATCH (a:Station)-[r:RUNS]->(b:Station)
             WHERE r.route IN $routes AND a.id IN $stretch AND b.id IN $stretch
             SET r.closed = true, r.minutes = 100000, r.spare = 0`,
            { params: { routes: closure.routes, stretch: closure.stretch } },
          );
        } else {
          await g.query(
            `MATCH ()-[r:RUNS {closed: true}]->() SET r.closed = false, r.minutes = r.baseMinutes
             WITH count(r) AS n
             MATCH (ag:Agent {id: 'controller'})
             CREATE (ag)-[:WROTE]->(:Finding {id: $id, text: 'bench finding', kind: 'observation', validFromMs: timestamp()})`,
            { params: { id: `B-${n}-${toggle}` } },
          );
        }
        writes.push(performance.now() - started);
      } catch {
        errors += 1;
      }
    }
  };

  const started = Date.now();
  await Promise.all([...Array.from({ length: READERS }, (_, i) => reader(i)), ...Array.from({ length: WRITERS }, (_, i) => writer(i))]);
  const elapsed = (Date.now() - started) / 1000;

  // Isolation: apply a closure in tenant 0 only, and check every other tenant still has none.
  for (const t of tenants) await admin.selectGraph(t).query("MATCH ()-[r:RUNS {closed: true}]->() SET r.closed = false, r.minutes = r.baseMinutes");
  await admin
    .selectGraph(tenants[0])
    .query("MATCH (a:Station)-[r:RUNS]->(b:Station) WHERE r.route = 'L' AND a.id IN $s AND b.id IN $s SET r.closed = true", {
      params: { s: CLOSURES[0].stretch },
    });
  const leaks: number[] = [];
  for (const t of tenants) {
    const res = await admin.selectGraph(t).roQuery<{ n: number }>("MATCH ()-[r:RUNS {closed: true}]->() RETURN count(r) AS n");
    leaks.push(res.data?.[0]?.n ?? 0);
  }

  reads.sort((a, b) => a - b);
  writes.sort((a, b) => a - b);
  const result = {
    engine: JSON.stringify(await admin.info("modules")).match(/"ver(?:sion)?",?"?:?(\d+)/)?.[1] ?? "unknown",
    seconds: Math.round(elapsed * 10) / 10,
    tenants: TENANTS,
    readers: READERS,
    writers: WRITERS,
    connections: CONNECTIONS,
    reads: { count: reads.length, perSecond: Math.round(reads.length / elapsed), p50: round(pct(reads, 50)), p95: round(pct(reads, 95)), p99: round(pct(reads, 99)) },
    writes: { count: writes.length, perSecond: Math.round(writes.length / elapsed), p50: round(pct(writes, 50)), p95: round(pct(writes, 95)), p99: round(pct(writes, 99)) },
    errors,
    isolation: { closedSegmentsPerTenant: leaks, ok: leaks[0] > 0 && leaks.slice(1).every((n) => n === 0) },
  };
  for (const t of tenants) await admin.selectGraph(t).delete();
  await Promise.all(pool.map((c) => c.close()));

  mkdirSync("ci-out", { recursive: true });
  writeFileSync("ci-out/bench.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.isolation.ok || errors > reads.length * 0.01) process.exit(1);
}

const round = (n: number) => Math.round(n * 10) / 10;

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
