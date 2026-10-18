import type { Outcome } from "../graph/tools/types";
import type { CypherTrace } from "../graph/trace";

/** What a brain answer can cite. Every source is a node in the visitor's graph. */
export type SourceKind = "document" | "ticket" | "message" | "decision" | "finding" | "playbook";

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

/** The org side of the graph, for the brain page's directory. */
export interface BrainDirectory {
  counts: { people: number; teams: number; documents: number; tickets: number; messages: number; decisions: number };
  teams: BrainTeam[];
  openTickets: BrainSource[];
  decisions: BrainSource[];
  suggestions: string[];
}
