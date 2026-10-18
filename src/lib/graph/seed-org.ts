/**
 * The agency side of the graph: who works where, what each team owns, and the documents, tickets,
 * chat messages and decisions behind the seeded memory. Sample data, labeled as such in the UI; it is
 * wired to the real network (stations, routes) and to the seeded incidents, findings and playbook.
 */

export interface OrgTeam {
  id: string;
  name: string;
  mission: string;
  /** Route ids this team owns; `true` for every numbered (A Division) or lettered (B Division) route. */
  routes: string[] | "numbered" | "lettered";
  playbooks: string[];
  incidents: string[];
  /** Maintains every station with accessible platforms (elevators). */
  maintainsAccessible?: boolean;
}

export interface OrgPerson {
  id: string;
  name: string;
  role: string;
  team: string;
}

export interface OrgDocument {
  id: string;
  kind: "after-action" | "playbook" | "procedure" | "policy" | "notice";
  title: string;
  text: string;
  author: string;
  created: string;
  mentions: Mentions;
  /** A playbook node this document is the written form of. */
  describes?: string;
}

export interface OrgTicket {
  id: string;
  title: string;
  text: string;
  /** Platform the ticket is about, so a rider-desk report can resolve it. */
  station: string;
  route: string;
  status: "open" | "resolved";
  opened: string;
  resolved?: string;
  filedBy: string;
  assignedTo: string;
  mentions: Mentions;
}

export interface OrgMessage {
  id: string;
  channel: string;
  text: string;
  author: string;
  at: string;
  mentions: Mentions;
}

export interface OrgDecision {
  id: string;
  title: string;
  rationale: string;
  decidedBy: string;
  decided: string;
  /** Ids of documents, tickets, messages, findings or other decisions it rests on. */
  basedOn: string[];
  /** Ids of playbooks or documents it changed. */
  changed: string[];
  /** A ticket whose resolution lifts this decision. */
  until?: string;
  mentions: Mentions;
}

interface Mentions {
  stations?: string[];
  routes?: string[];
  incidents?: string[];
}

export const ORG_TEAMS: OrgTeam[] = [
  { id: "RCC", name: "Rail Control Center", mission: "Runs the response to every service disruption, around the clock.", routes: [], playbooks: [], incidents: ["INC-0612", "INC-0903"] },
  { id: "SPB", name: "Service Planning, B Division", mission: "Plans service and disruption playbooks for the lettered lines.", routes: "lettered", playbooks: ["PB-L-TUBE"], incidents: [] },
  { id: "SPA", name: "Service Planning, A Division", mission: "Plans service and disruption playbooks for the numbered lines.", routes: "numbered", playbooks: [], incidents: [] },
  { id: "BUS", name: "Bus Operations", mission: "Runs the shuttle bus bridges that replace closed rail segments.", routes: [], playbooks: [], incidents: [] },
  {
    id: "EE",
    name: "Elevator and Escalator Maintenance",
    mission: "Keeps the elevators at every accessible station in service.",
    routes: [],
    playbooks: [],
    incidents: [],
    maintainsAccessible: true,
  },
  { id: "ACC", name: "Accessibility Office", mission: "Sets step-free routing policy for the rider desk.", routes: [], playbooks: [], incidents: [] },
  { id: "COM", name: "Customer Communications", mission: "Writes service notices and accessibility alerts.", routes: [], playbooks: [], incidents: [] },
];

export const ORG_PEOPLE: OrgPerson[] = [
  { id: "P-ALVAREZ", name: "Renee Alvarez", role: "Superintendent, Rail Control Center", team: "RCC" },
  { id: "P-BELL", name: "Marcus Bell", role: "Desk dispatcher", team: "RCC" },
  { id: "P-RAMAN", name: "Priya Raman", role: "Senior planner, L, M and G", team: "SPB" },
  { id: "P-FITZGERALD", name: "Owen Fitzgerald", role: "Planner, A and C", team: "SPB" },
  { id: "P-CHO", name: "Hannah Cho", role: "Planner, Lexington Av lines", team: "SPA" },
  { id: "P-OKAFOR", name: "Tunde Okafor", role: "Bus bridge coordinator", team: "BUS" },
  { id: "P-MENDEZ", name: "Gloria Méndez", role: "Elevator maintenance lead", team: "EE" },
  { id: "P-HADDAD", name: "Sami Haddad", role: "Elevator technician", team: "EE" },
  { id: "P-LEE", name: "Jordan Lee", role: "Accessibility coordinator", team: "ACC" },
  { id: "P-PETROVA", name: "Elena Petrova", role: "Service notices editor", team: "COM" },
];

