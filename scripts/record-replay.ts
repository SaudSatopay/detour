/**
 * Records what the app plays back when the graph database is unreachable: for each preset scenario,
 * the scripted controller run, the approval that publishes its recommended plan with the rider
 * desk's advisories, and the sandbox state afterwards. Every event comes from real tool calls on
 * FalkorDB; nothing is written by hand.
 *
 *   FALKORDB_URL=falkor://localhost:6379 pnpm tsx scripts/record-replay.ts [scenario ...]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AgentEvent, Emit } from "../src/lib/agent/catalog";
import { publishAndAdvise } from "../src/lib/agent/publish";
import { scriptedControl } from "../src/lib/agent/scripted";
import { connect } from "../src/lib/graph/db";
import { ensureBaseGraphs } from "../src/lib/graph/seed";
import { sandboxState } from "../src/lib/graph/state";
import { ensureSandbox, resetSandbox } from "../src/lib/graph/tenancy";
import { loadScenarios } from "../src/lib/network/data";

const OUT = "data/replays";

function tape(): { emit: Emit; lines: () => string } {
  const started = Date.now();
  const rows: { t: number; event: AgentEvent }[] = [];
  return {
    emit: (event) => rows.push({ t: Date.now() - started, event }),
    lines: () => rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  };
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  await connect();
  await ensureBaseGraphs((m) => console.log(`seed: ${m}`), false);
  mkdirSync(OUT, { recursive: true });
  const only = process.argv.slice(2);
  const scenarios = (await loadScenarios()).filter((s) => !only.length || only.includes(s.id));

  for (const sc of scenarios) {
    const visitor = `recorder${sc.id.replace(/[^a-z0-9]/g, "")}`.slice(0, 32);
    await resetSandbox(visitor);
    const sandbox = await ensureSandbox(visitor);
    const base = { visitorId: visitor, sandbox: sandbox.graph };

    const control = tape();
    control.emit({ type: "run", runId: `rec-${sc.id}`, agent: "controller", mode: "scripted" });
    const started = performance.now();
    const out = await scriptedControl({ ...base, agentId: "controller" }, sc, control.emit);
    control.emit({ type: "done", agent: "controller", text: out.brief, steps: out.steps, model: null });
    writeFileSync(`${OUT}/${sc.id}-control.ndjson`, control.lines());
    console.log(`${sc.id}: control ${out.steps} tool calls in ${((performance.now() - started) / 1000).toFixed(1)} s, plan ${out.planId}`);

    if (out.planId) {
      const publish = tape();
      publish.emit({ type: "run", runId: `rec-${sc.id}-publish`, agent: "rider-desk", mode: "scripted" });
      await publishAndAdvise(base, out.planId, publish.emit);
      writeFileSync(`${OUT}/${sc.id}-publish.ndjson`, publish.lines());
      console.log(`${sc.id}: published ${out.planId}`);
    }

    const state = await sandboxState(visitor);
    writeFileSync(`${OUT}/${sc.id}-state.json`, JSON.stringify(state, null, 1) + "\n");
    console.log(`${sc.id}: state with ${state.plans.length} plans, ${state.findings.length} findings, ${state.episodes.length} episodes`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
