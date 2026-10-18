import scenarios from "../../data/scenarios.json";
import map from "../../public/map/nyc.json";
import { SEED_RIDERS } from "@/lib/graph/seed-memory";

/** One place the command palette can take you. Built on the server, so no seed data ships to the browser. */
export interface PaletteItem {
  id: string;
  group: "Closures" | "Riders" | "Pages" | "Story" | "Proof";
  label: string;
  hint?: string;
  href: string;
  /** GTFS route colors for the chips beside a closure (data, not brand tokens). */
  colors?: { route: string; hex: string }[];
  keywords?: string;
}

const COLOR = new Map(map.routes.map((r) => [r[0] as string, r[2] as string]));

const BRAIN_QUESTIONS = [
  "Who owns the Myrtle-Wyckoff elevator outage?",
  "Why do L tube bus bridges get 27% more buses?",
  "Who knows the most about the G at Metropolitan Av?",
  "What changed in the last 7 days?",
];

export function paletteItems(): PaletteItem[] {
  const closures: PaletteItem[] = scenarios.map((s) => ({
    id: `closure-${s.id}`,
    group: "Closures",
    label: s.title,
    hint: "Run the controller",
    href: `/control?scenario=${s.id}&run=1`,
    colors: s.routes.map((route) => ({ route, hex: COLOR.get(route) ?? "808183" })),
    keywords: `${s.routes.join(" ")} ${s.report}`,
  }));
  const riders: PaletteItem[] = [...SEED_RIDERS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({ id: `rider-${r.id}`, group: "Riders", label: `${r.name}'s trip`, hint: r.persona, href: `/riders?rider=${r.id}`, keywords: r.persona }));
  const pages: PaletteItem[] = [
    { id: "page-home", group: "Pages", label: "Home", hint: "The L closure, chapter by chapter", href: "/" },
    { id: "page-control", group: "Pages", label: "Control room", hint: "Close a line and watch the agents", href: "/control" },
    { id: "page-riders", group: "Pages", label: "Riders", hint: "Remembered riders and their routes", href: "/riders" },
    { id: "page-memory", group: "Pages", label: "Memory", hint: "Facts over time, episodes, handoffs", href: "/memory" },
    {
      id: "page-brain",
      group: "Pages",
      label: "Agency brain",
      hint: "Who owns it, who knows it, and why",
      href: "/brain",
      keywords: "company brain teams people documents tickets chats decisions owner expert sources",
    },
    { id: "page-proof", group: "Pages", label: "Proof", hint: "FalkorDB against NetworkX", href: "/proof" },
    // Questions for the agency brain: the page asks ?q as it opens.
    ...BRAIN_QUESTIONS.map((q, i) => ({
      id: `brain-ask-${i + 1}`,
      group: "Pages" as const,
      label: q,
      hint: "Ask the agency brain",
      href: `/brain?q=${encodeURIComponent(q)}`,
      keywords: "agency company brain ask question",
    })),
  ];
  const story: PaletteItem[] = [
    ["who", "Who it hits", "riders by stops from the closure"],
    ["where", "Where they go", "the G overload"],
    ["carry", "What it can carry", "max flow"],
    ["cut", "The choke point", "min cut"],
    ["fix", "The fix", "a shuttle tested on a fork"],
    ["riders", "The riders", "advisories after approval"],
  ].map(([id, label, hint]) => ({ id: `story-${id}`, group: "Story" as const, label, hint, href: `/#ch-${id}`, keywords: "L closure story chapter" }));
  const proof: PaletteItem[] = [
    ["agreement", "FalkorDB vs NetworkX", "max flow on every closure"],
    ["concurrency", "Many agents at once", "tenant isolation under load"],
    ["cost", "What each tool costs", "queries and milliseconds"],
    ["data", "Data and assumptions", "MTA sources"],
    ["cypher", "Every query", "the Cypher behind every tool"],
  ].map(([id, label, hint]) => ({ id: `proof-${id}`, group: "Proof" as const, label, hint, href: `/proof#${id}`, keywords: "proof check" }));
  return [...closures, ...riders, ...pages, ...story, ...proof];
}
