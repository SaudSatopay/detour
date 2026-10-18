import Link from "next/link";
import type { ReactNode } from "react";
import { CypherBlock } from "@/components/cypher-block";
import { StoryStage } from "@/components/story/story-stage";
import { worstOverload, type Story } from "@/components/story/story";
import { TrimLine } from "@/components/trim-line";
import { FACTS, fmt } from "@/lib/facts";
import storyData from "../../public/map/story-l-canarsie.json";

// Every number in the story comes from the run recorded on FalkorDB (scripts/build-story.mjs).
const story = storyData as unknown as Story;
const name = (id: string) => story.names[id] ?? id;
const worst = worstOverload(story);
const overloadRoutes = [...new Set(story.reroute.overloaded.map((o) => o.route))];
const pcts = story.reroute.overloaded.map((o) => o.pct);
const depth = (k: number) => story.impact.byDepth.find((d) => d.depth === k)?.riders ?? 0;
const stranded = story.maxFlow.strandedAt[0];
const shuttle = story.plan.shuttles[0];
const rider = story.riders.featured;
const memory = story.memory;
const month = memory ? new Date(memory.openedMs).toLocaleDateString("en-US", { month: "long", timeZone: "America/New_York" }) : null;

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
    cypher: `MATCH (src:Hub {id: $src}), (snk:Hub {id: $snk})
CALL algo.maxFlow({sourceNodes: [src], targetNodes: [snk],
  relationshipTypes: ['FLOW'], capacityProperty: 'spare'})
YIELD maxFlow, edges, edgeFlows`,
  },
  {
    title: "Test the fix before anyone acts",
    body: "Each shuttle plan gets its own fork with bus links added; every displaced trip is rerouted through platforms, transfers and walks, and max flow runs again. A person approves before a plan reaches riders.",
    cypher: `UNWIND $pairs AS p
MATCH (a:Station {id: p.o}), (b:Station {id: p.d})
CALL algo.SPpaths({sourceNode: a, targetNode: b,
  relTypes: ['BOARD', 'RIDE', 'ALIGHT', 'WALK', 'BUS'],
  weightProp: 'minutes'})
YIELD path, pathWeight`,
  },
];

const MEMORY = [
  ["Episodic", "Every tool call becomes an Episode in your graph, linked to its incident."],
  ["Semantic", "Findings with valid-from and valid-to; superseded facts are closed, never deleted."],
  ["Procedural", "Playbooks per line, with how often they were used and what a shuttle actually carried."],
  ["Per tenant", "A graph per visitor, measured under concurrent rider reads and controller writes."],
];

/** One chapter of the story: a station sign on top, the number, the claim, the evidence. */
function Chapter({
  id,
  n,
  kicker,
  figure,
  tone,
  unit,
  title,
  children,
}: {
  id: string;
  n: string;
  kicker: string;
  figure: string;
  tone: "crit" | "signal" | "ink";
  unit: string;
  title: string;
  children: ReactNode;
}) {
  const color = tone === "crit" ? "text-crit" : tone === "signal" ? "text-signal" : "text-ink-900";
  return (
    <article id={`ch-${id}`} data-chapter={id} aria-labelledby={`ch-${id}-title`} className="flex min-h-[100svh] scroll-mt-12 items-end px-4 pb-[5svh] sm:px-6 lg:min-h-[92svh] lg:items-center lg:pb-0 lg:pl-12">
      <div className="pointer-events-auto w-full max-w-[30rem] overflow-hidden rounded-md border border-line bg-panel shadow-lift">
        <p className="sign-band sign-rule label flex items-center gap-2 px-4 pb-2.5 pt-4">
          <span className="tabular">{n}</span>
          <span aria-hidden="true">·</span>
          {kicker}
        </p>
        <div className="flex flex-col gap-2 p-4 sm:gap-3 sm:p-6">
          {/* Long figures (a before → after) step down a size so they hold one line. */}
          <p className={`tabular font-display font-bold ${figure.length > 7 ? "text-4xl sm:text-6xl" : "text-5xl sm:text-7xl"} ${color}`}>{figure}</p>
          <p className="-mt-1 text-xs text-ink-500 sm:text-sm">{unit}</p>
          <h2 id={`ch-${id}-title`} className="mt-1 font-display text-xl font-semibold leading-tight sm:text-3xl">
            {title}
          </h2>
          <div className="flex flex-col gap-2 text-md text-ink-700 sm:gap-3 sm:text-base sm:leading-normal">{children}</div>
        </div>
      </div>
    </article>
  );
}

