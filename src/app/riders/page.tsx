import type { Metadata } from "next";
import { RidersRoom } from "@/components/riders/riders-room";
import { SEED_FINDINGS, SEED_RIDERS } from "@/lib/graph/seed-memory";

export const metadata: Metadata = {
  title: "Riders",
  description: "Remembered riders with their usual trips, preferences and advisories. Route any of them on the live graph, and change a remembered fact to watch the route change.",
};

// Static: the seeded riders paint at once; the visitor's sandbox state replaces them on the client.
// Sorted by name, as the sandbox returns them, so the list does not reorder when it loads.
const seedRiders = [...SEED_RIDERS].sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({
  id: r.id,
  name: r.name,
  persona: r.persona,
  departs: r.departs,
  stepFree: r.stepFree,
  from: r.from,
  to: r.to,
  usualEids: [],
  usualStations: [r.from, r.to],
  usualMinutes: 0,
  preferences: r.preferences.map((p) => ({ key: p.key, value: p.value, sinceMs: Date.parse(p.since) })),
  advisory: null,
}));

const elevator = SEED_FINDINGS.find((f) => f.id === "F-ELEV-2")!;
const elevatorSeed = { text: elevator.text, kind: elevator.kind, validFromMs: Date.parse(elevator.validFrom) };

export default function RidersPage() {
  return <RidersRoom seedRiders={seedRiders} elevatorSeed={elevatorSeed} />;
}
