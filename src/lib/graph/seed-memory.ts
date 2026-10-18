/**
 * Seeded memory for the template graph. Everything here is example history and synthetic riders,
 * clearly labeled as such in the UI; the network itself is real MTA data.
 */

interface SeedRider {
  id: string;
  name: string;
  persona: string;
  from: string;
  to: string;
  departs: string;
  stepFree: boolean;
  /** Preference facts, each with when it became true. */
  preferences: { key: string; value: string; since: string }[];
}

interface SeedFinding {
  id: string;
  text: string;
  kind: "observation" | "capacity" | "accessibility" | "crowding";
  about: { stations?: string[]; routes?: string[] };
  incident?: string;
  validFrom: string;
  validTo?: string;
  confidence: number;
  agent: string;
}

interface SeedIncident {
  id: string;
  title: string;
  report: string;
  routes: string[];
  stations: string[];
  openedAt: string;
  closedAt: string;
  shuttles: { from: string; to: string; busesPerHour: number; planned: number; observed: number }[];
}

interface SeedPlaybook {
  id: string;
  title: string;
  routes: string[];
  /** The stretch it is written for: an incident applies it only when its closure overlaps these stations. */
  stations: string[];
  steps: string[];
  revision: number;
  uses: number;
  lastUsed: string;
}

export const SEED_AGENTS = [
  { id: "controller", role: "controller", name: "Control desk" },
  { id: "rider-desk", role: "rider", name: "Rider desk" },
  { id: "scribe", role: "scribe", name: "Scribe" },
] as const;

export const SEED_RIDERS: SeedRider[] = [
  {
    id: "maya",
    name: "Maya",
    persona: "ICU nurse, day shift",
    from: "125", // Morgan Av (L)
    to: "602", // 14 St-Union Sq
    departs: "07:50",
    stepFree: false,
    preferences: [{ key: "avoid", value: "crowded transfers", since: "2026-09-02" }],
  },
  {
    id: "dev",
    name: "Dev",
    persona: "Line cook, breakfast service",
    from: "120", // Bedford Av (L)
    to: "618", // 14 St/8 Av
    departs: "08:05",
    stepFree: false,
    preferences: [{ key: "prefers", value: "fewest transfers", since: "2026-08-20" }],
  },
  {
    id: "aisha",
    name: "Aisha",
    persona: "Architect, uses a wheelchair",
    from: "630", // Myrtle-Wyckoff Avs (M,L)
    to: "601", // 14 St/6 Av
    departs: "08:10",
    stepFree: true,
    preferences: [{ key: "needs", value: "step-free stations only", since: "2026-03-14" }],
  },
  {
    id: "tomas",
    name: "Tomás",
    persona: "High-school teacher",
    from: "138", // Canarsie-Rockaway Pkwy (L)
    to: "602", // 14 St-Union Sq
    departs: "07:35",
    stepFree: false,
    preferences: [],
  },
  {
    id: "grace",
    name: "Grace",
    persona: "Paralegal, downtown",
    from: "636", // Jay St-MetroTech
    to: "628", // Fulton St
    departs: "08:20",
    stepFree: false,
    preferences: [{ key: "prefers", value: "walking over buses", since: "2026-07-01" }],
  },
  {
    id: "sam",
    name: "Sam",
    persona: "Analyst, Financial District",
    from: "610", // Grand Central-42 St
    to: "622", // Brooklyn Bridge-City Hall
    departs: "08:15",
    stepFree: false,
    preferences: [],
  },
  {
    id: "lena",
    name: "Lena",
    persona: "Graduate student",
    from: "1", // Astoria-Ditmars Blvd
    to: "611", // Times Sq-42 St
    departs: "08:00",
    stepFree: false,
    preferences: [],
  },
  {
    id: "kwame",
    name: "Kwame",
    persona: "Bank operations lead",
    from: "345", // Crown Hts-Utica Av
    to: "628", // Fulton St
    departs: "07:45",
    stepFree: false,
    preferences: [{ key: "prefers", value: "express trains", since: "2026-05-11" }],
  },
];

