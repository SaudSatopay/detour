import type { MapOverlay, Overloaded } from "@/components/map/subway-map";
import type { FlowHighlight } from "@/lib/graph/tools/types";

/** The landing page's scroll story of the L closure: public/map/story-l-canarsie.json, built by scripts/build-story.mjs. */
export interface Story {
  source: string;
  names: Record<string, string>;
  incident: { title: string; report: string; routes: string[]; stretch: string[] };
  closedEids: number[];
  impact: {
    total: number;
    pairs: number;
    byDepth: { depth: number; riders: number; stations: number }[];
    depth: Record<string, number>;
    origins: string[];
  };
  reroute: {
    rerouted: number;
    stranded: number;
    overflow: number;
    overloaded: (Overloaded & { route: string; from: string; to: string })[];
    flows: FlowHighlight[];
  };
  maxFlow: { direction: string; required: number; absorbed: number; unmet: number; strandedAt: { id: string; riders: number }[]; flows: FlowHighlight[] };
  plan: {
    id: string;
    shuttles: { from: string; to: string; busesPerHour: number; capacity: number; vehicles: number; meters: number }[];
    vehicles: number;
    before: Totals;
    after: Totals;
    flows: FlowHighlight[];
    alternatives: number;
  };
  memory: { from: string; to: string; planned: number; observed: number; openedMs: number; example: boolean; uplift: number } | null;
  riders: {
    advised: number;
    featured: { id: string; name: string; persona: string; stepFree: boolean; minutes: number; advisory: string | null; path: string[]; pathEids: number[] };
  };
}

interface Totals {
  overflow: number;
  stranded: number;
  absorbed: number;
  unmet: number;
}

export const CHAPTERS = ["hero", "who", "where", "carry", "cut", "fix", "riders"] as const;
export type Chapter = (typeof CHAPTERS)[number];

/** Short names for the chapter rail. */
export const CHAPTER_LABELS: Record<Chapter, string> = {
  hero: "The break",
  who: "Who it hits",
  where: "Where they go",
  carry: "What it can carry",
  cut: "The choke point",
  fix: "The fix",
  riders: "The riders",
};

const fmt = (n: number) => n.toLocaleString("en-US");

/** The worst overloaded segment: where the reroute hurts most. */
export const worstOverload = (story: Story) => story.reroute.overloaded.reduce((a, b) => (b.pct > a.pct ? b : a), story.reroute.overloaded[0]);

/** Every station the story needs in frame, so the map holds one frame from the first chapter to the last. */
export function storyFocus(story: Story): string[] {
  const ids = new Set<string>([
    ...story.incident.stretch,
    ...story.reroute.overloaded.flatMap((o) => [o.from, o.to]),
    ...story.plan.shuttles.flatMap((s) => [s.from, s.to]),
    ...story.riders.featured.path,
  ]);
  return [...ids];
}

/**
 * What the sticky map draws for a chapter. The opening plays in three beats (`intro`): the network at
 * rest, the closure, then the displaced riders' flow.
 */
export function overlayFor(story: Story, chapter: Chapter, intro: 0 | 1 | 2 = 2): MapOverlay {
  const name = (id: string) => story.names[id] ?? id;
  const closedEids = story.closedEids;
  switch (chapter) {
    case "hero":
      if (intro === 0) return {};
      if (intro === 1) return { closedEids };
      return { closedEids, flows: story.reroute.flows, overloaded: story.reroute.overloaded };
    case "who":
      return { closedEids, depth: story.impact.depth };
    case "where": {
      const worst = worstOverload(story);
      return {
        closedEids,
        flows: story.reroute.flows,
        overloaded: story.reroute.overloaded,
        marks: [{ id: worst.from, label: `${worst.route} at ${worst.pct}%`, tone: "crit" }],
      };
    }
    case "carry":
      return { closedEids, flows: story.maxFlow.flows };
    case "cut":
      return {
        closedEids,
        flows: story.maxFlow.flows,
        marks: story.maxFlow.strandedAt.map((s) => ({ id: s.id, label: `${name(s.id)} · ${fmt(s.riders)}/h stuck`, tone: "crit" as const })),
      };
    case "fix":
      return {
        closedEids,
        flows: story.plan.flows,
        shuttles: story.plan.shuttles,
        marks: story.plan.shuttles.flatMap((s) => [
          { id: s.from, label: name(s.from), tone: "signal" as const },
          { id: s.to, label: name(s.to), tone: "signal" as const },
        ]),
      };
    case "riders": {
      const r = story.riders.featured;
      return {
        closedEids,
        shuttles: story.plan.shuttles,
        path: r.path,
        pathEids: r.pathEids,
        marks: [{ id: r.path[0], label: `${r.name} · ${name(r.path[0])}`, tone: "signal" }],
      };
    }
  }
}

/** The map's accessible name for a chapter, in words. */
export function mapLabelFor(story: Story, chapter: Chapter): string {
  const worst = worstOverload(story);
  const name = (id: string) => story.names[id] ?? id;
  switch (chapter) {
    case "hero":
      return `Map of the subway. The L is closed between ${name(story.incident.stretch[0])} and ${name(story.incident.stretch.at(-1)!)}, and displaced riders' fastest paths overload the G.`;
    case "who":
      return "Map of the stations whose riders' trips cross the closure, shaded by how many stops away they board.";
    case "where":
      return `Map of displaced riders on their fastest open paths. The ${worst.route} between ${name(worst.from)} and ${name(worst.to)} runs at ${worst.pct}% of capacity.`;
    case "carry":
      return "Map of the max-flow solution: how displaced riders would spread over every line's spare capacity.";
    case "cut":
      return `Map of the max-flow solution with ${name(story.maxFlow.strandedAt[0]?.id ?? "")} marked: its riders cannot move on rail.`;
    case "fix":
      return `Map of the shuttle plan: buses between ${story.plan.shuttles.map((s) => `${name(s.from)} and ${name(s.to)}`).join(", ")}.`;
    case "riders":
      return `Map of ${story.riders.featured.name}'s new route from ${name(story.riders.featured.path[0])} to ${name(story.riders.featured.path.at(-1)!)}.`;
  }
}
