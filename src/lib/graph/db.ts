import { FalkorDB } from "falkordb";

/**
 * One FalkorDB connection per server instance. Serverless functions reuse warm
 * instances, so the promise is parked on globalThis and dropped again if the
 * connection fails, which lets the next request retry.
 */
type GlobalWithFalkor = typeof globalThis & { __falkor?: Promise<FalkorDB> };

class GraphConfigError extends Error {
  constructor() {
    super(
      "FALKORDB_URL is not set. Copy .env.example to .env.local and point it at a FalkorDB instance (falkor://<username>:<password>@<host>:<port>; falkors:// for TLS).",
    );
    this.name = "GraphConfigError";
  }
}

export function connect(): Promise<FalkorDB> {
  const g = globalThis as GlobalWithFalkor;
  if (!g.__falkor) {
    const url = process.env.FALKORDB_URL;
    if (!url) throw new GraphConfigError();
    g.__falkor = FalkorDB.connect({
      url,
      socket: { connectTimeout: 8_000, keepAlive: 5_000, noDelay: true },
    }).then(
      (db) => {
        db.on("error", () => {
          // A dropped socket poisons the cached client; reconnect on next use.
          (globalThis as GlobalWithFalkor).__falkor = undefined;
        });
        return db;
      },
      (err: unknown) => {
        (globalThis as GlobalWithFalkor).__falkor = undefined;
        throw err;
      },
    );
  }
  return g.__falkor;
}

export type QueryStats = Record<string, number>;

/** Mirrors the client's (unexported) QueryParams type. */
export type GraphParam = null | string | number | boolean | GraphParams | GraphParam[];
export type GraphParams = { [key: string]: GraphParam };

export interface QueryResult<T> {
  rows: T[];
  /** Round trip measured by this process, in milliseconds. */
  ms: number;
  /** FalkorDB's own "Query internal execution time", in milliseconds. */
  serverMs: number | null;
  stats: QueryStats;
}

export interface RunOptions {
  readOnly?: boolean;
  timeoutMs?: number;
}

const INTERNAL_TIME = "Query internal execution time";

export function parseMetadata(metadata: readonly string[] | undefined): {
  serverMs: number | null;
  stats: QueryStats;
} {
  const stats: QueryStats = {};
  let serverMs: number | null = null;
  for (const line of metadata ?? []) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = Number.parseFloat(line.slice(idx + 1));
    if (Number.isNaN(value)) continue;
    if (key === INTERNAL_TIME) serverMs = value;
    else stats[key] = value;
  }
  return { serverMs, stats };
}

export async function run<T = Record<string, unknown>>(
  graphName: string,
  cypher: string,
  params: GraphParams = {},
  { readOnly = false, timeoutMs = 10_000 }: RunOptions = {},
): Promise<QueryResult<T>> {
  const db = await connect();
  const graph = db.selectGraph(graphName);
  const started = performance.now();
  const options = { params, TIMEOUT: timeoutMs };
  const reply = readOnly
    ? await graph.roQuery<T>(cypher, options)
    : await graph.query<T>(cypher, options);
  const ms = performance.now() - started;
  const { serverMs, stats } = parseMetadata(reply.metadata as string[] | undefined);
  return { rows: (reply.data ?? []) as T[], ms, serverMs, stats };
}

export async function listGraphs(): Promise<string[]> {
  const db = await connect();
  return db.list();
}

export async function copyGraph(source: string, destination: string): Promise<void> {
  const db = await connect();
  await db.selectGraph(source).copy(destination);
}

export async function deleteGraph(name: string): Promise<void> {
  const db = await connect();
  await db.selectGraph(name).delete();
}
