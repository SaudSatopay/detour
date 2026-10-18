import { copyGraph, deleteGraph, listGraphs } from "./db";
import { dropExpired, forgetSandbox, graphExists, sandboxEntries, touchSandbox } from "./meta";
import { FORK_PREFIX, SANDBOX_PREFIX, TEMPLATE_GRAPH, sandboxGraph } from "./names";
import { ensureBaseGraphs } from "./seed";

/**
 * One graph per visitor. A visitor's sandbox is a GRAPH.COPY of the template, so closures,
 * plans and memory written during a visit never touch anyone else's graph. The free FalkorDB
 * tier has 100 MB, so sandboxes are capped and the least recently used ones are dropped.
 */
const MAX_SANDBOXES = 24;
/** Long enough for a returning visitor's memory and conversation to still be there; the cap above still bounds space. */
const SANDBOX_TTL_MS = 3 * 24 * 60 * 60 * 1000;

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
  let copyMs = 0;
  let created = false;
  if (!(await graphExists(graph))) {
    await evictIfFull();
    const started = performance.now();
    try {
      await copyGraph(TEMPLATE_GRAPH, graph);
      created = true;
    } catch (error) {
      if (!(await graphExists(graph))) throw error;
    }
    copyMs = performance.now() - started;
  }
  await touchSandbox(visitorId);
  return { graph, created, copyMs };
}

export async function resetSandbox(visitorId: string): Promise<void> {
  const graph = sandboxGraph(visitorId);
  await dropForks(visitorId);
  if (await graphExists(graph)) await deleteGraph(graph);
  await ensureSandbox(visitorId);
}

/** Deletes a visitor's sandbox and forks and forgets it (used by the eval harness). */
export async function dropSandbox(visitorId: string): Promise<void> {
  await dropForks(visitorId);
  if (await graphExists(sandboxGraph(visitorId))) await deleteGraph(sandboxGraph(visitorId));
  await forgetSandbox(visitorId);
}

export async function dropForks(visitorId: string): Promise<void> {
  const prefix = `${FORK_PREFIX}${visitorId}:`;
  for (const name of await listGraphs()) {
    if (name.startsWith(prefix)) await deleteGraph(name);
  }
}

async function evictIfFull(): Promise<void> {
  const entries = await sandboxEntries();
  const now = Date.now();
  const stale = entries.filter((e) => now - e.seen > SANDBOX_TTL_MS);
  const live = entries.filter((e) => now - e.seen <= SANDBOX_TTL_MS).sort((a, b) => a.seen - b.seen);
  const overflow = Math.max(0, live.length - (MAX_SANDBOXES - 1));
  for (const e of [...stale, ...live.slice(0, overflow)]) await dropVisitor(e.id);
}

async function dropVisitor(id: string): Promise<void> {
  await dropForks(id);
  const graph = `${SANDBOX_PREFIX}${id}`;
  if (await graphExists(graph)) await deleteGraph(graph);
  await forgetSandbox(id);
}

/** Cron entry point: removes expired sandboxes, orphaned forks, and counters and locks past their time. */
export async function cleanupSandboxes(): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const now = Date.now();
  for (const { id, seen } of await sandboxEntries()) {
    if (now - seen <= SANDBOX_TTL_MS) continue;
    await dropVisitor(id);
    removed.push(id);
  }
  const live = new Set((await sandboxEntries()).map((e) => e.id));
  for (const name of await listGraphs()) {
    if (!name.startsWith(FORK_PREFIX)) continue;
    const visitor = name.slice(FORK_PREFIX.length).split(":")[0];
    if (!live.has(visitor)) await deleteGraph(name);
  }
  await dropExpired(now);
  return { removed };
}
