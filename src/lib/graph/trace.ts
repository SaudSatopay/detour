import { run, type GraphParams, type QueryResult, type RunOptions } from "./db";

/** One Cypher query as the UI and README show it: what ran, where, how long, how many rows. */
export interface CypherTrace {
  label: string;
  graph: string;
  cypher: string;
  params: GraphParams;
  ms: number;
  serverMs: number | null;
  rows: number;
}

/** Collects every query a tool runs so the answer can be shown with the Cypher behind it. */
export class Tracer {
  readonly traces: CypherTrace[] = [];

  async run<T = Record<string, unknown>>(
    label: string,
    graph: string,
    cypher: string,
    params: GraphParams = {},
    options: RunOptions = {},
  ): Promise<QueryResult<T>> {
    const result = await run<T>(graph, cypher, params, options);
    this.traces.push({
      label,
      graph,
      cypher: tidy(cypher),
      params: summarizeParams(params),
      ms: round(result.ms),
      serverMs: result.serverMs === null ? null : round(result.serverMs),
      rows: result.rows.length,
    });
    return result;
  }

  /** Records a non-query graph command (GRAPH.COPY, GRAPH.DELETE) with its timing. */
  async command(label: string, graph: string, description: string, fn: () => Promise<void>): Promise<void> {
    const started = performance.now();
    await fn();
    this.traces.push({ label, graph, cypher: description, params: {}, ms: round(performance.now() - started), serverMs: null, rows: 0 });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Collapses indentation so queries read cleanly in the trace panel. */
export function tidy(cypher: string): string {
  return cypher
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** Keeps traces small: long lists are shortened to their length and first items. */
export function summarizeParams(params: GraphParams): GraphParams {
  const out: GraphParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value) && value.length > 8) {
      out[key] = [...value.slice(0, 5), `… ${value.length - 5} more`];
    } else {
      out[key] = value;
    }
  }
  return out;
}
