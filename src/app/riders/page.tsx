import type { Metadata } from "next";
import { Suspense } from "react";
import { RidersRoom } from "@/components/riders/riders-room";

// The room streams in under Suspense; Next 16.4's dev-time instant-navigation check cannot render this segment, so opt out.
export const instant = false;

export const metadata: Metadata = {
  title: "Riders",
  description: "Remembered riders with their usual trips, preferences and advisories. Route any of them on the live graph, and change a remembered fact to watch the route change.",
};

async function Room({ searchParams }: { searchParams: PageProps<"/riders">["searchParams"] }) {
  const sp = await searchParams;
  return <RidersRoom initialRider={typeof sp.rider === "string" ? sp.rider : null} />;
}

export default function RidersPage({ searchParams }: PageProps<"/riders">) {
  return (
    <Suspense fallback={<div className="h-[calc(100dvh-3rem)] animate-pulse bg-sunk" aria-busy="true" aria-label="Loading riders" />}>
      <Room searchParams={searchParams} />
    </Suspense>
  );
}
