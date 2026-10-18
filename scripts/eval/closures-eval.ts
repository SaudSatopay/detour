/**
 * Held-out evaluation on closures nobody tuned for. Draws random line closures with a fixed seed
 * (2 to 6 segments, across every line; src/lib/graph/flow.ts, heldOutClosures), runs each through
 * the scripted controller on FalkorDB and through the independent NetworkX verifier, and compares:
 * closed segments, displaced riders, max flow per direction (with its certificate), riders with no
 * path, fastest-path overflow, cut-off stations and headroom. It then checks the controller's plan
 * choice against a brute-force oracle that simulates every shuttle candidate on its own fork and
 * keeps the best gain per bus. Also reruns the algo.maxFlow reproduction (scripts/judge/maxflow-repro.ts).
 *
 *   FALKORDB_URL=falkor://127.0.0.1:6380 pnpm tsx scripts/eval/closures-eval.ts [--count 48] [--seed 20261019]
 *
 * Writes data/eval/closures.json. Needs uv for the verifier. Exits non-zero when FalkorDB and
 * NetworkX disagree on closed segments, displaced riders, max flow or riders with no path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentEvent } from "../../src/lib/agent/catalog";
import { scriptedControl } from "../../src/lib/agent/scripted";
import { connect } from "../../src/lib/graph/db";
import { choosePlan, heldOutClosures, planFits, planGain, policyGap, type ClosureSpec } from "../../src/lib/graph/flow";
import { ensureBaseGraphs } from "../../src/lib/graph/seed";
import { ensureSandbox, resetSandbox } from "../../src/lib/graph/tenancy";
import { Tracer } from "../../src/lib/graph/trace";
import { measureCapacity, measureHeadroom, simulatePlan, type CapacityData, type Candidate, type HeadroomData, type PlanData } from "../../src/lib/graph/tools/capacity";
import { closeLine } from "../../src/lib/graph/tools/incident";
import type { ImpactData } from "../../src/lib/graph/tools/impact";
import type { RecallData } from "../../src/lib/graph/tools/memory";
import type { ToolContext, ToolResult } from "../../src/lib/graph/tools/types";
import type { Network } from "../../src/lib/network/types";
import { reproduce } from "../judge/maxflow-repro";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const COUNT = arg("count", 48);
const SEED = arg("seed", 20261019);
const OUT = "data/eval/closures.json";
const TOL = { riders: 1.5, overflowShare: 0.01, headroom: 1e-3 };

interface NxDirection {
  required: number;
  absorbed: number;
  unmet: number;
  cutOff: { station: string; side: string; riders: number }[];
  headroom: { multiplier: number | null } | null;
}
interface NxClosure {
  closedEids: number[];
  displaced: number;
  flow: Record<string, NxDirection>;
  reroute: { stranded: number; overflow: number; overloaded: number; overflowRange: { min: number; max: number; tieBreaks: number } };
}

interface Row {
  id: string;
  title: string;
  routes: string[];
  stations: string[];
  segments: number;
  falkordb: {
    closed: number;
    displaced: number;
    noPath: number;
    overflow: number;
    directions: { direction: string; required: number; absorbed: number; solver: string; checked: boolean; falkordbValue: number; cutOff: string[] }[];
    headroom: Record<string, number | null>;
    headroomSolves: number;
    headroomRecomputed: number;
  };
  networkx: { closed: number; displaced: number; noPath: number; overflow: number; overflowRange: { min: number; max: number }; directions: Record<string, { required: number; absorbed: number; cutOff: string[]; headroom: number | null }> };
  agree: Record<Metric, boolean>;
  diff: Partial<Record<Metric, number>>;
  policy: {
    needsBuses: boolean;
    chosen: { label: string; gain: number; vehicles: number; perBus: number } | null;
    oracle: { label: string; gain: number; vehicles: number; perBus: number } | null;
    candidatesTried: number;
    gap: number;
  };
}

const METRICS = ["closedSegments", "displaced", "maxFlow", "noPath", "overflow", "cutOff", "headroom", "certified"] as const;
type Metric = (typeof METRICS)[number];
/** Metrics whose disagreement fails the run; the rest are reported. */
const CORE: Metric[] = ["closedSegments", "displaced", "maxFlow", "noPath", "certified"];

