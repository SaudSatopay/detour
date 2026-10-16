import Link from "next/link";
import { HeroMap } from "@/components/map/hero-map";
import { CypherBlock } from "@/components/cypher-block";
import { FACTS, fmt } from "@/lib/facts";

const L = FACTS.l;

const FINDINGS = [
  {
    n: "01",
    title: "Riders four stops away are hit too.",
    body: `${fmt(L.depth0)} riders an hour board at the closed stations. Count riders whose trips cross the tube from up to four stops away and it is ${fmt(
      L.depth4,
    )}; ${fmt(L.displaced)} in all. An alert sent to the closed stations would miss most of them.`,
    stat: fmt(L.displaced),
    unit: "riders an hour displaced",
  },
  {
    n: "02",
    title: `Their fastest way around overloads the ${L.overloadRoutes.join(" and ")}.`,
    body: `Left to pick their own fastest route, displaced riders transfer at Metropolitan Av/Lorimer St and pile onto the ${L.overloadRoutes.join(
      " and ",
    )}: ${L.overloadedCount} segments run at ${L.overloadMin} to ${L.overloadMax}% of capacity. A short train with a lot of spare seats elsewhere on the network is still a short train.`,
    stat: `${L.worstPct}%`,
    unit: `of capacity on the ${L.worstRoute}, ${L.worstFrom} to ${L.worstTo}`,
  },
  {
    n: "03",
    title: "Even spread perfectly, some riders cannot move.",
    body: `Max flow over every line's spare capacity moves ${fmt(L.absorbed)} of the ${fmt(L.required)} riders an hour headed into Manhattan. The min cut sits at ${L.cutStations.join(" and ")}, where the closed L is the only line. A ${L.shuttleBuses}-bus-an-hour 14 St shuttle cuts the shortfall from ${fmt(
      L.unmet,
    )} to ${fmt(L.unmetAfterShuttle)}.`,
    stat: `${Math.round((L.absorbed / L.required) * 100)}%`,
    unit: "is the most the open network can carry",
  },
];

const STEPS = [
  {
    title: "One graph per visitor",
    body: "Your sandbox is a copy of the template graph, so the closures, plans and memory you create never reach anyone else.",
    cypher: "GRAPH.COPY detour:template detour:sbx:<you>",
  },
  {
    title: "Who rides through the break",
    body: "Every 2025 origin-destination flow whose 8 a.m. path used a closed segment, then the stations one, two, three stops upstream, hop by hop.",
    cypher: `MATCH (o:Station)-[d:DEMAND]->(x:Station)
WHERE any(e IN d.via WHERE e IN $closed)
RETURN o.id AS o, x.id AS d, d.riders AS riders`,
  },
  {
    title: "What the rest can absorb",
    body: "A fork of your graph without the closed segments, spare capacity summed per corridor, a super source and sink sized to the displaced riders, and FalkorDB's max flow.",
    cypher:
      `MATCH (src:Hub {id: $src}), (snk:Hub {id: $snk})
CALL algo.maxFlow({sourceNodes: [src], targetNodes: [snk],
  relationshipTypes: ['FLOW'], capacityProperty: 'spare'})
YIELD maxFlow, edges, edgeFlows`,
  },
  {
    title: "Test the fix before anyone acts",
    body: "Each shuttle plan gets its own fork with bus links added; every displaced trip is rerouted through platforms, transfers and walks, and max flow runs again. A person approves before a plan reaches riders.",
    cypher:
      `UNWIND $pairs AS p
MATCH (a:Station {id: p.o}), (b:Station {id: p.d})
CALL algo.SPpaths({sourceNode: a, targetNode: b,
  relTypes: ['BOARD', 'RIDE', 'ALIGHT', 'WALK', 'BUS'],
  weightProp: 'minutes'})
YIELD path, pathWeight`,
  },
];