export const SEED_INCIDENTS: SeedIncident[] = [
  {
    id: "INC-0612",
    title: "Smoke condition, Canarsie Tube",
    report: "Smoke condition in the Canarsie Tube. No L service between Bedford Av and 8 Av for 2 h 10 min.",
    routes: ["L"],
    stations: ["120", "119", "118", "602", "601", "618"],
    openedAt: "2026-06-12T07:58:00",
    closedAt: "2026-06-12T10:08:00",
    shuttles: [{ from: "120", to: "101", busesPerHour: 30, planned: 2100, observed: 1650 }],
  },
  {
    id: "INC-0903",
    title: "Water condition, Cranberry Street Tunnel",
    report: "Water condition in the Cranberry Street Tunnel. No A or C trains between High St and Fulton St for 3 h.",
    routes: ["A", "C"],
    stations: ["173", "628"],
    openedAt: "2026-09-03T06:40:00",
    closedAt: "2026-09-03T09:45:00",
    shuttles: [{ from: "636", to: "628", busesPerHour: 24, planned: 1680, observed: 1560 }],
  },
];

export const SEED_FINDINGS: SeedFinding[] = [
  {
    id: "F-0612-1",
    text: "The Bedford Av to Marcy Av shuttle carried 1,650 riders an hour, 79% of the 2,100 planned: buses queued on the Williamsburg Bridge approach.",
    kind: "capacity",
    about: { stations: ["120", "101"], routes: ["L"] },
    incident: "INC-0612",
    validFrom: "2026-06-12T10:30:00",
    confidence: 0.9,
    agent: "scribe",
  },
  {
    id: "F-0612-2",
    text: "During the L closure, Metropolitan Av/Lorimer St G platform crowding hit the safety limit 26 minutes in; the G needed 2 more trains an hour.",
    kind: "crowding",
    about: { stations: ["629"], routes: ["G"] },
    incident: "INC-0612",
    validFrom: "2026-06-12T10:30:00",
    confidence: 0.85,
    agent: "scribe",
  },
  {
    id: "F-0903-1",
    text: "The Jay St-MetroTech to Fulton St shuttle carried 1,560 riders an hour, 93% of plan, using the Brooklyn Bridge bus lane.",
    kind: "capacity",
    about: { stations: ["636", "628"], routes: ["A", "C"] },
    incident: "INC-0903",
    validFrom: "2026-09-03T10:00:00",
    confidence: 0.9,
    agent: "scribe",
  },
  {
    id: "F-ELEV-1",
    text: "Elevator to the L platform at 14 St-Union Sq out of service.",
    kind: "accessibility",
    about: { stations: ["602"], routes: ["L"] },
    validFrom: "2026-10-02T06:00:00",
    validTo: "2026-10-09T15:20:00",
    confidence: 1,
    agent: "rider-desk",
  },
  {
    id: "F-ELEV-2",
    text: "Elevator to the L platform at Myrtle-Wyckoff Avs out of service; M platform elevator works.",
    kind: "accessibility",
    about: { stations: ["630"], routes: ["L"] },
    validFrom: "2026-10-14T05:45:00",
    confidence: 1,
    agent: "rider-desk",
  },
];

export const SEED_PLAYBOOKS: SeedPlaybook[] = [
  {
    id: "PB-L-TUBE",
    title: "Canarsie Tube closure",
    routes: ["L"],
    stations: ["120", "119", "118", "602", "601", "618"],
    // Revision 2 (DOC-PB-LTUBE), after decisions DEC-0616-SIZE and DEC-0616-G.
    steps: [
      "Close the L between Bedford Av and 8 Av in both directions.",
      "Measure what the J/M/Z and G can absorb toward Manhattan.",
      "Bridge Bedford Av to Marcy Av with buses sized on the corridor's observed throughput: the June 12 bridge carried 79% of plan.",
      "Add two G trains an hour if Metropolitan Av/Lorimer St is in the min cut.",
    ],
    revision: 2,
    uses: 1,
    lastUsed: "2026-06-12T10:30:00",
  },
];