function runVerifier(closures: ClosureSpec[]): Record<string, NxClosure> {
  mkdirSync("ci-out", { recursive: true });
  writeFileSync("ci-out/closures-scenarios.json", JSON.stringify(closures, null, 1));
  execFileSync(
    "uv",
    ["run", "--with", "networkx", "python", "scripts/verify/verify.py", "data/nyc", "ci-out/closures-scenarios.json", "ci-out/verify-closures", "--summary", "ci-out/closures-networkx.json"],
    { stdio: "inherit" },
  );
  return (JSON.parse(readFileSync("ci-out/closures-networkx.json", "utf8")) as { closures: Record<string, NxClosure> }).closures;
}

async function evaluate(spec: ClosureSpec, nx: NxClosure, visitor: string): Promise<Row> {
  await resetSandbox(visitor);
  const sandbox = await ensureSandbox(visitor);
  const base = { visitorId: visitor, sandbox: sandbox.graph };
  const ctx = (): ToolContext => ({ ...base, agentId: "controller", tracer: new Tracer() });

  // The controller's own procedure, read-only: every tool result it emits is captured here.
  const results: ToolResult[] = [];
  const inputs = new Map<string, unknown>();
  await scriptedControl({ ...base, agentId: "controller" }, { ...spec }, (event: AgentEvent) => {
    if (event.type === "tool-call") inputs.set(event.id, event.input);
    if (event.type === "tool-result") results.push(event.result);
  });
  const find = <T>(tool: string) => results.filter((r) => r.tool === tool).map((r) => r.data as T);
  const close = find<{ incident: { closedEids: number[] } | null }>("close_line")[0];
  const impact = find<ImpactData | null>("affected_riders")[0];
  const cap = find<CapacityData | null>("measure_capacity")[0];
  const candidates = find<{ candidates: Candidate[] } | null>("shuttle_candidates")[0]?.candidates ?? [];
  const plans = find<PlanData | null>("simulate_plan").filter((p): p is PlanData => Boolean(p));
  const head = (await measureHeadroom(ctx())).data as HeadroomData | null;

  const closed = [...(close?.incident?.closedEids ?? [])].sort((a, b) => a - b);
  const dirs = cap?.directions ?? [];
  const cutOffKeys = (list: { id?: string; station?: string; side: string }[]) => list.map((s) => `${s.side}:${s.id ?? s.station}`).sort();
  const falkordb: Row["falkordb"] = {
    closed: closed.length,
    displaced: impact?.totalRiders ?? 0,
    noPath: cap?.reroute.stranded ?? 0,
    overflow: cap?.reroute.overflow ?? 0,
    directions: dirs.map((d) => ({
      direction: d.direction,
      required: d.required,
      absorbed: d.absorbed,
      solver: d.check.solver,
      checked: d.check.checked,
      falkordbValue: Math.round(d.check.falkordb.value * 10) / 10,
      cutOff: cutOffKeys(d.cutOff),
    })),
    headroom: Object.fromEntries((head?.directions ?? []).map((h) => [h.direction, h.multiplier])),
    headroomSolves: (head?.directions ?? []).reduce((s, h) => s + h.solves, 0),
    headroomRecomputed: (head?.directions ?? []).reduce((s, h) => s + h.recomputed, 0),
  };
  const networkx: Row["networkx"] = {
    closed: nx.closedEids.length,
    displaced: nx.displaced,
    noPath: nx.reroute.stranded,
    overflow: nx.reroute.overflow,
    overflowRange: { min: nx.reroute.overflowRange.min, max: nx.reroute.overflowRange.max },
    directions: Object.fromEntries(
      Object.entries(nx.flow).map(([d, f]) => [d, { required: f.required, absorbed: f.absorbed, cutOff: cutOffKeys(f.cutOff), headroom: f.headroom?.multiplier ?? null }]),
    ),
  };

  const diff: Row["diff"] = {};
  const agree = {} as Row["agree"];
  agree.closedSegments = JSON.stringify(closed) === JSON.stringify(nx.closedEids);
  diff.displaced = Math.abs(falkordb.displaced - nx.displaced);
  agree.displaced = diff.displaced <= TOL.riders;
  // A direction FalkorDB skips has no displaced riders to move; NetworkX then reports zeros.
  const flowDiff = Object.entries(nx.flow).map(([d, f]) => {
    const mine = dirs.find((x) => x.direction === d);
    return Math.max(Math.abs((mine?.required ?? 0) - f.required), Math.abs((mine?.absorbed ?? 0) - f.absorbed));
  });
  diff.maxFlow = Math.max(0, ...flowDiff);
  agree.maxFlow = diff.maxFlow <= TOL.riders;
  diff.noPath = Math.abs(falkordb.noPath - nx.reroute.stranded);
  agree.noPath = diff.noPath <= TOL.riders;
  // Equally fast paths make the all-or-nothing assignment non-unique, so FalkorDB's overflow
  // agrees when it matches NetworkX or lies in the range NetworkX finds across tie-breaks.
  const { min, max } = nx.reroute.overflowRange;
  const slack = Math.max(TOL.riders, nx.reroute.overflow * TOL.overflowShare);
  diff.overflow = Math.abs(falkordb.overflow - nx.reroute.overflow);
  agree.overflow = diff.overflow <= slack || (falkordb.overflow >= min - slack && falkordb.overflow <= max + slack);
  agree.cutOff = dirs.every((d) => JSON.stringify(cutOffKeys(d.cutOff)) === JSON.stringify(networkx.directions[d.direction]?.cutOff ?? []));
  agree.headroom = (head?.directions ?? []).every((h) => {
    const v = networkx.directions[h.direction]?.headroom ?? null;
    return h.multiplier === null ? v === null : v !== null && Math.abs(h.multiplier - v) <= TOL.headroom * v + 1e-3;
  });
  agree.certified = dirs.every((d) => d.check.checked) && (head?.directions ?? []).every((h) => h.checked);

  // Policy against the oracle: every candidate leg alone, sized as the controller sized its legs.
  const needsBuses = Boolean(cap && (cap.reroute.stranded > 0 || cap.directions.some((d) => d.unmet > 0)));
  const perBus = (p: PlanData) => (p.vehicles ? planGain(p) / p.vehicles : 0);
  const label = (p: PlanData) => p.shuttles.map((s) => `${s.from}↔${s.to}@${s.busesPerHour}`).join(" + ");
  // The controller's own choice rule (choosePlan), so the eval cannot drift from it.
  const best = choosePlan(plans) ?? null;
  const chosen = best ? { label: label(best), gain: planGain(best), vehicles: best.vehicles, perBus: perBus(best) } : null;
  let oracle: Row["policy"]["oracle"] = null;
  let tried = 0;
  if (needsBuses && candidates.length) {
    // The controller adds buses when remembered shuttles carried less than planned (scripted.ts,
    // shuttleRatio): the lowest observed/planned ratio below 0.97. Same rule here.
    const memory = results.find((r) => r.tool === "recall_memory" && r.outcome === "memory")?.data as RecallData | undefined;
    const ratios = (memory?.incidents ?? []).flatMap((i) => i.shuttles.filter((s) => s.planned && s.observed).map((s) => s.observed / s.planned));
    const ratio = ratios.length && Math.min(...ratios) < 0.97 ? Math.min(...ratios) : 1;
    for (const c of candidates) {
      // Sized as the controller sizes a leg: the raw estimate with memory's correction, then, if its busier direction
      // runs over its seats, the buses its riders need with the same correction.
      const bph = Math.min(60, Math.ceil(c.suggestedBusesPerHour / ratio));
      let r = await simulatePlan(ctx(), { shuttles: [{ from: c.fromId, to: c.toId, busesPerHour: bph }], label: "oracle" });
      tried++;
      const peak = r.data?.shuttles[0]?.peak;
      if (r.data && !planFits(r.data) && peak) {
        const sized = Math.min(60, Math.max(bph, Math.ceil(peak.busesPerHour / ratio)));
        r = await simulatePlan(ctx(), { shuttles: [{ from: c.fromId, to: c.toId, busesPerHour: sized }], label: "oracle, sized" });
        tried++;
      }
      if (!r.data || planGain(r.data) <= 0) continue;
      const row = { label: label(r.data), gain: planGain(r.data), vehicles: r.data.vehicles, perBus: perBus(r.data) };
      if (!oracle || row.perBus > oracle.perBus) oracle = row;
    }
  }
  return {
    id: spec.id,
    title: spec.title,
    routes: spec.routes,
    stations: spec.stations,
    segments: spec.stations.length - 1,
    falkordb,
    networkx,
    agree,
    diff,
    policy: { needsBuses, chosen, oracle, candidatesTried: tried, gap: policyGap(chosen?.perBus ?? null, oracle?.perBus ?? null) },
  };
}

