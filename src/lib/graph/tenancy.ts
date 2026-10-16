import { connect, copyGraph, deleteGraph, listGraphs } from "./db";
import { FORK_PREFIX, SANDBOX_PREFIX, TEMPLATE_GRAPH, sandboxGraph } from "./names";
import { ensureBaseGraphs } from "./seed";

/**
 * One graph per visitor. A visitor's sandbox is a GRAPH.COPY of the template, so closures,
 * plans and memory written during a visit never touch anyone else's graph. The free FalkorDB
 * tier has 100 MB, so sandboxes are capped and the least recently used ones are dropped.
 */
const REGISTRY = "detour:sandboxes";
const MAX_SANDBOXES = 24;
const SANDBOX_TTL_MS = 6 * 60 * 60 * 1000;

let baseReady: Promise<void> | null = null;

/** Seeds the shared graphs once per server instance (self-healing if the database was wiped). */
export function ensureBase(): Promise<void> {
  baseReady ??= ensureBaseGraphs().catch((err) => {
    baseReady = null;
    throw err;
  });
  return baseReady;
}

type Sandbox = { graph: string; created: boolean; copyMs: number };
const pending = new Map<string, Promise<Sandbox>>();

/**
 * A new visitor's first page load fires several requests at once (state, an auto-started run); they
 * share one copy here, and a copy that loses a race with another server instance (the graph already
 * exists when GRAPH.COPY runs) counts as done.
 */
export function ensureSandbox(visitorId: string): Promise<Sandbox> {
  let job = pending.get(visitorId);
  if (!job) {
    job = createSandbox(visitorId).finally(() => pending.delete(visitorId));
    pending.set(visitorId, job);
  }
  return job;
}

async function createSandbox(visitorId: string): Promise<Sandbox> {
  await ensureBase();
  const graph = sandboxGraph(visitorId);
  const db = await connect();
  const redis = await db.connection;
  const exists = (await redis.exists(graph)) === 1;
  let copyMs = 0;
  let created = false;
  if (!exists) {
    await evictIfFull(redis);
    const started = performance.now();
    try {
      await copyGraph(TEMPLATE_GRAPH, graph);
      created = true;
    } catch (error) {
      if ((await redis.exists(graph)) !== 1) throw error;
    }
    copyMs = performance.now() - started;
  }
  await redis.hSet(REGISTRY, visitorId, String(Date.now()));
  return { graph, created, copyMs };
}

export async function resetSandbox(visitorId: string): Promise<void> {
  const graph = sandboxGraph(visitorId);
  await dropForks(visitorId);
  const db = await connect();
  const redis = await db.connection;
  if ((await redis.exists(graph)) === 1) await deleteGraph(graph);
  await ensureSandbox(visitorId);
}

/** Deletes a visitor's sandbox and forks and forgets it (used by the eval harness). */
export async function dropSandbox(visitorId: string): Promise<void> {
  await dropForks(visitorId);
  const db = await connect();
  const redis = await db.connection;
  if ((await redis.exists(sandboxGraph(visitorId))) === 1) await deleteGraph(sandboxGraph(visitorId));
  await redis.hDel(REGISTRY, visitorId);
}

export async function dropForks(visitorId: string): Promise<void> {
  const prefix = `${FORK_PREFIX}${visitorId}:`;
  for (const name of await listGraphs()) {
    if (name.startsWith(prefix)) await deleteGraph(name);
  }
}

type Redis = Awaited<Awaited<ReturnType<typeof connect>>["connection"]>;

async function evictIfFull(redis: Redis): Promise<void> {
  const entries = Object.entries(await redis.hGetAll(REGISTRY)).map(([id, seen]) => ({ id, seen: Number(seen) }));
  const now = Date.now();
  const stale = entries.filter((e) => now - e.seen > SANDBOX_TTL_MS);
  const live = entries.filter((e) => now - e.seen <= SANDBOX_TTL_MS).sort((a, b) => a.seen - b.seen);
  const overflow = Math.max(0, live.length - (MAX_SANDBOXES - 1));
  for (const e of [...stale, ...live.slice(0, overflow)]) {
    await dropForks(e.id);
    const graph = `${SANDBOX_PREFIX}${e.id}`;
    if ((await redis.exists(graph)) === 1) await deleteGraph(graph);
    await redis.hDel(REGISTRY, e.id);
  }
}

/** Cron entry point: removes expired sandboxes and orphaned forks. */
export async function cleanupSandboxes(): Promise<{ removed: string[] }> {
  const db = await connect();
  const redis = await db.connection;
  const entries = Object.entries(await redis.hGetAll(REGISTRY));
  const removed: string[] = [];
  const now = Date.now();
  for (const [id, seen] of entries) {
    if (now - Number(seen) <= SANDBOX_TTL_MS) continue;
    await dropForks(id);
    const graph = `${SANDBOX_PREFIX}${id}`;
    if ((await redis.exists(graph)) === 1) await deleteGraph(graph);
    await redis.hDel(REGISTRY, id);
    removed.push(id);
  }
  const live = new Set(Object.keys(await redis.hGetAll(REGISTRY)));
  for (const name of await listGraphs()) {
    if (!name.startsWith(FORK_PREFIX)) continue;
    const visitor = name.slice(FORK_PREFIX.length).split(":")[0];
    if (!live.has(visitor)) await deleteGraph(name);
  }
  return { removed };
}
