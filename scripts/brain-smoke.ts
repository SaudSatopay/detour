/**
 * Checks the agency brain against a real FalkorDB: copies the template into a scratch graph, installs
 * the org layer twice (the second is a no-op), answers the suggested questions with the standard
 * procedure, reports an elevator fixed and checks its ticket and decision follow, then deletes the copy.
 *   tsx scripts/brain-smoke.ts
 */
import { existsSync } from "node:fs";
import { answerBrain } from "../src/lib/agent/brain";
import { connect, copyGraph, deleteGraph, listGraphs, run } from "../src/lib/graph/db";
import { TEMPLATE_GRAPH } from "../src/lib/graph/names";
import { ensureOrgLayer } from "../src/lib/graph/org";
import { BRAIN_SUGGESTIONS } from "../src/lib/graph/seed-org";
import { Tracer } from "../src/lib/graph/trace";
import { brainDirectory, traceDecision, whatsChanged } from "../src/lib/graph/tools/brain";
import { reportElevator } from "../src/lib/graph/tools/memory";

const SCRATCH = "detour:brain-smoke";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  if ((await listGraphs()).includes(SCRATCH)) await deleteGraph(SCRATCH);
  await copyGraph(TEMPLATE_GRAPH, SCRATCH);
  const base = { visitorId: "smoketest0001", sandbox: SCRATCH, agentId: "brain" };
  const ctx = () => ({ ...base, tracer: new Tracer() });
  try {
    let t = performance.now();
    await ensureOrgLayer(SCRATCH);
    console.log(`install: ${(performance.now() - t).toFixed(0)} ms`);
    t = performance.now();
    await ensureOrgLayer(SCRATCH);
    console.log(`second install (no-op): ${(performance.now() - t).toFixed(0)} ms`);

    const dir = await brainDirectory(ctx());
    console.log("counts", JSON.stringify(dir.counts));
    for (const team of dir.teams) console.log(`  ${team.name}: ${team.people.map((p) => p.name).join(", ")} | owns ${team.owns.map((o) => o.label).join(" ")}`);
    console.log("open tickets", dir.openTickets.map((s) => `${s.id} (${s.status})`).join(", "));
    console.log("decisions", dir.decisions.map((s) => `${s.id} ${s.status} by ${s.by}`).join(" | "));

    for (const q of [...BRAIN_SUGGESTIONS, "Is the Myrtle-Wyckoff L elevator working?", "Who owns the L?", "Why did we add two G trains?"]) {
      const a = await answerBrain(base, q, { live: false });
      console.log(`\nQ: ${q}\n[${a.steps.map((s) => `${s.tool}:${s.outcome}:${s.trace.length}q`).join(" → ")}] ${a.ms} ms\nA: ${a.answer}\n   sources: ${a.sources.map((s, i) => `[${i + 1}] ${s.id}`).join(" ")}`);
    }

    const fixed = await reportElevator({ ...base, agentId: "rider-desk", tracer: new Tracer() }, { station: "630", stationName: "Myrtle-Wyckoff Avs", route: "L", working: true });
    console.log(`\nreport fixed: ${fixed.summary}`);
    const ticket = await run<{ status: string }>(SCRATCH, "MATCH (k:Ticket {id: 'EE-1207'}) RETURN k.status AS status");
    const decision = (await traceDecision(ctx(), { query: "DEC-1014-SF" })).data.decision;
    console.log(`EE-1207 is ${ticket.rows[0]?.status}; DEC-1014-SF is ${decision?.status}`);
    const changes = await whatsChanged(ctx(), { days: 1 });
    console.log(`changes today: ${changes.summary}`);
    const broke = await reportElevator({ ...base, agentId: "rider-desk", tracer: new Tracer() }, { station: "630", stationName: "Myrtle-Wyckoff Avs", route: "L", working: false });
    const again = await run<{ status: string }>(SCRATCH, "MATCH (k:Ticket {id: 'EE-1207'}) RETURN k.status AS status");
    console.log(`report broken again: ${broke.summary} → EE-1207 is ${again.rows[0]?.status}`);
  } finally {
    await deleteGraph(SCRATCH);
    await (await connect()).close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