export const ORG_DOCUMENTS: OrgDocument[] = [
  {
    id: "DOC-AAR-0612",
    kind: "after-action",
    title: "After-action report: smoke in the Canarsie Tube, June 12",
    text: "The L was suspended between Bedford Av and 8 Av for 2 h 10 min. The Bedford Av to Marcy Av bus bridge was planned for 2,100 riders an hour and carried 1,650, 79% of plan: buses queued on the Williamsburg Bridge approach. G platform crowding at Metropolitan Av/Lorimer St reached the safety limit 26 minutes in. Recommendations: size L tube bus bridges on observed throughput, not nominal bus capacity; add two G trains an hour when the tube closes.",
    author: "P-ALVAREZ",
    created: "2026-06-12T14:00:00",
    mentions: { stations: ["120", "101", "629"], routes: ["L", "G"], incidents: ["INC-0612"] },
  },
  {
    id: "DOC-AAR-0903",
    kind: "after-action",
    title: "After-action report: water in the Cranberry Street Tunnel, September 3",
    text: "No A or C service between High St and Fulton St for 3 h. The Jay St-MetroTech to Fulton St bus bridge used the Brooklyn Bridge bus lane and carried 1,560 of the 1,680 riders an hour planned, 93% of plan. Recommendation: keep the bus lane arrangement for future Cranberry Street closures.",
    author: "P-BELL",
    created: "2026-09-03T13:00:00",
    mentions: { stations: ["636", "628"], routes: ["A", "C"], incidents: ["INC-0903"] },
  },
  {
    id: "DOC-PB-LTUBE",
    kind: "playbook",
    title: "Canarsie Tube closure playbook, revision 2",
    text: "Close the L between Bedford Av and 8 Av in both directions. Measure what the J/M/Z and the G can absorb toward Manhattan. Bridge Bedford Av to Marcy Av with buses sized on the corridor's observed throughput (revised after the June 12 after-action report). Add two G trains an hour if Metropolitan Av/Lorimer St is in the min cut.",
    author: "P-RAMAN",
    created: "2026-06-16T10:00:00",
    mentions: { stations: ["120", "101", "629"], routes: ["L", "G"] },
    describes: "PB-L-TUBE",
  },
  {
    id: "DOC-PROC-BUS",
    kind: "procedure",
    title: "Bus bridge sizing procedure",
    text: "Size each bus bridge from the observed throughput of the last bridge on the same corridor, not from nominal bus capacity. When that bridge carried less than 97% of plan, divide the raw bus estimate by its observed share: at 79% of plan, that is 27% more buses.",
    author: "P-OKAFOR",
    created: "2026-06-20T09:00:00",
    mentions: { routes: ["L", "A", "C"] },
  },
  {
    id: "DOC-POLICY-SF",
    kind: "policy",
    title: "Rider desk policy: step-free routing",
    text: "Step-free riders are routed only through stations whose boarding and exit platforms are accessible. An open elevator ticket blocks its platform until maintenance resolves it; the outage fact is then closed, not deleted, so its history stays queryable.",
    author: "P-LEE",
    created: "2026-03-02T09:00:00",
    mentions: {},
  },
  {
    id: "DOC-NOTICE-USQ",
    kind: "notice",
    title: "Accessibility alert: 14 St-Union Sq L platform elevator out of service",
    text: "The elevator to the L platform at 14 St-Union Sq is out of service. Step-free riders should use another station until further notice.",
    author: "P-PETROVA",
    created: "2026-10-02T06:40:00",
    mentions: { stations: ["602"], routes: ["L"] },
  },
  {
    id: "DOC-NOTICE-MW",
    kind: "notice",
    title: "Accessibility alert: Myrtle-Wyckoff Avs L platform elevator out of service",
    text: "The elevator to the L platform at Myrtle-Wyckoff Avs is out of service; the M platform elevator works. Step-free riders are routed by the M until the repair is done.",
    author: "P-PETROVA",
    created: "2026-10-14T06:30:00",
    mentions: { stations: ["630"], routes: ["L", "M"] },
  },
];

