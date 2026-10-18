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

/** Drops the cached client, so the next call connects afresh. */
function forgetClient(): void {
  const g = globalThis as GlobalWithFalkor;
  const stale = g.__falkor;
  g.__falkor = undefined;
  void stale?.then((db) => db.close()).catch(() => undefined);
}

/** The connection failed or dropped (refused, timed out, reset, closed), as opposed to a query error. */
export function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|EAI_AGAIN|socket closed|socket hang up|connection is closed|client is closed|ClientClosedError|SocketClosedUnexpectedly|Connection timeout/i.test(message);
}

/** The command never reached the server, so running it again cannot apply it twice. */
function neverSent(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|client is closed|ClientClosedError|Connection timeout/i.test(message);
}

/**
 * Runs a database call once more on a fresh connection when the cached one dropped: FalkorDB Cloud closes idle
 * sockets, and a serverless instance can outlive its connection. Reads retry on any dropped connection; writes only
 * when the command was never sent.
 */
async function withReconnect<T>(call: () => Promise<T>, idempotent: boolean): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isConnectionError(error) || !(idempotent || neverSent(error))) throw error;
    console.warn(`[graph] reconnecting after: ${redact(error)}`);
    forgetClient();
    await new Promise((r) => setTimeout(r, 250));
    return call();
  }
}

/** An error's message without the database URL's credentials, for logs. */
export function redact(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/(falkors?|rediss?):\/\/[^\s@]*@/gi, "$1://<credentials>@").slice(0, 300);
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
  return withReconnect(async () => {
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
  }, readOnly);
}

export async function listGraphs(): Promise<string[]> {
  return withReconnect(async () => (await connect()).list(), true);
}

export async function copyGraph(source: string, destination: string): Promise<void> {
  await withReconnect(async () => (await connect()).selectGraph(source).copy(destination), false);
}

export async function deleteGraph(name: string): Promise<void> {
  await withReconnect(async () => (await connect()).selectGraph(name).delete(), true);
}
