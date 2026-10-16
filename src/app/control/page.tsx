import type { Metadata } from "next";
import { Suspense } from "react";
import scenarios from "../../../data/scenarios.json";
import { ControlRoom } from "@/components/control/control-room";

// The room streams in under Suspense; Next 16.4's dev-time instant-navigation check cannot render this segment, so opt out.
export const instant = false;

export const metadata: Metadata = {
  title: "Control room",
  description: "Close a subway line in your own copy of the graph and watch the agents measure who it hits, what the network can carry, and which plan fixes it.",
};

async function Room({ searchParams }: { searchParams: PageProps<"/control">["searchParams"] }) {
  const sp = await searchParams;
  const scenario = typeof sp.scenario === "string" ? sp.scenario : null;
  return <ControlRoom scenarios={scenarios} initialScenario={scenario} autoRun={sp.run === "1"} />;
}

export default function ControlPage({ searchParams }: PageProps<"/control">) {
  return (
    <Suspense fallback={<div className="h-[calc(100dvh-3rem)] animate-pulse bg-sunk" aria-busy="true" aria-label="Loading the control room" />}>
      <Room searchParams={searchParams} />
    </Suspense>
  );
}