export const ORG_TICKETS: OrgTicket[] = [
  {
    id: "EE-1182",
    title: "14 St-Union Sq: L platform elevator out of service",
    text: "Door sensor fault; car stuck at the mezzanine. Replaced the sensor.",
    station: "602",
    route: "L",
    status: "resolved",
    opened: "2026-10-02T06:00:00",
    resolved: "2026-10-09T15:20:00",
    filedBy: "P-BELL",
    assignedTo: "P-HADDAD",
    mentions: { stations: ["602"], routes: ["L"] },
  },
  {
    id: "EE-1207",
    title: "Myrtle-Wyckoff Avs: L platform elevator out of service",
    text: "Motor controller fault. Replacement part ordered.",
    station: "630",
    route: "L",
    status: "open",
    opened: "2026-10-14T05:45:00",
    filedBy: "P-BELL",
    assignedTo: "P-MENDEZ",
    mentions: { stations: ["630"], routes: ["L"] },
  },
  {
    id: "BUS-0612-07",
    title: "Williamsburg Bridge approach congestion delayed bridge buses",
    text: "Bridge buses queued 12 to 18 minutes on the Williamsburg Bridge approach; throughput fell to 79% of plan.",
    station: "120",
    route: "L",
    status: "resolved",
    opened: "2026-06-12T08:35:00",
    resolved: "2026-06-12T10:08:00",
    filedBy: "P-OKAFOR",
    assignedTo: "P-OKAFOR",
    mentions: { stations: ["120", "101"], routes: ["L"], incidents: ["INC-0612"] },
  },
];

export const ORG_MESSAGES: OrgMessage[] = [
  {
    id: "MSG-0612-1",
    channel: "#rcc-ops",
    text: "Bedford Av bus bridge is running light: buses are stuck on the Williamsburg Bridge approach. Riders are walking to the G.",
    author: "P-BELL",
    at: "2026-06-12T08:31:00",
    mentions: { stations: ["120"], routes: ["L", "G"], incidents: ["INC-0612"] },
  },
  {
    id: "MSG-0612-2",
    channel: "#rcc-ops",
    text: "Metropolitan Av/Lorimer St G platform is at the crowding limit. Asking for two more G trains an hour.",
    author: "P-RAMAN",
    at: "2026-06-12T08:45:00",
    mentions: { stations: ["629"], routes: ["G"], incidents: ["INC-0612"] },
  },
  {
    id: "MSG-0612-3",
    channel: "#rcc-ops",
    text: "The bridge carried about 79% of plan today. Next time we should size it on observed throughput, not nominal capacity.",
    author: "P-OKAFOR",
    at: "2026-06-12T11:02:00",
    mentions: { stations: ["120", "101"], routes: ["L"], incidents: ["INC-0612"] },
  },
  {
    id: "MSG-0903-1",
    channel: "#rcc-ops",
    text: "The Brooklyn Bridge bus lane kept the Jay St shuttle moving: about 93% of plan.",
    author: "P-FITZGERALD",
    at: "2026-09-03T09:50:00",
    mentions: { stations: ["636", "628"], routes: ["A", "C"], incidents: ["INC-0903"] },
  },
  {
    id: "MSG-1009-1",
    channel: "#ee-dispatch",
    text: "14 St-Union Sq L platform elevator is back in service after a door sensor replacement.",
    author: "P-HADDAD",
    at: "2026-10-09T15:25:00",
    mentions: { stations: ["602"], routes: ["L"] },
  },
  {
    id: "MSG-1014-1",
    channel: "#ee-dispatch",
    text: "Myrtle-Wyckoff L platform elevator is down with a motor controller fault. Part ordered.",
    author: "P-HADDAD",
    at: "2026-10-14T05:52:00",
    mentions: { stations: ["630"], routes: ["L"] },
  },
];

