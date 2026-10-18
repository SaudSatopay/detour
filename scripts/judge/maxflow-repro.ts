/**
 * Runs FalkorDB's algo.maxFlow on Chokepoint's 11-edge reproduction (a node-split network on which
 * FalkorDB 4.22.0 and 6.0.2 were reported to return 300 instead of 453) and on random node-split
 * networks, and checks every answer with Detour's max-flow/min-cut certificate and Dinic solver
 * (src/lib/graph/flow.ts). Prints the outcome; closures-eval.ts and judge.ts record it.
 *
 *   FALKORDB_URL=falkor://127.0.0.1:6380 pnpm tsx scripts/judge/maxflow-repro.ts [networks]
 *
 * Source of the reproduction: https://github.com/Hackmaass/Chokepoint (docs/falkordb-bug-report-draft.md).
 */
import { existsSync } from "node:fs";
import { connect, deleteGraph, listGraphs, run } from "../../src/lib/graph/db";
import { certifyMaxFlow, dinicMaxFlow, seededRandom, type CapEdge } from "../../src/lib/graph/flow";

const GRAPH = "judge:maxflow";

export const CHOKEPOINT_EDGES: CapEdge[] = [
  ["src:out", "a15:in", 3322],
  ["a15:in", "a15:out", 158],
  ["a15:out", "a20:in", 3322],
  ["src:out", "a20:in", 3322],
  ["a20:in", "a20:out", 300],
  ["a20:out", "x1:in", 3322],
  ["a15:out", "a3:in", 3322],
  ["a3:in", "a3:out", 153],
  ["a3:out", "a12:in", 3322],
  ["a12:in", "a12:out", 261],
  ["a12:out", "x1:in", 3322],
].map(([from, to, capacity], i) => ({ key: `e${i}`, from: from as string, to: to as string, capacity: capacity as number }));

export interface SolveOutcome {
  falkordb: number;
  exact: number;
  feasible: boolean;
  maximal: boolean;
  checked: boolean;
  problems: string[];
  ms: number;
}

/** Loads one network into a scratch graph and runs algo.maxFlow on it, then certifies the answer. */
export async function solveOnFalkor(edges: CapEdge[], source: string, sink: string): Promise<SolveOutcome> {
  if ((await listGraphs()).includes(GRAPH)) await deleteGraph(GRAPH);
  const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  await run(GRAPH, "UNWIND $ids AS id CREATE (:N {id: id})", { ids: nodes });
  await run(
    GRAPH,
    `UNWIND $edges AS e
     MATCH (a:N {id: e.from}), (b:N {id: e.to})
     CREATE (a)-[:E {key: e.key, cap: e.capacity}]->(b)`,
    { edges: edges.map((e) => ({ key: e.key, from: e.from, to: e.to, capacity: e.capacity })) },
  );
  const res = await run<{ maxFlow: number; keys: string[]; flows: number[] }>(
    GRAPH,
    `MATCH (s:N {id: $source}), (t:N {id: $sink})
     CALL algo.maxFlow({sourceNodes: [s], targetNodes: [t], relationshipTypes: ['E'], capacityProperty: 'cap'})
     YIELD maxFlow, edges, edgeFlows
     RETURN maxFlow, [e IN edges | e.key] AS keys, edgeFlows AS flows`,
    { source, sink },
    { readOnly: true, timeoutMs: 20_000 },
  );
  const row = res.rows[0];
  const flowOf = new Map<string, number>();
  (row?.keys ?? []).forEach((k, i) => flowOf.set(k, (flowOf.get(k) ?? 0) + (row.flows[i] ?? 0)));
  const reported = row?.maxFlow ?? 0;
  const cert = certifyMaxFlow(
    edges.map((e) => ({ ...e, flow: flowOf.get(e.key) ?? 0 })),
    source,
    sink,
    reported,
  );
  await deleteGraph(GRAPH);
  return {
    falkordb: reported,
    exact: dinicMaxFlow(edges, source, sink).value,
    feasible: cert.feasible,
    maximal: cert.maximal,
    checked: cert.checked,
    problems: cert.problems,
    ms: Math.round(res.ms * 10) / 10,
  };
}

