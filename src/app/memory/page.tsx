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
    <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 pb-24 pt-10 sm:px-6">
      <header className="flex max-w-[70ch] flex-col gap-4">
        <p className="label text-ink-500">Memory</p>
        <h1 className="font-display text-4xl font-bold leading-[0.98] tracking-tight sm:text-5xl">Memory is part of the graph, not a log beside it.</h1>
        <p className="text-lg text-ink-700">
          Agents read what earlier runs learned before they act, write what they find with a date and its source, and close facts that stop
          being true instead of deleting them.
        </p>
      </header>
      <MemoryRoom recallQueries={recall.map((q) => ({ label: q.label, cypher: q.cypher }))} />
    </div>
  );
}
