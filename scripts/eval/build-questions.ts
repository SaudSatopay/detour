/**
 * Builds the eval set (data/eval/questions.json). Every expected answer comes from a source that is
 * not FalkorDB: the NetworkX verifier's output, the network JSON (plain breadth-first search for
 * reachability) and the seeded memory. The graph agent is then graded against these.
 *
 *   pnpm tsx scripts/eval/build-questions.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SEED_FINDINGS, SEED_INCIDENTS } from "../../src/lib/graph/seed-memory";

type Flow = { required: number; absorbed: number; unmet: number; cut: { bottlenecks: { runs: { from: string }[] } } };
type Verify = { displaced: Record<string, { riders: number }>; depthCounts: { k: number; riders: number }[]; flow: Record<string, Flow>; peakDirection: string };
type Network = { stations: { id: string; name: string; borough: string }[]; segments: { from: string; to: string }[]; walks: { from: string; to: string }[] };

export type Grade =
  | { kind: "number"; value: number; tolerance: number }
  | { kind: "yesno"; value: "yes" | "no" }
  | { kind: "contains"; any: string[] }
  | { kind: "decline" };

export interface Question {
  id: string;
  category: "impact" | "capacity" | "bottleneck" | "memory" | "not_in_graph" | "unknown_entity";
  question: string;
  expect: Grade;
  source: string;
}

const verify = (id: string) => JSON.parse(readFileSync(`data/nyc/verify/${id}.json`, "utf8")) as Verify;
const network = JSON.parse(readFileSync("data/nyc/network.json", "utf8")) as Network;
const name = new Map(network.stations.map((s) => [s.id, s.name]));
const total = (v: Verify) => Object.values(v.displaced).reduce((s, d) => s + d.riders, 0);
const depth = (v: Verify, k: number) => v.depthCounts.find((d) => d.k === k)!.riders;

function reachable(from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const e of [...network.segments, ...network.walks]) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const x = queue.shift()!;
    if (x === to) return true;
    for (const y of next.get(x) ?? []) {
      if (seen.has(y)) continue;
      seen.add(y);
      queue.push(y);
    }
  }
  return false;
}

const L = verify("l-canarsie");
const LEX = verify("lex-express");
const AC = verify("cranberry");
const NX = "NetworkX verifier, data/nyc/verify";
const closures = [
  { v: L, id: "l", what: "the L train is closed in both directions between Bedford Av and 8 Av (14 St/8 Av)" },
  { v: LEX, id: "lex", what: "the 4 and 5 trains are suspended between Grand Central-42 St and Brooklyn Bridge-City Hall" },
  { v: AC, id: "ac", what: "the A and C trains are suspended between High St and Fulton St (Cranberry Street Tunnel)" },
];

const questions: Question[] = [];
for (const c of closures) {
  questions.push({
    id: `${c.id}-displaced`,
    category: "impact",
    question: `At 8 a.m. on a weekday, ${c.what}. How many riders an hour have trips that cross the closed stretch?`,
    expect: { kind: "number", value: Math.round(total(c.v)), tolerance: 0.03 },
    source: NX,
  });
  questions.push({
    id: `${c.id}-depth1`,
    category: "impact",
    question: `At 8 a.m. on a weekday, ${c.what}. Of the riders whose trips cross the closure, how many an hour start their trip at a station no more than one stop before the closed stretch (including inside it)?`,
    expect: { kind: "number", value: Math.round(depth(c.v, 1)), tolerance: 0.03 },
    source: NX,
  });
  const peak = c.v.flow[c.v.peakDirection];
  const fits = Object.values(c.v.flow).every((f) => f.unmet < 1);
  questions.push({
    id: `${c.id}-fits`,
    category: "capacity",
    question: `At 8 a.m. on a weekday, ${c.what}. If the displaced riders were spread perfectly over the spare capacity of the open lines (and walking links), could the network carry all of them in both directions? Answer yes or no.`,
    expect: { kind: "yesno", value: fits ? "yes" : "no" },
    source: NX,
  });
  if (!fits) {
    questions.push({
      id: `${c.id}-maxflow`,
      category: "capacity",
      question: `At 8 a.m. on a weekday, ${c.what}. Spreading displaced riders perfectly over spare capacity (max flow), how many riders an hour traveling in the direction of the peak demand could the open network carry?`,
      expect: { kind: "number", value: Math.round(peak.absorbed), tolerance: 0.03 },
      source: NX,
    });
    questions.push({
      id: `${c.id}-unmet`,
      category: "capacity",
      question: `At 8 a.m. on a weekday, ${c.what}. Spreading displaced riders perfectly over spare capacity (max flow), how many riders an hour in the peak direction still could not move?`,
      expect: { kind: "number", value: Math.round(peak.unmet), tolerance: 0.05 },
      source: NX,
    });
    const cut = [...new Set(peak.cut.bottlenecks.runs.map((r) => name.get(r.from)!))];
    questions.push({
      id: `${c.id}-cut`,
      category: "bottleneck",
      question: `At 8 a.m. on a weekday, ${c.what}. Which station's riders have no open alternative at all, so that no amount of spare capacity elsewhere can move them (the minimum cut of the max flow)?`,
      expect: { kind: "contains", any: cut },
      source: NX,
    });
  }
}

const elevator = SEED_FINDINGS.find((f) => f.id === "F-ELEV-2")!;
const since = new Date(elevator.validFrom);
const june = SEED_INCIDENTS.find((i) => i.id === "INC-0612")!;
const jShuttle = june.shuttles[0];
questions.push(
  {
    id: "mem-elevator-since",
    category: "memory",
    question: "Is the elevator to the L platform at Myrtle-Wyckoff Avs working? If not, since what date has it been out?",
    expect: { kind: "contains", any: [since.toLocaleDateString("en-US", { month: "short", day: "numeric" }), since.toLocaleDateString("en-US", { month: "long", day: "numeric" })] },
    source: "seeded memory, F-ELEV-2",
  },
  {
    id: "mem-june-shuttle",
    category: "memory",
    question: "During the June 12, 2026 Canarsie Tube incident, what share of its planned riders did the Bedford Av to Marcy Av shuttle actually carry? Give a percentage.",
    expect: { kind: "number", value: Math.round((jShuttle.observed / jShuttle.planned) * 100), tolerance: 0.02 },
    source: "seeded memory, INC-0612",
  },
  {
    id: "mem-union-sq-elevator",
    category: "memory",
    question: "Is the elevator to the L platform at 14 St-Union Sq out of service right now?",
    expect: { kind: "yesno", value: "no" },
    source: "seeded memory, F-ELEV-1 (closed Oct 9, 2026)",
  },
);

const sg = network.stations.find((s) => s.name === "St George")!;
const ts = network.stations.find((s) => s.name.startsWith("Times Sq-42 St"))!;
questions.push(
  {
    id: "nig-staten-island",
    category: "not_in_graph",
    question: "Can a rider get from St George on Staten Island to Times Sq-42 St using only subway trains and the walking transfers in the subway network? Answer yes or no.",
    expect: { kind: "yesno", value: reachable(sg.id, ts.id) ? "yes" : "no" },
    source: "breadth-first search over data/nyc/network.json",
  },
  {
    id: "unk-hogwarts",
    category: "unknown_entity",
    question: "How many riders an hour are displaced if the Hogwarts Express is suspended between Kings Cross and Hogsmeade?",
    expect: { kind: "decline" },
    source: "no such route or stations in the network",
  },
  {
    id: "unk-penny-lane",
    category: "unknown_entity",
    question: "What is the fastest subway route from Penny Lane station to Times Sq-42 St?",
    expect: { kind: "decline" },
    source: "no such station in the network",
  },
);

mkdirSync("data/eval", { recursive: true });
writeFileSync("data/eval/questions.json", JSON.stringify(questions, null, 1) + "\n");
console.log(`${questions.length} questions:`, Object.entries(questions.reduce<Record<string, number>>((m, q) => ((m[q.category] = (m[q.category] ?? 0) + 1), m), {})));
