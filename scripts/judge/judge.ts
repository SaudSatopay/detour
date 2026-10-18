/**
 * One command for a judge: re-measures every headline number in the README on a FalkorDB, recomputes
 * it with the independent NetworkX verifier, and fails loudly when either differs from the README.
 * CLAIMS.md maps each claim to the code and tests behind it.
 *
 *   FALKORDB_URL=falkor://127.0.0.1:6380 pnpm judge            # FalkorDB + NetworkX (needs uv)
 *   FALKORDB_URL=... pnpm judge --no-python                   # use the committed NetworkX results instead
 *   FALKORDB_URL=... pnpm judge --bench                       # also rerun the 15 s concurrency benchmark
 *
 * Exit code 0 means every claim matched on both programs; 1 means at least one MISMATCH line printed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../src/lib/graph/db";
import { ensureBaseGraphs } from "../../src/lib/graph/seed";
import { ensureSandbox, resetSandbox } from "../../src/lib/graph/tenancy";
import { Tracer } from "../../src/lib/graph/trace";
import { measureCapacity, measureHeadroom, simulatePlan, type CapacityData, type HeadroomData, type PlanData } from "../../src/lib/graph/tools/capacity";
import { affectedRiders, type ImpactData } from "../../src/lib/graph/tools/impact";
import { closeLine } from "../../src/lib/graph/tools/incident";
import { recall, type RecallData } from "../../src/lib/graph/tools/memory";
import { SEED_INCIDENTS } from "../../src/lib/graph/seed-memory";
import type { ToolContext } from "../../src/lib/graph/tools/types";
import { falkorVersion, reproduce } from "./maxflow-repro";

const flags = new Set(process.argv.slice(2));
const README = readFileSync("README.md", "utf8");
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

interface Claim {
  id: string;
  /** Text that must appear in the README, so the claim and the README cannot drift apart. */
  readme: string;
  expected: string;
  falkordb: string;
  networkx: string;
  /** Where the independent value comes from when it is not NetworkX. */
  note?: string;
}

type VerifyFlow = { requiredExact: number; absorbedExact: number; unmetExact: number; cutOff: { station: string; side: string }[]; cut: { capacity: number } };
type VerifyScenario = {
  displaced: Record<string, { riders: number }>;
  depthCounts: { k: number; riders: number }[];
  flow: Record<string, VerifyFlow>;
  reroute: { stranded: number; overflow: number; overloaded: { route: string; pct: number }[] };
};
type VerifyPlan = {
  reroute: { before: { stranded: number; overflow: number }; after: { stranded: number; overflow: number } };
  directions: Record<string, { unmetBefore: number; unmetAfter: number }>;
};