/**
 * A random node-split network in Chokepoint's style: each account becomes `in -> out` with its
 * own capacity, transfers run `out -> in` with a large capacity, one account's `out` is the source
 * and another's `in` the sink.
 */
export function splitNetwork(rand: () => number, accounts: number, transfers: number): { edges: CapEdge[]; source: string; sink: string } {
  const edges: CapEdge[] = [];
  for (let i = 0; i < accounts; i++) edges.push({ key: `n${i}`, from: `a${i}:in`, to: `a${i}:out`, capacity: 50 + Math.floor(rand() * 400) });
  const seen = new Set<string>();
  for (let k = 0; k < transfers; k++) {
    const a = Math.floor(rand() * accounts);
    const b = Math.floor(rand() * accounts);
    if (a === b || seen.has(`${a}>${b}`)) continue;
    seen.add(`${a}>${b}`);
    edges.push({ key: `t${k}`, from: `a${a}:out`, to: `a${b}:in`, capacity: 3322 });
  }
  return { edges, source: "a0:out", sink: `a${accounts - 1}:in` };
}

export interface ReproReport {
  engine: string;
  chokepoint: SolveOutcome;
  random: { networks: number; wrong: number; caughtByCertificate: number; missedByCertificate: number; examples: { falkordb: number; exact: number; problem: string }[] };
}

/** The graph module's version from MODULE LIST (42201 is 4.22.1). */
export async function falkorVersion(): Promise<string> {
  const db = await connect();
  const attempts: (() => Promise<unknown>)[] = [
    async () => ((await db.connection) as unknown as { sendCommand(args: string[]): Promise<unknown> }).sendCommand(["MODULE", "LIST"]),
    () => db.info("modules"),
  ];
  for (const attempt of attempts) {
    try {
      const text = JSON.stringify(await attempt());
      const ver = /graph[^0-9]*?ver[^0-9]*(\d{5,6})/i.exec(text)?.[1];
      if (!ver) continue;
      const n = Number(ver);
      return `FalkorDB ${Math.floor(n / 10000)}.${Math.floor((n % 10000) / 100)}.${n % 100}`;
    } catch {
      // try the next way of asking
    }
  }
  return "FalkorDB (version not reported)";
}

export async function reproduce(networks = 100, seed = 7): Promise<ReproReport> {
  const chokepoint = await solveOnFalkor(CHOKEPOINT_EDGES, "src:out", "x1:in");
  const rand = seededRandom(seed);
  const random: ReproReport["random"] = { networks: 0, wrong: 0, caughtByCertificate: 0, missedByCertificate: 0, examples: [] };
  for (let i = 0; i < networks; i++) {
    const { edges, source, sink } = splitNetwork(rand, 6 + Math.floor(rand() * 10), 10 + Math.floor(rand() * 30));
    const r = await solveOnFalkor(edges, source, sink);
    random.networks++;
    const wrong = Math.abs(r.falkordb - r.exact) > 1e-6 || !r.feasible;
    if (wrong) {
      random.wrong++;
      if (random.examples.length < 3) random.examples.push({ falkordb: r.falkordb, exact: r.exact, problem: r.problems[0] ?? "" });
    }
    if (wrong && !r.checked) random.caughtByCertificate++;
    if (wrong && r.checked) random.missedByCertificate++;
  }
  return { engine: await falkorVersion(), chokepoint, random };
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const report = await reproduce(Number(process.argv[2] ?? 100));
  const c = report.chokepoint;
  console.log(`${report.engine}`);
  console.log(
    `Chokepoint 11-edge network: algo.maxFlow ${c.falkordb}, exact ${c.exact}; certificate ${c.checked ? "passes" : `fails (${c.problems.join("; ")})`}`,
  );
  const r = report.random;
  console.log(
    `${r.networks} random node-split networks: algo.maxFlow wrong on ${r.wrong} (${((r.wrong / Math.max(1, r.networks)) * 100).toFixed(1)}%); the certificate caught ${r.caughtByCertificate}, missed ${r.missedByCertificate}`,
  );
  await (await connect()).close();
  if (r.missedByCertificate > 0 || (c.falkordb !== c.exact && c.checked)) {
    console.error("A wrong FalkorDB answer passed the certificate: the checker is broken.");
    process.exit(1);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/judge/maxflow-repro.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
