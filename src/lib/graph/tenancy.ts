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

export async function ensureSandbox(visitorId: string): Promise<{ graph: string; created: boolean; copyMs: number }> {
  await ensureBase();
  const graph = sandboxGraph(visitorId);
  const db = await connect();
  const redis = await db.connection;
  const exists = (await redis.exists(graph)) === 1;
  let copyMs = 0;
  if (!exists) {
    await evictIfFull(redis);
    const started = performance.now();
    await copyGraph(TEMPLATE_GRAPH, graph);
    copyMs = performance.now() - started;
  }
  await redis.hSet(REGISTRY, visitorId, String(Date.now()));
  return { graph, created: !exists, copyMs };
}

export async function resetSandbox(visitorId: string): Promise<void> {
  const graph = sandboxGraph(visitorId);
  await dropForks(visitorId);
  const db = await connect();
  const redis = await db.connection;
  if ((await redis.exists(graph)) === 1) await deleteGraph(graph);
  await ensureSandbox(visitorId);
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
