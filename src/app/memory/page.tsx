import type { Metadata } from "next";
import { MemoryRoom } from "@/components/memory/memory-room";
import { cypherCatalog } from "@/lib/proof";

export const metadata: Metadata = {
  title: "Memory",
  description: "What the agents know now, what stopped being true, every step they took, and how that memory is stored in the same FalkorDB graph as the subway.",
};

export default function MemoryPage() {
  const recall = cypherCatalog().find((c) => c.tool === "recall")?.queries ?? [];
  return (
    <>
      {/* The claim at poster scale, on the night stage. */}
      <header className="night border-b border-line">
        <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 pb-12 pt-12 sm:px-6 lg:pb-16 lg:pt-20">
          <p className="label text-ink-500">Memory · Track 2</p>
          <h1 className="lift max-w-[18ch] font-display text-5xl font-bold leading-[0.95] tracking-[-0.012em] sm:text-6xl lg:text-7xl">
            Memory is part of the graph, not a log beside it.
          </h1>
          <p className="max-w-prose text-lg text-ink-700">
            Agents read what earlier runs learned before they act, write what they find with a date and its source, and close facts that stop
            being true instead of deleting them.
          </p>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 pb-24 pt-10 sm:px-6">
        <MemoryRoom recallQueries={recall.map((q) => ({ label: q.label, cypher: q.cypher }))} />
      </div>
    </>
  );
}
