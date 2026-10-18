/**
 * Builds the agency graph from the committed snapshot in a scratch graph on a real FalkorDB, checks that a second
 * pass changes nothing, refreshes it from the live feeds, prints what it holds and how much memory it takes,
 * and lists the current outages for step-free routing. Deletes the scratch graph afterwards.
 *   FALKORDB_URL=falkor://127.0.0.1:6380 tsx scripts/agency/check.ts [--keep] [--offline]
 */
import { existsSync } from "node:fs";
import { agencyStatus, applyOutages, currentOutages, installFromSnapshot, loadSnapshot, parseAgency, refreshAgency } from "../../src/lib/graph/agency";
import { connect, deleteGraph, listGraphs, run } from "../../src/lib/graph/db";

const SCRATCH = "detour:agency-check";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const keep = process.argv.includes("--keep");
  if ((await listGraphs()).includes(SCRATCH)) await deleteGraph(SCRATCH);
  try {
    let t = performance.now();
    const first = await installFromSnapshot(SCRATCH);
    console.log(`install from snapshot: ${(performance.now() - t).toFixed(0)} ms; opened ${first.opened}, resolved ${first.resolved}, alerts ${first.alertsStarted}`);
    const count = async () =>
      (await run<{ n: number; e: number }>(SCRATCH, "MATCH (n) WITH count(n) AS n MATCH ()-[r]->() RETURN n, count(r) AS e", {}, { readOnly: true })).rows[0];
    const before = await count();
    console.log(`nodes ${before.n}, edges ${before.e}`);

    // Replaying the newest capture is a no-op: nothing opens, nothing resolves.
    const records = await parseAgency(await loadSnapshot());
    t = performance.now();
    const latest = records.outageCaptures[records.outageCaptures.length - 1];
    const again = await applyOutages(SCRATCH, latest.outages, latest.fetchedMs);
    const after = await count();
    console.log(`replay of the newest capture: ${(performance.now() - t).toFixed(0)} ms; opened ${again.opened}, resolved ${again.resolved}; nodes ${after.n} (was ${before.n}), edges ${after.e} (was ${before.e})`);

    const mem = await (await connect())
      .selectGraph(SCRATCH)
      .memoryUsage()
      .catch((e: unknown) => `n/a (${e instanceof Error ? e.message : e})`);
    console.log("memory:", JSON.stringify(mem));

    if (!process.argv.includes("--offline")) {
      t = performance.now();
      const live = await refreshAgency("live", SCRATCH);
      console.log(`live refresh: ${(performance.now() - t).toFixed(0)} ms ${JSON.stringify(live)}`);
    }
    const status = await agencyStatus(SCRATCH);
    console.log("status", JSON.stringify(status.counts), JSON.stringify(status.asOf), status.from);
    const out = await currentOutages({ graph: SCRATCH });
    console.log(`current outages: ${out.length}; elevators on ADA paths ${out.filter((o) => o.kind === "elevator" && o.ada).length}`);
    for (const o of out.slice(0, 4)) console.log("  ", JSON.stringify(o));
  } finally {
    if (!keep) await deleteGraph(SCRATCH);
    await (await connect()).close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
