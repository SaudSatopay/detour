import type { Outcome } from "../graph/tools/types";
import type { CypherTrace } from "../graph/trace";

/**
 * What a brain answer can cite. Sample org records are nodes in the visitor's graph; MTA records are nodes in the
 * shared agency graph.
 */
export type SourceKind =
  | "document"
  | "ticket"
  | "message"
  | "decision"
  | "finding"
  | "playbook"
  | "equipment"
  | "asset"
  | "outage"
  | "alert"
  | "notice"
  | "complaints"
  | "project"
  | "milestone"
  | "alternative";

/** Where a record comes from: the MTA's public data, the sample agency, or this visitor's own intake. */
export type SourceOrigin = "mta" | "sample" | "visitor";

/** The exact published text a citation rests on, where it was published, and when Detour read it. */
export interface Receipt {
  /** Dataset id, such as "mta-ene-outages" or "94fv-bak7". */
  dataset: string;
  /** The dataset's name. */
  source: string;
  /** A URL that returns this record (or the feed that lists it). */
  url: string;
  /** When Detour fetched it. */
  fetchedMs: number | null;
  /** The record's own words, verbatim. */
  quote: string;
  /** Content hash of the record as published. */
  hash: string | null;
}

export interface BrainSource {
  kind: SourceKind;
  /** Graph id, such as "DOC-AAR-0612", "EE-1207", "MSG-0612-1", "DEC-0612-SIZE" or "F-ELEV-2". */
  id: string;
  /** A document, ticket, decision or playbook title; a message or finding's own words, clipped. */
  title: string;
  /** Who wrote, filed, posted or decided it (a person, or an agent for findings). */
  by: string | null;
  team: string | null;
  /** When it was written, opened, posted or decided. */
  atMs: number | null;
  /** Tickets: "open" or "resolved". Findings: "current" or "closed". Decisions: "in force" or "superseded". */
  status: string | null;
  snippet: string | null;
  /** Stations and routes it is about, as display labels ("Myrtle-Wyckoff Avs", "L"). */
  about: string[];
  /** Real MTA record, sample org record, or the visitor's own; absent on older answers (sample). */
  origin?: SourceOrigin;
  /** MTA records only: the verbatim text, its source and time. */
  receipt?: Receipt | null;
}

/** One graph tool call behind an answer, with the Cypher it ran. */
export interface BrainStep {
  tool: string;
  outcome: Outcome;
  summary: string;
  trace: CypherTrace[];
}

export interface BrainAnswer {
  /** live: a free model chose the tools and wrote the answer. scripted: no model quota, the standard procedure did. */
  mode: "live" | "scripted";
  note: string | null;
  question: string;
  /** Plain text. Citations are written as [1], [2], … and index into `sources` (1-based). */
  answer: string;
  sources: BrainSource[];
  steps: BrainStep[];
  model: string | null;
  ms: number;
  /** A follow-up question read with what the previous answer was about ("it" as EL382). */
  followUp?: { entity: string; label: string } | null;
}

export interface BrainPerson {
  id: string;
  name: string;
  role: string;
}

export interface BrainOwned {
  kind: "route" | "station" | "playbook";
  id: string;
  label: string;
}

export interface BrainTeam {
  id: string;
  name: string;
  mission: string;
  people: BrainPerson[];
  owns: BrainOwned[];
}

/** One question and its answer, as stored in the visitor's graph: two Turn nodes chained by NEXT. */
export interface BrainTurn {
  /** The user turn's id. */
  id: string;
  question: string;
  answer: string;
  atMs: number;
  mode: string | null;
  /** Ids of the nodes the answer cited. */
  cites: string[];
}

/** The shared graph of real MTA records: what it holds and as of when. */
export interface AgencySummary {
  asOf: { outagesMs: number | null; alertsMs: number | null; equipmentMs: number | null; assetsMs: number | null; noticesMs: number | null; complaintsMs: number | null; projectsMs: number | null };
  /** "feed": read from the MTA by a refresh; "snapshot": the committed snapshot. */
  from: "feed" | "snapshot" | null;
  counts: { equipment: number; outagesOpen: number; outagesPlanned: number; outagesResolved: number; alerts: number; notices: number; complaints: number; projects: number };
  lastRefresh: { atMs: number; from: string; ok: boolean; opened: number; resolved: number; error: string | null } | null;
  sources: { id: string; name: string; page: string }[];
  /** A few units out of service now, newest first. */
  outages: BrainSource[];
}

/** What a refresh of the agency graph did. */
export interface AgencyRefreshReply {
  ok: boolean;
  from: "feed" | "snapshot" | "skipped";
  opened: number;
  resolved: number;
  reopened: number;
  alertsStarted: number;
  alertsEnded: number;
  ms: number;
  error?: string;
  agency: AgencySummary | null;
}

/** The org side of the graph, for the brain page's directory. */
export interface BrainDirectory {
  counts: { people: number; teams: number; documents: number; tickets: number; messages: number; decisions: number };
  teams: BrainTeam[];
  openTickets: BrainSource[];
  decisions: BrainSource[];
  suggestions: string[];
  /** This visitor's earlier questions and answers, newest first, read back from their graph. */
  history: BrainTurn[];
  /** The shared graph of real MTA records; null when it could not be read. */
  agency: AgencySummary | null;
}

export type IntakeKind = "message" | "ticket" | "note";

/** What adding a chat message, ticket or note to the brain did to the graph. */
export interface BrainIntake {
  kind: IntakeKind;
  /** The new node's id. */
  id: string;
  /** One or two sentences: what it was linked to and what work it created. */
  summary: string;
  stations: { id: string; name: string }[];
  routes: string[];
  people: string[];
  /** A ticket the intake filed (or the open one it joined), with its owner. */
  ticket: { id: string; title: string; assignee: string | null; role: string | null; team: string | null; created: boolean } | null;
  /** A memory finding the intake wrote or closed. */
  finding: { id: string; text: string } | null;
  sources: BrainSource[];
  steps: BrainStep[];
}