export default function Home() {
  return (
    <>
      <section className="mx-auto grid w-full max-w-[1180px] items-center gap-8 px-4 pb-12 pt-8 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12 lg:pb-16 lg:pt-12">
        <div className="rise flex flex-col gap-6">
          <p className="label text-ink-500">Graph Hacks · FalkorDB · Tracks 1 and 2</p>
          <h1 className="font-display text-4xl font-bold leading-[0.98] tracking-tight sm:text-5xl">
            When a subway line breaks, Detour measures what the city can still carry.
          </h1>
          <p className="max-w-[58ch] text-lg text-ink-700">
            The real New York subway, built from the MTA&apos;s own data, lives in FalkorDB. Agents find whose trips a closure breaks, measure what
            the rest of the network can absorb with max flow, test shuttle bridges on forked copies of the graph, and tell every remembered rider
            what to take instead.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/control?scenario=l-canarsie&run=1"
              className="rounded-md bg-ink-900 px-5 py-3 font-display text-lg font-semibold tracking-wide text-paper transition-transform duration-150 ease-out hover:-translate-y-px"
            >
              Break the L train
            </Link>
            <Link
              href="/proof"
              className="rounded-md border border-line-strong px-5 py-3 font-display text-lg font-semibold tracking-wide text-ink-900 transition-colors duration-150 hover:bg-sunk"
            >
              See the proof
            </Link>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-5 sm:grid-cols-4">
            {[
              [fmt(FACTS.ridersAt8), "riders in the 8 a.m. hour"],
              [fmt(FACTS.stations), "station complexes"],
              [fmt(FACTS.segments), "scheduled route segments"],
              ["2", "independent max-flow implementations agree"],
            ].map(([value, label]) => (
              <div key={label}>
                <dt className="sr-only">{label}</dt>
                <dd className="tabular font-display text-2xl font-bold">{value}</dd>
                <dd className="text-sm text-ink-500">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
        <HeroMap className="aspect-[4/5] w-full rounded-lg border border-line bg-panel sm:aspect-square lg:aspect-[6/5]" />
      </section>

      <section aria-labelledby="findings" className="border-t border-line bg-panel">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-12 sm:px-6 lg:py-24">
          <h2 id="findings" className="max-w-[24ch] font-display text-3xl font-bold leading-tight sm:text-4xl">
            What the graph found when the Canarsie Tube closed at 8 a.m.
          </h2>
          <ol className="mt-10 grid gap-8 lg:grid-cols-3 lg:gap-10">
            {FINDINGS.map((f) => (
              <li key={f.n} className="flex min-w-0 flex-col gap-3 border-t-2 border-ink-900 pt-4">
                <span className="label text-ink-500">{f.n}</span>
                <p className="tabular font-display text-5xl font-bold leading-none">{f.stat}</p>
                <p className="text-sm text-ink-500">{f.unit}</p>
                <h3 className="mt-2 font-display text-xl font-semibold">{f.title}</h3>
                <p className="text-ink-700">{f.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-10 max-w-[70ch] text-sm text-ink-500">
            Weekday 8 a.m. capacity from MTA GTFS (trains per hour × planning load per train); demand from the MTA&apos;s 2025 origin-destination
            estimates ({fmt(FACTS.pairsKept)} of {fmt(FACTS.pairsTotal)} station pairs, {FACTS.ridersKeptPct}% of riders). The max-flow numbers are
            computed in FalkorDB and checked by a separate NetworkX implementation.
          </p>
        </div>
      </section>

      <section aria-labelledby="how" className="border-t border-line">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-12 sm:px-6 lg:py-24">
          <h2 id="how" className="max-w-[24ch] font-display text-3xl font-bold leading-tight sm:text-4xl">
            The agents choose the tools. The graph does the work.
          </h2>
          <p className="mt-4 max-w-[64ch] text-ink-700">
            The model never writes Cypher. It picks from a fixed catalogue of graph tools, each a parameterized query with its row count and
            latency shown in the trace, and every answer is a path, a flow, a dated memory, or an honest &ldquo;not in the graph&rdquo;.
          </p>
          <ol className="mt-10 grid gap-6 md:grid-cols-2">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-panel p-5">
                <div className="flex items-baseline gap-3">
                  <span className="label text-ink-500">{String(i + 1).padStart(2, "0")}</span>
                  <h3 className="font-display text-xl font-semibold">{s.title}</h3>
                </div>
                <p className="text-ink-700">{s.body}</p>
                <CypherBlock code={s.cypher} />
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="memory" className="border-t border-line bg-panel">
        <div className="mx-auto grid w-full max-w-[1180px] gap-10 px-4 py-12 sm:px-6 lg:grid-cols-2 lg:py-24">
          <div>
            <h2 id="memory" className="max-w-[22ch] font-display text-3xl font-bold leading-tight sm:text-4xl">
              Agents that remember, and hand off through the graph.
            </h2>
            <p className="mt-4 max-w-[60ch] text-ink-700">
              When a dispatcher approves a plan, the control agent hands off to the rider desk as graph state. One agent per remembered rider
              checks whether their usual trip crosses the closure and writes them an advisory. Facts carry dates and close when they stop being
              true, so an elevator outage remembered last week changes a wheelchair user&apos;s route today.
            </p>
          </div>
          <ul className="grid gap-4 self-center sm:grid-cols-2">
            {[
              ["Episodic", "Every tool call becomes an Episode in your graph, linked to its incident."],
              ["Semantic", "Findings with valid-from and valid-to; superseded facts are closed, never deleted."],
              ["Procedural", "Playbooks per line, with how often they were used and what a shuttle actually carried."],
              ["Per tenant", "A graph per visitor, measured under concurrent rider reads and controller writes."],
            ].map(([k, v]) => (
              <li key={k} className="rounded-lg border border-line bg-paper p-4">
                <p className="label text-ink-500">{k}</p>
                <p className="mt-2 text-ink-700">{v}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col items-start gap-5 px-4 py-12 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:py-16">
          <p className="max-w-[40ch] font-display text-2xl font-semibold leading-snug sm:text-3xl">
            Close a line yourself and watch the agents measure it.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/control" className="rounded-md bg-ink-900 px-5 py-3 font-display text-lg font-semibold tracking-wide text-paper transition-transform duration-150 ease-out hover:-translate-y-px">
              Open the control room
            </Link>
            <Link href="/riders" className="rounded-md border border-line-strong px-5 py-3 font-display text-lg font-semibold tracking-wide transition-colors duration-150 hover:bg-sunk">
              Ask as a rider
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
