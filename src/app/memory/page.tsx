import type { Metadata } from "next";
import { MemoryRoom } from "@/components/memory/memory-room";
import { cypherCatalog } from "@/lib/proof";

export const metadata: Metadata = {
  title: "Memory",
  description: "What the agents know now, what stopped being true, every step they took, and how that memory is stored in the same FalkorDB graph as the subway.",
};

export default function MemoryPage() {
  const recall = cypherCatalog().find((c) => c.tool === "recall")?.queries ?? [];
  return <MemoryRoom recallQueries={recall.map((q) => ({ label: q.label, cypher: q.cypher }))} />;
}