/**
 * The three preset closures through measure_capacity and measure_headroom: each direction's max
 * flow with its certificate, the cut-off stations, and the headroom with the segments that fill
 * first. The proof page shows these next to the held-out numbers.
 */
async function presets(visitor: string) {
  const scenarios = JSON.parse(readFileSync("data/scenarios.json", "utf8")) as ClosureSpec[];
  const out = [];
  for (const sc of scenarios) {
    await resetSandbox(visitor);
    const sandbox = await ensureSandbox(visitor);
    const ctx = (): ToolContext => ({ visitorId: visitor, sandbox: sandbox.graph, agentId: "controller", tracer: new Tracer() });
    await closeLine(ctx(), { routes: sc.routes, fromStation: sc.stations[0], toStation: sc.stations[sc.stations.length - 1], report: sc.report, title: sc.title });
    const cap = await measureCapacity(ctx());
    const head = await measureHeadroom(ctx());
    const capData = cap.data as CapacityData;
    const headData = head.data as HeadroomData | null;
    // The README's recommended shuttle on the L, re-measured for the proof page.
    const plan = sc.id === "l-canarsie" ? ((await simulatePlan(ctx(), { shuttles: [{ from: "119", to: "407", busesPerHour: 25 }], label: "README plan" })).data as PlanData | null) : null;
    out.push({
      id: sc.id,
      title: sc.title,
      summary: cap.summary,
      headroomSummary: head.summary,
      displaced: capData.displacedRiders,
      noPath: capData.reroute.stranded,
      overflow: capData.reroute.overflow,
      overloaded: capData.reroute.overloaded.map((o) => ({ route: o.route, from: o.from, to: o.to, pct: o.pct })),
      plan: plan ? { shuttles: plan.shuttles, vehicles: plan.vehicles, before: plan.before, after: plan.after } : null,
      directions: capData.directions.map((d) => {
        const h = headData?.directions.find((x) => x.direction === d.direction);
        return {
          direction: d.direction,
          required: d.required,
          absorbed: d.absorbed,
          check: { ...d.check, falkordb: { ...d.check.falkordb, problems: d.check.falkordb.problems.slice(0, 2) } },
          openSegmentsInCut: d.cut.length,
          cutOff: d.cutOff,
          headroom: h ? { multiplier: h.multiplier, connected: h.connected, solves: h.solves, recomputed: h.recomputed, checked: h.checked, saturating: h.saturating.slice(0, 3) } : null,
        };
      }),
    });
    console.log(`preset ${sc.id}: ${capData.directions.map((d) => `${d.direction} ${d.absorbed}/${d.required} ${d.check.solver}${d.check.checked ? " checked" : " UNCHECKED"}`).join(", ")}`);
  }
  await resetSandbox(visitor);
  return out;
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  await connect();
  await ensureBaseGraphs((m) => console.log(`seed: ${m}`), false);
  if (process.argv.includes("--presets-only")) {
    const report = JSON.parse(readFileSync(OUT, "utf8")) as Record<string, unknown>;
    report.presets = await presets("evalpresets");
    writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
    console.log(`updated presets in ${OUT}`);
    await (await connect()).close();
    return;
  }
  const presetRows = await presets("evalpresets");
  const network = JSON.parse(readFileSync("data/nyc/network.json", "utf8")) as Network;
  const closures = heldOutClosures(network, COUNT, SEED);
  console.log(`${closures.length} held-out closures on ${new Set(closures.map((c) => c.routes[0])).size} lines (seed ${SEED})`);
  const nx = runVerifier(closures);

  const repro = await reproduce(100, 7);
  console.log(`${repro.engine}: Chokepoint network ${repro.chokepoint.falkordb} (exact ${repro.chokepoint.exact}); random split networks wrong ${repro.random.wrong}/${repro.random.networks}`);

  const rows: Row[] = [];
  const started = performance.now();
  for (const spec of closures) {
    const row = await evaluate(spec, nx[spec.id], "evalheldout");
    rows.push(row);
    const bad = METRICS.filter((m) => !row.agree[m]);
    console.log(
      `${spec.id} ${spec.title}: displaced ${row.falkordb.displaced}, no path ${row.falkordb.noPath}, ` +
        `max flow ${row.falkordb.directions.map((d) => `${d.absorbed}/${d.required}${d.solver === "dinic" ? "*" : ""}`).join(" ")}` +
        `${row.policy.needsBuses ? `, policy gap ${(row.policy.gap * 100).toFixed(0)}%` : ""}${bad.length ? `  DISAGREE ${bad.join(", ")}` : ""}`,
    );
  }
  await resetSandbox("evalheldout");

  const rate = (m: Metric) => {
    const agreeing = rows.filter((r) => r.agree[m]).length;
    return { agree: agreeing, total: rows.length, rate: Math.round((agreeing / Math.max(1, rows.length)) * 1000) / 1000 };
  };
  const worst = (m: Metric) =>
    rows
      .filter((r) => (r.diff[m] ?? 0) > 0 || !r.agree[m])
      .sort((a, b) => (b.diff[m] ?? 0) - (a.diff[m] ?? 0))
      .slice(0, 3)
      .map((r) => ({ id: r.id, title: r.title, diff: Math.round((r.diff[m] ?? 0) * 10) / 10, agree: r.agree[m] }));
  const needing = rows.filter((r) => r.policy.needsBuses);
  const directions = rows.flatMap((r) => r.falkordb.directions);
  const report = {
    generatedAt: new Date().toISOString(),
    engine: repro.engine,
    seed: SEED,
    count: rows.length,
    lines: [...new Set(rows.map((r) => r.routes[0]))].sort(),
    segments: { min: Math.min(...rows.map((r) => r.segments)), max: Math.max(...rows.map((r) => r.segments)) },
    tolerance: { riders: TOL.riders, overflowShare: TOL.overflowShare, headroomRelative: TOL.headroom, closedSegments: "identical sets", cutOff: "identical sets" },
    agreement: Object.fromEntries(METRICS.map((m) => [m, rate(m)])),
    overflowDetail: {
      sameAsNetworkx: rows.filter((r) => (r.diff.overflow ?? 0) <= Math.max(TOL.riders, r.networkx.overflow * TOL.overflowShare)).length,
      withinTieRange: rows.filter((r) => r.agree.overflow).length,
      tieSensitive: rows.filter((r) => r.networkx.overflowRange.min !== r.networkx.overflowRange.max).length,
      note: "overflow depends on which of several equally fast paths each pair takes; NetworkX reports the range over 8 random tie-breaks (1e-7 min per edge)",
    },
    worst: Object.fromEntries(METRICS.filter((m) => m !== "closedSegments" && m !== "cutOff" && m !== "certified").map((m) => [m, worst(m)])),
    certificates: {
      maxFlowRuns: directions.length,
      falkordbPassed: directions.filter((d) => d.solver === "falkordb").length,
      recomputedByDinic: directions.filter((d) => d.solver === "dinic").length,
      allChecked: directions.every((d) => d.checked),
      headroomSolves: rows.reduce((s, r) => s + r.falkordb.headroomSolves, 0),
      headroomRecomputed: rows.reduce((s, r) => s + r.falkordb.headroomRecomputed, 0),
    },
    maxFlowRepro: repro,
    presets: presetRows,
    policy: {
      oracle: "every shuttle candidate the controller saw, simulated alone on its own fork at the controller's sizing; best gain per bus (riders with no path plus max-flow shortfall cleared, per bus on the road)",
      closures: rows.length,
      needingBuses: needing.length,
      optimal: needing.filter((r) => r.policy.gap < 1e-9).length,
      meanGap: needing.length ? Math.round((needing.reduce((s, r) => s + r.policy.gap, 0) / needing.length) * 1000) / 1000 : 0,
      maxGap: Math.max(0, ...needing.map((r) => r.policy.gap)),
      worst: needing
        .filter((r) => r.policy.gap > 0)
        .sort((a, b) => b.policy.gap - a.policy.gap)
        .slice(0, 3)
        .map((r) => ({ id: r.id, title: r.title, gap: Math.round(r.policy.gap * 1000) / 1000, chosen: r.policy.chosen, oracle: r.policy.oracle })),
    },
    seconds: Math.round((performance.now() - started) / 1000),
    closures: rows,
  };
  mkdirSync("data/eval", { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  console.log(`\nagreement: ${METRICS.map((m) => `${m} ${report.agreement[m].agree}/${report.agreement[m].total}`).join(", ")}`);
  console.log(
    `certificates: ${report.certificates.falkordbPassed}/${report.certificates.maxFlowRuns} FalkorDB answers passed, ${report.certificates.recomputedByDinic} recomputed; headroom solves ${report.certificates.headroomSolves} (${report.certificates.headroomRecomputed} recomputed)`,
  );
  console.log(`policy: optimal on ${report.policy.optimal} of ${report.policy.needingBuses} closures that need buses; mean gap ${report.policy.meanGap}, max ${report.policy.maxGap}`);
  console.log(`wrote ${OUT}`);
  await (await connect()).close();
  const failed = CORE.filter((m) => report.agreement[m].agree < report.agreement[m].total);
  if (failed.length) {
    console.error(`\nFalkorDB and NetworkX disagree on ${failed.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
