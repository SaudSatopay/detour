import type { CypherTrace, Tracer } from "../trace";

/**
 * Every answer has exactly one of four shapes (from the organizers' guide):
 *   answered        the graph held the relationships; the path or flow is attached
 *   memory          a previous session established it; returned with the date it was learned
 *   not_in_graph    the entities exist but nothing connects them the way the question assumed
 *   unknown_entity  a name did not resolve to anything in the graph, so no traversal ran
 */
export type Outcome = "answered" | "memory" | "not_in_graph" | "unknown_entity";

export interface FlowHighlight {
  kind: "RUNS" | "WALK" | "BUS";
  id: number;
  from: string;
  to: string;
  flow: number;
}

export interface CutHighlight {
  kind: "RUNS" | "WALK" | "BUS";
  id: number;
  from: string;
  to: string;
  spare: number;
  route?: string;
}

/** What the map should show for this result. */
export interface Highlight {
  stations?: string[];
  /** Station id -> hops from the closure (affected riders by depth). */
  depth?: Record<string, number>;
  closedEids?: number[];
  flows?: FlowHighlight[];
  cut?: CutHighlight[];
  shuttles?: { from: string; to: string; busesPerHour: number; capacity: number }[];
  /** Ordered station ids of a route answer. */
  path?: string[];
  pathEids?: number[];
}

export interface ToolResult<T = unknown> {
  tool: string;
  outcome: Outcome;
  /** One or two plain sentences the agent reads (and the UI shows under the tool call). */
  summary: string;
  data: T;
  trace: CypherTrace[];
  highlight?: Highlight;
}

export interface ToolContext {
  visitorId: string;
  /** The visitor's sandbox graph name. */
  sandbox: string;
  tracer: Tracer;
  /** Who is acting, recorded on memory writes. */
  agentId: string;
}

export function result<T>(ctx: ToolContext, tool: string, outcome: Outcome, summary: string, data: T, highlight?: Highlight): ToolResult<T> {
  return { tool, outcome, summary, data, trace: ctx.tracer.traces.splice(0), highlight };
}
