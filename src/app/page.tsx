import Link from "next/link";
import { MapPanel } from "@/components/map/map-panel";

export default function Home() {
  return (
    <div className="mx-auto grid w-full max-w-[1440px] gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:py-16">
      <section className="flex flex-col justify-center gap-6">
        <p className="label text-ink-500">Graph Hacks · FalkorDB · Tracks 1 and 2</p>
        <h1 className="font-display text-4xl font-bold leading-[0.98] tracking-tight sm:text-5xl">
          When a subway line breaks, Detour measures what the city can still carry.
        </h1>
        <p className="max-w-[60ch] text-lg text-ink-700">
          Agents on a FalkorDB graph of the New York City subway, built from the MTA&apos;s own data. They find who a closure strands, push the
          displaced riders through the rest of the network with max flow, test shuttle bridges on forked copies of the graph, and tell each
          remembered rider what to take instead.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/control?scenario=l-canarsie" className="rounded-md bg-ink-900 px-5 py-3 font-display text-lg font-semibold tracking-wide text-paper transition-transform duration-150 hover:-translate-y-px">
            Break the L train
          </Link>
          <Link href="/proof" className="rounded-md border border-line-strong px-5 py-3 font-display text-lg font-semibold tracking-wide text-ink-900 transition-colors duration-150 hover:bg-sunk">
            See the proof
          </Link>
        </div>
      </section>
      <MapPanel className="aspect-square w-full overflow-hidden rounded-lg border border-line bg-panel lg:aspect-[5/6]" label="Map of the New York City subway: 445 stations and 26 routes from MTA GTFS data." />
    </div>
  );
}