export default function Home() {
  return (
    <>
      <StoryStage>
        {/* The opening: a poster over the night map. */}
        <header id="ch-hero" data-chapter="hero" className="flex min-h-[calc(100svh-3rem)] flex-col justify-end px-4 pb-8 pt-[44svh] sm:px-6 lg:justify-center lg:py-16 lg:pl-12">
          <div className="pointer-events-auto relative isolate max-w-[min(60rem,100%)]">
            {/* A soft shade behind the words so they hold over the busiest part of the map. */}
            <div aria-hidden="true" className="absolute -inset-x-8 -inset-y-10 -z-10 bg-[radial-gradient(closest-side,var(--paper)_55%,transparent)] opacity-90" />
            <p className="label text-ink-500">Graph Hacks · FalkorDB · All three tracks</p>
            <h1 id="story-title" className="lift poster mt-4 max-w-[16ch]">
              When a subway line breaks, Detour measures what the city can still carry.
            </h1>
            <div className="rise mt-5 flex max-w-[36rem] flex-col gap-5 lg:mt-6 lg:gap-6" style={{ animationDelay: "120ms" }}>
              <p className="order-2 text-ink-700 sm:text-lg lg:order-1">
                The real New York subway, built from the MTA&apos;s own data, lives in FalkorDB. Agents find whose trips a closure breaks, measure
                what the rest of the network can absorb with max flow, test shuttle bridges on forked copies of the graph, and tell every remembered
                rider what to take instead.
              </p>
              <div className="order-1 flex flex-wrap gap-3 lg:order-2">
                <Link
                  href="/control?scenario=l-canarsie&run=1"
                  className="rounded-md bg-signal px-5 py-3 font-display text-lg font-semibold tracking-wide text-signal-ink transition-transform duration-150 ease-out hover:-translate-y-px"
                >
                  Break the L train
                </Link>
                <Link
                  href="/proof"
                  className="rounded-md border border-line-strong px-5 py-3 font-display text-lg font-semibold tracking-wide text-ink-900 transition-colors duration-150 hover:bg-panel"
                >
                  See the proof
                </Link>
              </div>
              <dl className="order-3 grid grid-cols-3 gap-4 border-t border-line pt-4">
                {[
                  [fmt(FACTS.ridersAt8), "riders in the 8 a.m. hour"],
                  [fmt(FACTS.stations), "station complexes"],
                  [fmt(FACTS.segments), "scheduled segments"],
                ].map(([value, label]) => (
                  <div key={label}>
                    <dt className="sr-only">{label}</dt>
                    <dd className="tabular font-display text-2xl font-bold">{value}</dd>
                    <dd className="text-xs text-ink-500 sm:text-sm">{label}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <a href="#ch-who" className="label mt-8 inline-flex items-center gap-2 text-ink-500 transition-colors duration-150 hover:text-ink-900">
              Follow the morning the L broke
              <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
                <path d="M6 1.5v8M2.5 6.5 6 10l3.5-3.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>
        </header>

        <Chapter
          id="who"
          n="01"
          kicker="Who it hits"
          figure={fmt(story.impact.total)}
          tone="crit"
          unit="riders an hour on trips through the closed tube"
          title="Riders four stops away are hit too."
        >
          <p>
            {fmt(depth(0))} board at the closed stations. Count everyone whose trip crosses the tube from up to four stops away and it is{" "}
            {fmt(depth(4))}. An alert sent to the closed stations would miss most of them.
          </p>
          <p className="text-sm text-ink-500 max-sm:hidden">On the map: each station whose riders are hit, shaded by how many stops before the closure they board.</p>
        </Chapter>

        <Chapter
          id="where"
          n="02"
          kicker="Where they go"
          figure={`${worst.pct}%`}
          tone="crit"
          unit={`of capacity on the ${worst.route}, ${name(worst.from)} to ${name(worst.to)}`}
          title={`Left alone, they pile onto the ${overloadRoutes.join(" and ")}.`}
        >
          <p>
            On their fastest open paths, {fmt(story.reroute.rerouted)} riders an hour find another way, and {story.reroute.overloaded.length}{" "}
            {overloadRoutes.join(" and ")} segments run at {Math.min(...pcts)} to {Math.max(...pcts)}% of capacity. {fmt(story.reroute.stranded)} have no
            open rail path at all.
          </p>
        </Chapter>

        <Chapter
          id="carry"
          n="03"
          kicker="What it can carry"
          figure={`${Math.round((story.maxFlow.absorbed / story.maxFlow.required) * 100)}%`}
          tone="signal"
          unit="of riders headed into Manhattan could still move"
          title={`Spread perfectly, ${fmt(story.maxFlow.absorbed)} of ${fmt(story.maxFlow.required)} get through.`}
        >
          <p>
            FalkorDB runs max flow over every line&apos;s spare capacity on a copy of your graph: the most the open network could carry if every
            displaced rider were steered onto a line with room.
          </p>
        </Chapter>

        {stranded ? (
          <Chapter
            id="cut"
            n="04"
            kicker="The choke point"
            figure={name(stranded.id)}
            tone="crit"
            unit={`${fmt(stranded.riders)} riders an hour cannot move on rail`}
            title={`The min cut runs through ${name(stranded.id)}.`}
          >
            <p>
              Its only rail links are the closed L, so no spare capacity anywhere else reaches its riders. The cut, read from the max flow&apos;s
              residual graph, says where buses have to go.
            </p>
          </Chapter>
        ) : null}

        <Chapter
          id="fix"
          n="05"
          kicker="The fix, tested first"
          figure={`${fmt(story.plan.before.stranded)} → ${fmt(story.plan.after.stranded)}`}
          tone="signal"
          unit="riders an hour with no open path"
          title={`A shuttle from ${name(shuttle.from)} to ${name(shuttle.to)}, tested on a fork.`}
        >
          <p>
            The controller sized it at {shuttle.busesPerHour} buses an hour
            {memory && month
              ? `, ${memory.uplift}% more than the raw estimate, because memory says the ${month} shuttle carried only ${Math.round(
                  (memory.observed / memory.planned) * 100,
                )}% of plan${memory.example ? " (example data)" : ""}`
              : ""}
            . On its own copy of the graph, the max-flow shortfall drops from {fmt(story.plan.before.unmet)} to {fmt(story.plan.after.unmet)}.
          </p>
          <p>A person approves before any rider hears about it.</p>
        </Chapter>

        <Chapter
          id="riders"
          n="06"
          kicker="The riders"
          figure={fmt(story.riders.advised)}
          tone="ink"
          unit="remembered riders rerouted"
          title="Then the rider desk tells the people it remembers."
        >
          <p>
            One agent per affected rider finds their way around the break. {rider.name} ({rider.persona.toLowerCase()})
            {rider.stepFree ? " gets a route that keeps to step-free stations:" : " gets:"}
          </p>
          {rider.advisory ? <blockquote className="border-l-4 border-signal pl-3 font-display text-xl font-semibold text-ink-900">{rider.advisory}</blockquote> : null}
        </Chapter>
      </StoryStage>

      <TrimLine />

      {/* How it works: the tools as a strip map, one stop per step. */}
      <section aria-labelledby="how" className="deferred mx-auto w-full max-w-page px-4 py-16 sm:px-6 lg:py-24">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <p className="label text-ink-500">How it works</p>
            <h2 id="how" className="mt-3 font-display text-4xl font-bold leading-[0.95] sm:text-5xl lg:text-6xl">
              The agents choose the tools. The graph does the work.
            </h2>
            <p className="mt-5 max-w-prose text-lg text-ink-700">
              The model never writes Cypher. It picks from a fixed catalogue of graph tools, each a parameterized query with its row count and
              latency shown in the trace, and every answer is a path, a flow, a dated memory, or an honest &ldquo;not in the graph&rdquo;.
            </p>
            <p className="mt-4 max-w-prose text-sm text-ink-500">
              Weekday 8 a.m. capacity from MTA GTFS (trains per hour × planning load per train); demand from the MTA&apos;s 2025 origin-destination
              estimates ({fmt(FACTS.pairsKept)} of {fmt(FACTS.pairsTotal)} station pairs, {FACTS.ridersKeptPct}% of riders). The max-flow numbers are
              computed in FalkorDB and checked by a separate NetworkX implementation.
            </p>
          </div>
          <div className="relative min-w-0">
            <span aria-hidden="true" className="absolute bottom-6 left-[11px] top-3 w-1 rounded-full bg-ink-900" />
            <ol className="relative flex flex-col gap-10">
              {STEPS.map((s, i) => (
                <li key={s.title} className="relative flex min-w-0 gap-5">
                  <span aria-hidden="true" className="relative z-10 mt-1 size-[26px] shrink-0 rounded-full border-[5px] border-ink-900 bg-paper" />
                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <p className="label text-ink-500">Stop {String(i + 1).padStart(2, "0")}</p>
                    <h3 className="-mt-1 font-display text-2xl font-semibold">{s.title}</h3>
                    <p className="text-ink-700">{s.body}</p>
                    <CypherBlock code={s.cypher} />
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* Memory, on the station wall. */}
      <section aria-labelledby="memory" className="deferred tile border-y border-line bg-sunk">
        <div className="mx-auto grid w-full max-w-page gap-8 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-10 lg:py-24">
          <div className="self-start rounded-md border-2 border-ink-900 bg-paper p-6 sm:p-8">
            <p className="label text-ink-500">Track 2</p>
            <h2 id="memory" className="mt-3 font-display text-4xl font-bold leading-[0.95] sm:text-5xl">
              Agents that remember, and hand off through the graph.
            </h2>
            <p className="mt-5 max-w-prose text-ink-700">
              When a dispatcher approves a plan, the control agent hands off to the rider desk as graph state. One agent per remembered rider
              checks whether their usual trip crosses the closure and writes them an advisory. Facts carry dates and close when they stop being
              true, so an elevator outage remembered last week changes a wheelchair user&apos;s route today.
            </p>
            <Link href="/memory" className="label mt-6 inline-block text-signal-strong underline decoration-2 underline-offset-4 hover:text-ink-900">
              Open the memory
            </Link>
          </div>
          {/* The four kinds of memory on one tablet, each row signed like a platform sign. */}
          <ul className="self-center overflow-hidden rounded-md border-2 border-ink-900 bg-paper">
            {MEMORY.map(([k, v]) => (
              <li key={k} className="grid gap-2 border-b border-line p-5 last:border-b-0 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-5">
                <p>
                  <span className="sign-band label inline-block rounded-sm px-2 py-1">{k}</span>
                </p>
                <p className="text-ink-700">{v}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* The call to action is a station sign. */}
      <section className="sign-band sign-rule">
        <div className="mx-auto flex w-full max-w-page flex-col items-start gap-6 px-4 py-14 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:py-20">
          <p className="max-w-[20ch] font-display text-5xl font-bold leading-[0.95] sm:text-6xl">Close a line yourself and watch the agents measure it.</p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/control"
              className="rounded-md bg-sign-ink px-5 py-3 font-display text-lg font-semibold tracking-wide text-sign transition-transform duration-150 ease-out hover:-translate-y-px"
            >
              Open the control room
            </Link>
            <Link
              href="/riders"
              className="rounded-md border border-sign-ink/40 px-5 py-3 font-display text-lg font-semibold tracking-wide transition-colors duration-150 hover:bg-sign-ink/10"
            >
              Ask as a rider
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
