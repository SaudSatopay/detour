import type { Metadata } from "next";
import map from "../../../public/map/nyc.json";
import { BrainRoom } from "@/components/brain/brain-room";

export const metadata: Metadata = {
  title: "Agency brain",
  description:
    "Ask about the MTA's real elevators, outages, alerts and accessibility projects, and a sample agency's owners, tickets and decisions: one FalkorDB graph, every answer with its sources and receipts.",
};

// GTFS route colors (data, not brand tokens) by route id and by the name riders see ("GS" and "S"), built on the
// server so the map file never ships to the browser.
const routeColors: Record<string, string> = {};
for (const r of map.routes) {
  const color = r[2] as string;
  routeColors[r[0] as string] ??= color;
  routeColors[r[1] as string] ??= color;
}

/** Static: the directory and every answer load on the client, and ?q is read there. */
export default function BrainPage() {
  return (
    <>
      {/* The claim at poster scale, on the night stage. */}
      <header className="night border-b border-line">
        <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 pb-12 pt-12 sm:px-6 lg:pb-16 lg:pt-20">
          <p className="label text-ink-500">Agency brain · Track 3</p>
          <h1 className="lift max-w-[18ch] font-display text-5xl font-bold leading-[0.95] tracking-[-0.012em] sm:text-6xl lg:text-7xl">
            Who owns it, who knows it, and why we decided it.
          </h1>
          <div className="flex max-w-prose flex-col gap-3">
            <p className="text-lg text-ink-700">
              The MTA&apos;s own records (every elevator and escalator with who maintains it, every outage its feed has listed, live service alerts and
              their history, rider complaints and accessibility projects) sit in one shared FalkorDB graph beside a sample agency&apos;s people, teams,
              documents, tickets, chats and decisions. Every answer cites the records it came from, with the published text and when it was read.
            </p>
            <p className="text-sm text-ink-500">MTA records are real and labeled as such; the agency&apos;s people and their documents are sample data.</p>
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 pb-24 pt-10 sm:px-6">
        <BrainRoom routeColors={routeColors} />
      </div>
    </>
  );
}
