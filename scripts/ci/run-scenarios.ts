/**
 * End-to-end check of the graph tools without any LLM: seeds FalkorDB, then for each scenario
 * resolves names, closes the line, measures impact and capacity, tests shuttle plans, routes the
 * remembered riders, and cross-checks max flow against the independent NetworkX results in
 * data/nyc/verify. Writes every tool result to ci-out/ (used for UI fixtures and the proof page).
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
import { measureCapacity, shuttleCandidates, simulatePlan, type CapacityData, type Candidate } from "../../src/lib/graph/tools/capacity";
import { recall, remember } from "../../src/lib/graph/tools/memory";
import { resolvePlaces } from "../../src/lib/graph/tools/places";
import { listPlans, publishPlan, resolveIncident } from "../../src/lib/graph/tools/plan";
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
  flow: Record<string, { requiredExact?: number; absorbedExact?: number; required: number; absorbed: number; unmet: number }>;
};

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
      check(Math.abs(d.required - vr) <= 1.5, `${d.direction} required ${d.required} vs NetworkX ${vr.toFixed(1)}`);
      check(Math.abs(d.absorbed - va) <= 1.5, `${d.direction} max flow ${d.absorbed} vs NetworkX ${va.toFixed(1)}`);
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
      directions: capData.directions.map((d) => ({ direction: d.direction, required: d.required, absorbed: d.absorbed, unmet: d.unmet, cut: d.cut.length })),
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