export const ORG_DECISIONS: OrgDecision[] = [
  {
    id: "DEC-0616-SIZE",
    title: "Size L tube bus bridges on observed throughput",
    rationale: "The June 12 bridge carried 79% of plan because buses queued on the Williamsburg Bridge approach; sizing on nominal bus capacity left riders stranded.",
    decidedBy: "P-ALVAREZ",
    decided: "2026-06-16T09:00:00",
    basedOn: ["DOC-AAR-0612", "MSG-0612-3", "BUS-0612-07", "F-0612-1"],
    changed: ["PB-L-TUBE"],
    mentions: { stations: ["120", "101"], routes: ["L"], incidents: ["INC-0612"] },
  },
  {
    id: "DEC-0616-G",
    title: "Add two G trains an hour when the Canarsie Tube closes",
    rationale: "Metropolitan Av/Lorimer St G platform crowding hit the safety limit 26 minutes into the June 12 closure.",
    decidedBy: "P-RAMAN",
    decided: "2026-06-16T09:30:00",
    basedOn: ["F-0612-2", "MSG-0612-2", "DOC-AAR-0612"],
    changed: ["PB-L-TUBE"],
    mentions: { stations: ["629"], routes: ["G", "L"], incidents: ["INC-0612"] },
  },
  {
    id: "DEC-0620-BUSES",
    title: "Divide every bus bridge estimate by the corridor's observed share of plan",
    rationale: "It generalizes the L tube rule to every corridor: with the last L tube bridge at 79% of plan, the controller adds 27% more buses than the raw estimate; on the A and C, at 93%, it adds 8%.",
    decidedBy: "P-OKAFOR",
    decided: "2026-06-20T09:00:00",
    basedOn: ["DEC-0616-SIZE", "F-0612-1", "MSG-0612-3"],
    changed: ["DOC-PROC-BUS"],
    mentions: { routes: ["L", "A", "C"] },
  },
  {
    id: "DEC-1014-SF",
    title: "Route step-free riders around the Myrtle-Wyckoff Avs L platform until EE-1207 is resolved",
    rationale: "Ticket EE-1207 reports the L platform elevator out of service; the step-free routing policy blocks a platform while its elevator ticket is open.",
    decidedBy: "P-LEE",
    decided: "2026-10-14T07:00:00",
    basedOn: ["EE-1207", "DOC-POLICY-SF", "F-ELEV-2"],
    changed: [],
    until: "EE-1207",
    mentions: { stations: ["630"], routes: ["L", "M"] },
  },
];

/** Where each seeded finding came from. */
export const FINDING_SOURCES: Record<string, string[]> = {
  "F-0612-1": ["DOC-AAR-0612", "BUS-0612-07", "MSG-0612-3"],
  "F-0612-2": ["DOC-AAR-0612", "MSG-0612-2"],
  "F-0903-1": ["DOC-AAR-0903", "MSG-0903-1"],
  "F-ELEV-1": ["EE-1182", "DOC-NOTICE-USQ", "MSG-1009-1"],
  "F-ELEV-2": ["EE-1207", "DOC-NOTICE-MW", "MSG-1014-1"],
};

/** Questions the brain page offers: the first two about the sample agency, the rest about the MTA's real records. */
export const BRAIN_SUGGESTIONS = [
  "Who owns the Myrtle-Wyckoff elevator outage?",
  "Why do L tube bus bridges get 27% more buses?",
  "Which stations on the A have an elevator out of service?",
  "What is the MTA's alternative route when elevator EL293 is out?",
  "What milestones has the ADA project at Broadway Junction reached?",
  "What changed in the last 7 days?",
];