function networkx(): { scenario: VerifyScenario; plan: VerifyPlan; twoLeg: VerifyPlan; source: string } {
  let dir = "data/nyc/verify";
  let source = "committed results in data/nyc/verify (--no-python)";
  if (!flags.has("--no-python")) {
    dir = mkdtempSync(join(tmpdir(), "detour-judge-"));
    console.log("NetworkX: running scripts/verify/verify.py (uv) ...");
    try {
      execFileSync("uv", ["run", "--with", "networkx", "python", "scripts/verify/verify.py", "data/nyc", "data/scenarios.json", dir], { stdio: ["ignore", "ignore", "inherit"] });
    } catch (error) {
      console.error("\nMISMATCH: the NetworkX verifier did not run. Install uv (https://docs.astral.sh/uv/) or pass --no-python to use the committed results.");
      throw error;
    }
    source = "recomputed now by scripts/verify/verify.py";
  }
  const read = <T>(file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
  return {
    scenario: read<VerifyScenario>("l-canarsie.json"),
    plan: read<VerifyPlan>("plans/l-canarsie-1av-astor.json"),
    twoLeg: read<VerifyPlan>("plans/l-canarsie-two-leg.json"),
    source,
  };
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  await connect();
  const engine = await falkorVersion();
  console.log(`${engine}; seeding the shared graphs if they are missing or stale ...`);
  await ensureBaseGraphs((m) => console.log(`  seed: ${m}`), flags.has("--reseed"));
  const nx = networkx();

  const visitor = "judgerun";
  await resetSandbox(visitor);
  const sandbox = await ensureSandbox(visitor);
  const ctx = (): ToolContext => ({ visitorId: visitor, sandbox: sandbox.graph, agentId: "controller", tracer: new Tracer() });
  console.log("FalkorDB: closing the L between Bedford Av and 8 Av and running the tools ...");
  await closeLine(ctx(), { routes: ["L"], fromStation: "120", toStation: "618", report: "Judge run: the README's L closure." });
  const impact = (await affectedRiders(ctx(), { depth: 4 })).data as ImpactData;
  const memory = (await recall(ctx(), { routes: ["L"], stations: ["120", "618"] })).data as RecallData;
  const cap = (await measureCapacity(ctx())).data as CapacityData;
  const head = (await measureHeadroom(ctx())).data as HeadroomData;
  const plan = (await simulatePlan(ctx(), { shuttles: [{ from: "119", to: "407", busesPerHour: 25 }], label: "judge: 1 Av - Astor Pl" })).data as PlanData;
  const twoLeg = (
    await simulatePlan(ctx(), {
      shuttles: [
        { from: "119", to: "407", busesPerHour: 25 },
        { from: "120", to: "629", busesPerHour: 60 },
      ],
      label: "judge: two legs",
    })
  ).data as PlanData;
  await resetSandbox(visitor);

  const v = nx.scenario;
  const peak = cap.directions.find((d) => d.direction === cap.peak)!;
  const vPeak = v.flow.forward;
  const g = (rows: { route: string; pct: number }[]) => {
    const pcts = rows.map((o) => o.pct);
    return `${rows.length} ${[...new Set(rows.map((o) => o.route))].join("/")} segments at ${Math.min(...pcts)} to ${Math.max(...pcts)}%`;
  };
  const vDisplaced = Object.values(v.displaced).reduce((s, d) => s + d.riders, 0);
  const ratio = Math.min(...memory.incidents.flatMap((i) => i.shuttles.filter((s) => s.planned && s.observed).map((s) => s.observed / s.planned)));
  // The memory claims have no NetworkX counterpart; the independent source is the seed data itself.
  const seedRatio = Math.min(...SEED_INCIDENTS.filter((i) => i.routes.includes("L")).flatMap((i) => i.shuttles.map((s) => s.observed / s.planned)));
  const cutOff = (list: { id?: string; station?: string; side: string }[]) =>
    list.filter((s) => s.side === "origin").map((s) => (s.id ?? s.station) === "119" ? "1 Av" : (s.id ?? s.station)).join(", ");

  const claims: Claim[] = [
    { id: "displaced", readme: "**23,445** riders an hour", expected: "23,445", falkordb: fmt(cap.displacedRiders), networkx: fmt(vDisplaced) },
    { id: "within one stop", readme: "10,142 board within one stop", expected: "10,142", falkordb: fmt(impact.byDepth[1].riders), networkx: fmt(v.depthCounts[1].riders) },
    { id: "within four stops", readme: "14,713 within four", expected: "14,713", falkordb: fmt(impact.byDepth[4].riders), networkx: fmt(v.depthCounts[4].riders) },
    { id: "G overload", readme: "4 G segments run at **190 to 244%**", expected: "4 G segments at 190 to 244%", falkordb: g(cap.reroute.overloaded), networkx: g(v.reroute.overloaded) },
    { id: "no open path", readme: "4,689 riders have no open path", expected: "4,689", falkordb: fmt(cap.reroute.stranded), networkx: fmt(v.reroute.stranded) },
    { id: "max flow", readme: "**17,167 of 18,432** riders an hour toward Manhattan (93%)", expected: "17,167 of 18,432 (93%)", falkordb: `${fmt(peak.absorbed)} of ${fmt(peak.required)} (${Math.round((peak.absorbed / peak.required) * 100)}%)`, networkx: `${fmt(vPeak.absorbedExact)} of ${fmt(vPeak.requiredExact)} (${Math.round((vPeak.absorbedExact / vPeak.requiredExact) * 100)}%)` },
    { id: "max flow certified", readme: "17,167 of 18,432", expected: "certified", falkordb: cap.directions.every((d) => d.check.checked) ? "certified" : "FAILED", networkx: Math.abs(v.flow.forward.cut.capacity - v.flow.forward.absorbedExact) <= 1e-6 && Math.abs(v.flow.backward.cut.capacity - v.flow.backward.absorbedExact) <= 1e-6 ? "certified" : "FAILED" },
    { id: "bottleneck station", readme: "**1 Av**: its only rail links are the closed L", expected: "1 Av", falkordb: cutOff(peak.cutOff), networkx: cutOff(vPeak.cutOff) },
    { id: "shuttle: no path", readme: "riders with no path 4,689 → **623**", expected: "4,689 → 623", falkordb: `${fmt(plan.before.stranded)} → ${fmt(plan.after.stranded)}`, networkx: `${fmt(nx.plan.reroute.before.stranded)} → ${fmt(nx.plan.reroute.after.stranded)}` },
    { id: "shuttle: shortfall", readme: "max-flow shortfall 1,266 → **315**", expected: "1,266 → 315", falkordb: `${fmt(plan.before.unmet)} → ${fmt(plan.after.unmet)}`, networkx: `${fmt(nx.plan.directions.forward.unmetBefore)} → ${fmt(nx.plan.directions.forward.unmetAfter)}` },
    { id: "shuttle: overflow", readme: "(24,078 → 28,762)", expected: "24,078 → 28,762", falkordb: `${fmt(plan.before.overflow)} → ${fmt(plan.after.overflow)}`, networkx: `${fmt(nx.plan.reroute.before.overflow)} → ${fmt(nx.plan.reroute.after.overflow)}` },
    { id: "two legs do no better", readme: "A two-leg plan does no better with 18 more buses", expected: "623 / 315 with 18 more buses", falkordb: `${fmt(twoLeg.after.stranded)} / ${fmt(twoLeg.after.unmet)} with ${twoLeg.vehicles - plan.vehicles} more buses`, networkx: `${fmt(nx.twoLeg.reroute.after.stranded)} / ${fmt(nx.twoLeg.directions.forward.unmetAfter)} with ${twoLeg.vehicles - plan.vehicles} more buses` },
    { id: "memory: carried", readme: "carried 79% of plan", expected: "79%", falkordb: `${Math.round(ratio * 100)}%`, networkx: `${Math.round(seedRatio * 100)}%`, note: "from the seed data; a memory claim has no NetworkX equivalent" },
    { id: "memory: more buses", readme: "adds **27%** more buses", expected: "27%", falkordb: `${Math.round((1 / ratio - 1) * 100)}%`, networkx: `${Math.round((1 / seedRatio - 1) * 100)}%`, note: "from the seed data; a memory claim has no NetworkX equivalent" },
  ];

  const bench = JSON.parse(readFileSync("data/proof/bench.json", "utf8")) as { reads: { perSecond: number }; errors: number; isolation: { ok: boolean }; engine: string };
  let benchNow = `${fmt(bench.reads.perSecond)} (committed, ${bench.engine})`;
  let benchOk = true;
  if (flags.has("--bench")) {
    console.log("Benchmark: 48 readers and 6 writers for 15 s ...");
    execFileSync("pnpm", ["tsx", "scripts/ci/bench.ts", "15"], { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
    const now = JSON.parse(readFileSync("ci-out/bench.json", "utf8")) as typeof bench;
    // Throughput depends on the machine; errors and isolation do not.
    benchOk = now.errors === 0 && now.isolation.ok;
    benchNow = `${fmt(now.reads.perSecond)} measured now (hardware-dependent), ${now.errors} errors, isolation ${now.isolation.ok ? "held" : "BROKEN"}`;
  }

  let failures = 0;
  console.log(`\nNetworkX: ${nx.source}\n`);
  for (const c of claims) {
    const inReadme = README.includes(c.readme);
    const ok = inReadme && c.falkordb === c.expected && c.networkx === c.expected;
    if (!ok) failures++;
    console.log(`${ok ? "  ok      " : "  MISMATCH"} ${c.id.padEnd(22)} README ${c.expected.padEnd(30)} FalkorDB ${c.falkordb.padEnd(30)} NetworkX ${c.networkx}${c.note ? ` (${c.note})` : ""}${inReadme ? "" : "   (README text not found)"}`);
  }
  const benchInReadme = README.includes(`${fmt(bench.reads.perSecond)} reads`);
  if (!benchInReadme || !benchOk) failures++;
  console.log(`${benchInReadme && benchOk ? "  ok      " : "  MISMATCH"} ${"reads a second".padEnd(22)} README ${fmt(bench.reads.perSecond).padEnd(30)} bench ${benchNow}`);

  const fallbacks = cap.directions.filter((d) => d.check.solver === "dinic").length + head.directions.reduce((s, h) => s + h.recomputed, 0);
  const hPeak = head.directions.find((h) => h.direction === head.peak);
  console.log(
    `\n  info     headroom: displaced demand toward Manhattan can grow ${hPeak?.multiplier ?? "beyond 20"}× before an open segment saturates` +
      ` (${hPeak?.saturating.slice(0, 1).map((s) => `${s.route ?? s.kind} ${s.from}→${s.to}`).join("") ?? ""}); ${fallbacks} of ${cap.directions.length + head.directions.reduce((s, h) => s + h.solves, 0)} max-flow answers recomputed by Dinic`,
  );
  const repro = await reproduce(0);
  const rc = repro.chokepoint;
  console.log(
    `  info     ${engine} on Chokepoint's 11-edge network: algo.maxFlow ${rc.falkordb}, exact ${rc.exact}; the certificate ${rc.checked ? "accepts it" : "rejects it, so Detour would recompute"}`,
  );
  if (rc.falkordb !== rc.exact && rc.checked) failures++;
  await (await connect()).close();
  if (failures) {
    console.error(`\n${failures} claim(s) MISMATCH. See CLAIMS.md for what measures each one.`);
    process.exit(1);
  }
  console.log(`\nAll ${claims.length + 1} README claims re-measured on ${engine} and recomputed by NetworkX: they match.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
