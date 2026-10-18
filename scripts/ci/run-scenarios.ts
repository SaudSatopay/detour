/**
 * End-to-end check of the graph tools without any LLM: seeds FalkorDB, then for each scenario
 * resolves names, closes the line, measures impact and capacity, tests shuttle plans, routes the
 * remembered riders, and cross-checks max flow against the independent NetworkX results in
 * data/nyc/verify: closed segments, max flow and its certificate, cut-off stations, headroom, and the
 * fastest-path reroute (riders with no path, overflow, overloaded segments), within TOLERANCE.
 * Writes every tool result to ci-out/ (used for UI fixtures and the proof page).
 *
 *   FALKORDB_URL=falkor://localhost:6379 pnpm tsx scripts/ci/run-scenarios.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "../../src/lib/graph/db";
import { ensureBaseGraphs } from "../../src/lib/graph/seed";
import { ensureSandbox, resetSandbox } from "../../src/lib/graph/tenancy";
import { Tracer } from "../../src/lib/graph/trace";
import { affectedRiders } from "../../src/lib/graph/tools/impact";
import { closeLine } from "../../src/lib/graph/tools/incident";
import {
  measureCapacity,
  measureHeadroom,
  shuttleCandidates,
  simulatePlan,
  type CapacityData,
  type Candidate,
  type HeadroomData,
} from "../../src/lib/graph/tools/capacity";
import { recall, remember } from "../../src/lib/graph/tools/memory";
import { resolvePlaces } from "../../src/lib/graph/tools/places";
import { listPlans, proposeSteering, publishPlan, resolveIncident } from "../../src/lib/graph/tools/plan";
import { ridersAffected, routeRider } from "../../src/lib/graph/tools/riders";
import type { ToolContext, ToolResult } from "../../src/lib/graph/tools/types";

interface Scenario {
  id: string;
  routes: string[];
  stations: string[];
}

const NAMES: Record<string, string[]> = {
  "l-canarsie": ["Bedford Av", "8 Av", "L"],
  "lex-express": ["Grand Central", "Brooklyn Bridge", "4", "5"],
  cranberry: ["High St", "Fulton St", "A"],
};

type Verify = {
  closedEids: number[];
  flow: Record<
    string,
    {
      requiredExact?: number;
      absorbedExact?: number;
      required: number;
      absorbed: number;
      unmet: number;
      cutOff?: { station: string; side: string; riders: number }[];
      headroom?: { multiplier: number | null; connected: number } | null;
    }
  >;
  reroute?: { stranded: number; overflow: number; overloaded: { eid?: number; pct: number }[] };
};

/** Tolerances for FalkorDB against NetworkX, stated once (docs/model.md, "Checking the numbers"). */
const TOLERANCE = {
  /** Riders an hour: both sides round sums of the same float riders. */
  riders: 1.5,
  /** Fastest-path overflow, riders an hour; ties between equally fast paths could move load. */
  overflowShare: 0.01,
  /** Overloaded segment percentages, points. */
  pct: 1,
  /** Headroom multiplier, relative. */
  headroom: 1e-3,
} as const;

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  await waitForDb();
  mkdirSync("ci-out", { recursive: true });

  const seedStarted = performance.now();
  await ensureBaseGraphs((m) => console.log(`seed: ${m}`), true);
  const seedMs = performance.now() - seedStarted;
  console.log(`seeded in ${(seedMs / 1000).toFixed(1)} s`);

  const scenarios = JSON.parse(readFileSync("data/scenarios.json", "utf8")) as Scenario[];
  const summary: Record<string, unknown> = { seedMs: Math.round(seedMs) };

  for (const [i, sc] of scenarios.entries()) {
    console.log(`\n== ${sc.id}`);
    const visitor = `ci${i}scenario${sc.id.replace(/[^a-z0-9]/g, "")}`.slice(0, 32);
    await resetSandbox(visitor);
    const sandbox = await ensureSandbox(visitor);
    const ctx = (): ToolContext => ({ visitorId: visitor, sandbox: sandbox.graph, agentId: "controller", tracer: new Tracer() });
    const results: Record<string, ToolResult> = {};
    const keep = (name: string, r: ToolResult) => {
      results[name] = r;
      const ms = r.trace.reduce((s, t) => s + t.ms, 0);
      console.log(`  ${name}: ${r.outcome} (${r.trace.length} queries, ${ms.toFixed(0)} ms) ${r.summary.slice(0, 220)}`);
      return r;
    };

    keep("resolve", await resolvePlaces(ctx(), { names: NAMES[sc.id] ?? [] }));
    keep("unknown", await resolvePlaces(ctx(), { names: ["Hogwarts Station"] }));
    check(results.unknown.outcome === "unknown_entity", "an unknown station is reported as unknown_entity");

    const closed = keep("close", await closeLine(ctx(), { routes: sc.routes, fromStation: sc.stations[0], toStation: sc.stations[sc.stations.length - 1], report: `CI closure for ${sc.id}` }));
    const verify = JSON.parse(readFileSync(`data/nyc/verify/${sc.id}.json`, "utf8")) as Verify;
    const closedEids = ((closed.data as { incident: { closedEids: number[] } }).incident?.closedEids ?? []).slice().sort((a, b) => a - b);
    check(JSON.stringify(closedEids) === JSON.stringify([...verify.closedEids].sort((a, b) => a - b)), `closed segments match NetworkX (${closedEids.length})`);

    keep("affected", await affectedRiders(ctx(), { depth: 4 }));
    keep("recall", await recall(ctx(), { routes: sc.routes, stations: sc.stations }));

    const cap = keep("capacity", await measureCapacity(ctx()));
    const capData = cap.data as CapacityData;
    for (const d of capData.directions) {
      const v = verify.flow[d.direction];
      if (!v) {
        check(false, `NetworkX has a ${d.direction} group`);
        continue;
      }
      const vr = v.requiredExact ?? v.required;
      const va = v.absorbedExact ?? v.absorbed;
      check(Math.abs(d.required - vr) <= TOLERANCE.riders, `${d.direction} required ${d.required} vs NetworkX ${vr.toFixed(1)}`);
      check(Math.abs(d.absorbed - va) <= TOLERANCE.riders, `${d.direction} max flow ${d.absorbed} vs NetworkX ${va.toFixed(1)}`);
      check(d.check.checked, `${d.direction} max flow certified (${d.check.solver}${d.check.solver === "dinic" ? `; algo.maxFlow returned ${d.check.falkordb.value}` : ""})`);
      if (v.cutOff) {
        const mine = d.cutOff.map((s) => `${s.side}:${s.id}`).sort();
        const theirs = v.cutOff.map((s) => `${s.side}:${s.station}`).sort();
        check(JSON.stringify(mine) === JSON.stringify(theirs), `${d.direction} cut-off stations ${mine.join(" ") || "none"} vs NetworkX ${theirs.join(" ") || "none"}`);
      }
    }
    if (verify.reroute) {
      const re = capData.reroute;
      const v = verify.reroute;
      check(Math.abs(re.stranded - v.stranded) <= TOLERANCE.riders, `riders with no path ${re.stranded} vs NetworkX ${v.stranded}`);
      check(Math.abs(re.overflow - v.overflow) <= Math.max(TOLERANCE.riders, v.overflow * TOLERANCE.overflowShare), `fastest-path overflow ${re.overflow} vs NetworkX ${v.overflow}`);
      const pcts = (rows: { pct: number }[]) => rows.map((o) => o.pct).sort((a, b) => b - a);
      const mine = pcts(re.overloaded);
      const theirs = pcts(v.overloaded);
      check(
        mine.length === theirs.length && mine.every((p, i) => Math.abs(p - theirs[i]) <= TOLERANCE.pct),
        `overloaded segments ${mine.map((p) => `${p}%`).join(", ") || "none"} vs NetworkX ${theirs.map((p) => `${p}%`).join(", ") || "none"}`,
      );
    }

    const head = keep("headroom", await measureHeadroom(ctx()));
    const headData = head.data as HeadroomData | null;
    for (const h of headData?.directions ?? []) {
      const v = verify.flow[h.direction]?.headroom;
      if (v === undefined) continue;
      const same =
        (h.multiplier === null && (v === null || v.multiplier === null)) ||
        (h.multiplier !== null && v !== null && v.multiplier !== null && Math.abs(h.multiplier - v.multiplier) <= TOLERANCE.headroom * v.multiplier + 1e-3);
      check(same, `${h.direction} headroom ${h.multiplier ?? "beyond scale"} vs NetworkX ${v?.multiplier ?? "beyond scale"} (${h.solves} solves, ${h.recomputed} recomputed)`);
    }

    const cands = keep("candidates", await shuttleCandidates(ctx(), { maxKm: 2.5 }));
    const list = (cands.data as { candidates: Candidate[] } | null)?.candidates ?? [];
    if (list.length) {
      const top = list[0];
      keep("plan-1", await simulatePlan(ctx(), { shuttles: [{ from: top.fromId, to: top.toId, busesPerHour: top.suggestedBusesPerHour }] }));
      const second = list.find((c) => c.fromId !== top.fromId);
      if (second) {
        keep(
          "plan-2",
          await simulatePlan(ctx(), {
            shuttles: [
              { from: top.fromId, to: top.toId, busesPerHour: top.suggestedBusesPerHour },
              { from: second.fromId, to: second.toId, busesPerHour: second.suggestedBusesPerHour },
            ],
          }),
        );
      }
    }

    const plans = await listPlans(ctx());
    if (plans[0]) keep("publish", await publishPlan(ctx(), { planId: plans[plans.length - 1].id, approvedBy: "ci" }));
    keep("steer", await proposeSteering(ctx()));
    const affected = keep("riders-affected", await ridersAffected(ctx()));
    for (const r of (affected.data as { affected: { id: string; stepFree: boolean }[] }).affected) {
      keep(`route-${r.id}`, await routeRider(ctx(), { riderId: r.id, stepFree: r.stepFree }));
    }
    keep("route-aisha-stepfree", await routeRider(ctx(), { riderId: "aisha", stepFree: true }));
    keep("route-staten-island", await routeRider(ctx(), { from: "501", to: "611" }));

    const memo = keep("remember", await remember(ctx(), { text: `CI: ${sc.id} closure measured; see capacity result.`, kind: "observation", routes: sc.routes, stations: [sc.stations[0]] }));
    keep(
      "supersede",
      await remember(ctx(), {
        text: `CI: ${sc.id} measurement replaced by a newer one.`,
        kind: "observation",
        routes: sc.routes,
        supersedes: (memo.data as { id: string }).id,
      }),
    );
    keep("resolve-incident", await resolveIncident(ctx()));

    writeFileSync(`ci-out/${sc.id}.json`, JSON.stringify(results, null, 1));
    summary[sc.id] = {
      displaced: capData.displacedRiders,
      overflow: capData.reroute.overflow,
      stranded: capData.reroute.stranded,
      directions: capData.directions.map((d) => ({
        direction: d.direction,
        required: d.required,
        absorbed: d.absorbed,
        unmet: d.unmet,
        cut: d.cut.length,
        cutOff: d.cutOff,
        check: { ...d.check, falkordb: { ...d.check.falkordb, problems: d.check.falkordb.problems.slice(0, 2) } },
        headroom: headData?.directions.find((h) => h.direction === d.direction) ?? null,
      })),
      overloaded: capData.reroute.overloaded.slice(0, 6).map((o) => ({ route: o.route, from: o.from, to: o.to, pct: o.pct })),
      queries: Object.values(results).reduce((s, r) => s + r.trace.length, 0),
    };
  }

  writeFileSync("ci-out/summary.json", JSON.stringify(summary, null, 2));
  console.log(`\n${JSON.stringify(summary, null, 2)}`);
  await (await connect()).close();
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
}

async function waitForDb() {
  const until = Date.now() + 90_000;
  for (;;) {
    try {
      await (await connect()).list();
      return;
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
