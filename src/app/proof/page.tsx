import type { Metadata } from "next";
import Link from "next/link";
import { CypherBlock } from "@/components/cypher-block";
import { agreement, BENCH, cypherCatalog, depthAgreement, META, toolCosts } from "@/lib/proof";
import { TOOL_TITLE } from "@/lib/tool-titles";

export const metadata: Metadata = {
  title: "Proof",
  description:
    "FalkorDB's max flow, min cut and displaced-rider counts checked against an independent NetworkX implementation, a concurrency benchmark across tenant graphs, and every Cypher query the agents run.",
};

const n = (x: number) => Math.round(x).toLocaleString("en-US");
const REPO = "https://github.com/SaudSatopay/detour/blob/main";

function SectionHead({ id, kicker, title, children }: { id: string; kicker: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="flex max-w-prose flex-col gap-2">
      <p className="label text-ink-500">{kicker}</p>
      <h2 id={id} className="scroll-mt-20 font-display text-3xl font-bold leading-tight tracking-tight">
        {title}
      </h2>
      {children ? <div className="text-ink-700">{children}</div> : null}
    </header>
  );
}

export default function ProofPage() {
  const rows = agreement();
  const allMatch = rows.every((r) => r.match);
  const depth = depthAgreement("l-canarsie");
  const costs = toolCosts();
  const maxMs = Math.max(...costs.map((c) => c.ms));
  const catalog = cypherCatalog();
  const queryCount = catalog.reduce((s, c) => s + c.queries.length, 0);

  return (
    <>
      {/* The claim at poster scale, on the night stage. */}
      <header className="night border-b border-line">
        <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 pb-12 pt-12 sm:px-6 lg:pb-16 lg:pt-20">
          <p className="label text-ink-500">Proof</p>
          <h1 className="lift max-w-[18ch] font-display text-5xl font-bold leading-[0.95] tracking-[-0.012em] sm:text-6xl lg:text-7xl">
            Every number is computed twice, by two different programs.
          </h1>
          <p className="max-w-prose text-lg text-ink-700">
            FalkorDB does the work: the agents&apos; tools run Cypher and graph algorithms on your copy of the subway graph. A separate Python
            program built on NetworkX reads the same data files, follows the same written spec, and recomputes the answers. Where they meet, the
            numbers are right; where they would differ, the build fails.
          </p>
          <nav aria-label="On this page" className="flex flex-wrap gap-2">
            {[
              ["agreement", "FalkorDB vs NetworkX"],
              ["concurrency", "Many agents at once"],
              ["cost", "What each tool costs"],
              ["data", "Data and assumptions"],
              ["cypher", "Every query"],
            ].map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="rounded-full border border-line-strong px-3 py-1 text-sm text-ink-700 transition-colors duration-150 hover:border-signal hover:text-ink-900"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-page flex-col gap-16 px-4 pb-24 pt-14 sm:px-6">

        <section className="flex flex-col gap-6" aria-labelledby="agreement">
          <SectionHead id="agreement" kicker="Check 1" title={allMatch ? "FalkorDB and NetworkX agree on every closure." : "FalkorDB and NetworkX disagree."}>
            <p>
              Max flow from a super source to a super sink over spare capacity, per direction of travel. FalkorDB runs <code className="font-mono text-sm">algo.maxFlow</code>{" "}
              on a forked graph; the checker runs NetworkX&apos;s Edmonds-Karp on the same network. Both follow{" "}
              <a className="underline decoration-line-strong underline-offset-4" href={`${REPO}/docs/model.md`}>
                docs/model.md
              </a>
              .
            </p>
          </SectionHead>
          <div tabIndex={0} role="region" aria-label="FalkorDB and NetworkX results" className="scroll-x-cue overflow-x-auto rounded-md border border-line">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <caption className="sr-only">Riders an hour to move and max flow, FalkorDB against NetworkX</caption>
              <thead className="bg-sunk text-left">
                <tr>
                  <th scope="col" className="label px-3 py-2 text-ink-700">Closure</th>
                  <th scope="col" className="label px-3 py-2 text-ink-700">Direction</th>
                  <th scope="col" className="label px-3 py-2 text-right text-ink-700">To move · FalkorDB</th>
                  <th scope="col" className="label px-3 py-2 text-right text-ink-700">NetworkX</th>
                  <th scope="col" className="label px-3 py-2 text-right text-ink-700">Max flow · FalkorDB</th>
                  <th scope="col" className="label px-3 py-2 text-right text-ink-700">NetworkX</th>
                  <th scope="col" className="label px-3 py-2 text-ink-700">Agree</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.scenario}${r.direction}`} className="border-t border-line">
                    <td className="px-3 py-2 text-ink-900">{r.title}</td>
                    <td className="px-3 py-2 text-ink-700">{r.direction}</td>
                    <td className="tabular px-3 py-2 text-right font-mono">{n(r.falkor.required)}</td>
                    <td className="tabular px-3 py-2 text-right font-mono text-ink-500">{r.networkx.required.toFixed(1)}</td>
                    <td className="tabular px-3 py-2 text-right font-mono">{n(r.falkor.absorbed)}</td>
                    <td className="tabular px-3 py-2 text-right font-mono text-ink-500">{r.networkx.absorbed.toFixed(1)}</td>
                    <td className={`px-3 py-2 font-semibold ${r.match ? "text-ok" : "text-crit"}`}>{r.match ? "✓ yes" : "✗ no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-3">
              <h3 className="font-display text-xl font-semibold">Riders hit, by stops from the L closure</h3>
              <p className="text-sm text-ink-700">
                The <code className="font-mono">affected_riders</code> tool walks upstream one hop at a time in Cypher and joins the 2025
                origin-destination flows whose paths cross the closure. NetworkX counts the same thing by breadth-first search.
              </p>
              <table className="w-full border-collapse text-sm">
                <thead className="text-left">
                  <tr className="border-b border-line">
                    <th scope="col" className="label py-1.5 text-ink-700">Within</th>
                    <th scope="col" className="label px-3 py-1.5 text-right text-ink-700">FalkorDB</th>
                    <th scope="col" className="label px-3 py-1.5 text-right text-ink-700">NetworkX</th>
                    <th scope="col" className="label py-1.5 pl-3 text-ink-700">Agree</th>
                  </tr>
                </thead>
                <tbody>
                  {depth.map((d) => (
                    <tr key={d.k} className="border-b border-line/60">
                      <td className="py-1.5 text-ink-700">{d.k === 0 ? "boards in the closed stretch" : `${d.k} stop${d.k === 1 ? "" : "s"}`}</td>
                      <td className="tabular px-3 py-1.5 text-right font-mono">{n(d.falkor)}</td>
                      <td className="tabular px-3 py-1.5 text-right font-mono text-ink-500">{d.networkx.toFixed(1)}</td>
                      <td className={`py-1.5 pl-3 font-semibold ${d.match ? "text-ok" : "text-crit"}`}>{d.match ? "✓" : "✗"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <h3 className="font-display text-xl font-semibold">How the check runs</h3>
              <ul className="flex flex-col gap-2 text-sm text-ink-700">
                <li>
                  <span className="font-semibold text-ink-900">Same inputs.</span> Both read <code className="font-mono">data/nyc/network.json</code> and{" "}
                  <code className="font-mono">demand.json</code>, built from MTA files by <code className="font-mono">scripts/build-network.ts</code>.
                </li>
                <li>
                  <span className="font-semibold text-ink-900">Different code.</span> FalkorDB tools in TypeScript and Cypher;{" "}
                  <a className="underline decoration-line-strong underline-offset-4" href={`${REPO}/scripts/verify/verify.py`}>
                    verify.py
                  </a>{" "}
                  in Python with NetworkX 3.7, which also checks that the min cut&apos;s capacity equals the max flow.
                </li>
                <li>
                  <span className="font-semibold text-ink-900">Run on every change.</span>{" "}
                  <a className="underline decoration-line-strong underline-offset-4" href={`${REPO}/scripts/ci/run-scenarios.ts`}>
                    run-scenarios.ts
                  </a>{" "}
                  seeds FalkorDB, runs every tool on all three closures and fails when a number drifts from NetworkX by more than rounding.
                </li>
                <li>
                  <span className="font-semibold text-ink-900">Where the min cut sits.</span> On the L, both programs put the bottleneck at 1 Av: its
                  only rail links are the closed L segments, so no amount of spare capacity elsewhere reaches its riders. That is why the recommended
                  shuttle starts there.
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-6" aria-labelledby="concurrency">
          <SectionHead id="concurrency" kicker="Check 2" title={`${n(BENCH.reads.perSecond)} reads and ${n(BENCH.writes.perSecond)} writes a second, no leaks between tenants.`}>
            <p>
              Every visitor gets a graph of their own. The benchmark runs {BENCH.readers} reader agents and {BENCH.writers} writer agents for{" "}
              {BENCH.seconds} seconds across {BENCH.tenants} tenant graphs over {BENCH.connections} connections, then checks that a closure written
              in one tenant is invisible in the others.
            </p>
          </SectionHead>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-4">
            {[
              ["Reads", n(BENCH.reads.count), `p50 ${BENCH.reads.p50} ms · p95 ${BENCH.reads.p95} ms`],
              ["Writes", n(BENCH.writes.count), `p50 ${BENCH.writes.p50} ms · p95 ${BENCH.writes.p95} ms`],
              ["Errors", n(BENCH.errors), "across both"],
              ["Isolation", BENCH.isolation.ok ? "Held" : "Broken", `closed segments per tenant: ${BENCH.isolation.closedSegmentsPerTenant.join(", ")}`],
            ].map(([label, value, note]) => (
              <div key={label} className="flex flex-col gap-1 bg-panel p-4">
                <dt className="label text-ink-500">{label}</dt>
                <dd className="tabular font-display text-3xl font-bold">{value}</dd>
                <dd className="text-xs text-ink-500">{note}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-ink-500">
            {BENCH.engine}.{" "}
            <a className="underline decoration-line-strong underline-offset-4" href={`${REPO}/scripts/ci/bench.ts`}>
              scripts/ci/bench.ts
            </a>
          </p>
        </section>

        <section className="flex flex-col gap-6" aria-labelledby="cost">
          <SectionHead id="cost" kicker="Check 3" title="What each tool costs on the L closure.">
            <p>Summed query time per call, from the same run. The expensive tools fork the graph, rebuild the flow network and reroute two thousand trips.</p>
          </SectionHead>
          <ol className="flex flex-col gap-2">
            {costs.map((c) => (
              <li key={c.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_7.5rem] items-center gap-3 text-sm sm:grid-cols-[14rem_minmax(0,1fr)_7.5rem]">
                <span className="truncate text-ink-900" title={c.summary}>
                  {TOOL_TITLE[c.tool] ?? c.tool}
                  <span className="ml-1.5 font-mono text-xs text-ink-500">{c.key.startsWith("route-") ? c.key.slice(6) : ""}</span>
                </span>
                <span className="block h-2 overflow-hidden rounded-full bg-sunk" aria-hidden="true">
                  <span className="block h-full rounded-full bg-signal" style={{ width: `${Math.max(1, (c.ms / maxMs) * 100)}%` }} />
                </span>
                <span className="tabular whitespace-nowrap text-right font-mono text-xs text-ink-700">
                  {c.ms < 1000 ? `${c.ms} ms` : `${(c.ms / 1000).toFixed(1)} s`} · {c.queries}q
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col gap-6" aria-labelledby="data">
          <SectionHead id="data" kicker="Inputs" title="The data, and what was assumed.">
            <p>
              {n(META.counts.stations)} station complexes, {META.counts.routes} routes, {n(META.counts.segments)} scheduled segments,{" "}
              {n(META.counts.walks)} walking links and {n(META.counts.demandPairs)} origin-destination pairs carrying {n(META.ridership.ridersKept)} of
              the {n(META.ridership.totalRiders)} riders the MTA estimates for a weekday 8 a.m. hour.
            </p>
          </SectionHead>
          <div className="grid gap-6 lg:grid-cols-2">
            <ul className="flex flex-col gap-3 text-sm">
              {META.sources.map((s) => (
                <li key={s.name} className="flex flex-col">
                  <a href={s.url} className="font-semibold text-ink-900 underline decoration-line-strong underline-offset-4">
                    {s.name}
                  </a>
                  <span className="text-ink-500">
                    {"slice" in s && s.slice ? `${s.slice} · ` : ""}retrieved {s.retrieved}
                  </span>
                </li>
              ))}
            </ul>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
              {[
                ["Peak hour", META.assumptions.peakWindow],
                ["Riders per car (A division / 60 ft / 75 ft)", `${META.assumptions.riderLoadPerCarA} / ${META.assumptions.riderLoadPerCar60ft} / ${META.assumptions.riderLoadPerCar75ft}`],
                ["Transfer penalty", `${META.assumptions.transferPenaltyMinutes} min + half the headway`],
                ["Walking links", `under ${META.assumptions.walkRadiusMeters} m at ${META.assumptions.walkSpeedMetersPerMinute} m/min`],
                ["Shuttle bus", "70 riders, 4 min + 3 min per km"],
                ["Smallest flow kept", `${META.assumptions.minRidersPerPair} riders an hour`],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-700">{k}</dt>
                  <dd className="tabular text-right font-mono text-ink-900">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="text-sm text-ink-500">
            Baseline paths come from an all-or-nothing assignment (fastest route by in-vehicle time, half-headway wait and transfer penalty). Riders
            and past incidents in memory are example data, labeled as such.
          </p>
        </section>

        <section className="flex flex-col gap-6" aria-labelledby="cypher">
          <SectionHead id="cypher" kicker="Every query" title={`${queryCount} Cypher queries and graph commands behind ${catalog.length} tools.`}>
            <p>
              The agents never write Cypher. They pick from this fixed catalogue; each call returns its answer shape, a summary, and the exact
              queries below with their timings, which the <Link href="/control" className="underline decoration-line-strong underline-offset-4">control room</Link> shows step by step.
            </p>
          </SectionHead>
          <div className="flex flex-col gap-2">
            {catalog.map((c) => (
              <details key={c.tool} className="group rounded-md border border-line bg-panel">
                <summary className="flex cursor-pointer list-none items-baseline gap-3 px-4 py-3 hover:bg-sunk/60">
                  <span aria-hidden="true" className="inline-block text-ink-500 transition-transform duration-150 group-open:rotate-90">
                    ›
                  </span>
                  <span className="font-display text-lg font-semibold">{TOOL_TITLE[c.tool] ?? c.tool}</span>
                  <code className="font-mono text-xs text-ink-500">{c.tool}</code>
                  <span className="tabular ml-auto font-mono text-xs text-ink-500">{c.queries.length}</span>
                </summary>
                <ol className="flex flex-col gap-4 border-t border-line px-4 py-4">
                  {c.queries.map((q) => (
                    <li key={q.cypher} className="min-w-0">
                      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
                        <span className="font-semibold text-ink-900">{q.label}</span>
                        <span className="font-mono">on {q.graph}</span>
                      </p>
                      <CypherBlock code={q.cypher} className="mt-1" />
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
