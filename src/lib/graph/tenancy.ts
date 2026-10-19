import { copyGraph, deleteGraph, listGraphs } from "./db";
import { dropExpired, forgetSandbox, graphExists, holdSandbox, releaseSandbox, sandboxEntries, touchSandbox } from "./meta";
import { FORK_PREFIX, SANDBOX_PREFIX, TEMPLATE_GRAPH, sandboxGraph } from "./names";
import { ensureBaseGraphs } from "./seed";

/**
 * One graph per visitor. A visitor's sandbox is a GRAPH.COPY of the template, so closures,
 * plans and memory written during a visit never touch anyone else's graph. The free FalkorDB
 * tier has 100 MB, so sandboxes are capped and the least recently used ones are dropped.
 */
/**
 * Measured on FalkorDB 4.22: the shared graphs and the MTA records take about 37 MB, each sandbox about 5 MB and each
 * what-if fork about 5 MB more while it lives. Four sandboxes leave room for two runs' forks at once inside 100 MB; eight
 * did not, and the free instance restarted empty under load.
 */
export const MAX_SANDBOXES = 4;
/** Long enough for a returning visitor's memory and conversation to still be there; the cap above still bounds space. */
const SANDBOX_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** A hold outlasts the longest request (300 s), then lapses on its own if the request died without releasing it. */
export const HOLD_MS = 330_000;
/** A sandbox used in the last few seconds may still be mid-request: the short routes take no hold. */
const RECENT_MS = 15_000;

type Entry = { id: string; seen: number; held: boolean };
/** Whether a request may be using a sandbox now: one holds it, or it was used a moment ago. */
const inUse = (e: Entry, now = Date.now()) => e.held || now - e.seen < RECENT_MS;
/** The visitor a fork belongs to: forks are named detour:fork:<visitor>:<label>. */
const forkOwner = (name: string) => name.slice(FORK_PREFIX.length).split(":")[0];

/** Holds a visitor's sandbox for one request; `release` ends the hold. Neither fails a request. */
export const holdFor = (visitorId: string) => holdSandbox(visitorId, HOLD_MS).catch(() => undefined);
export const release = (visitorId: string) => releaseSandbox(visitorId).catch(() => undefined);

/**
 * Runs `fn` while holding the visitor's sandbox, so making room for someone else never deletes it, or a fork it is
 * using, in the middle of a request.
 */
export async function whileHeld<T>(visitorId: string, fn: () => Promise<T>): Promise<T> {
  await holdFor(visitorId);
  try {
    return await fn();
  } finally {
    await release(visitorId);
  }
}

/** FalkorDB refuses writes once the instance is at its memory limit, and GRAPH.COPY cannot fork. */
export function isDatabaseFull(error: unknown): boolean {
  return /\bOOM\b|maxmemory|could not fork/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Makes room when the database is full: the what-if forks no request is using (they are throwaway copies), then any
 * sandbox graph the registry has lost, then the least recently used half of the idle sandboxes. The given visitor's
 * sandbox, and any a request is using, are kept. Deleting a graph is allowed at the memory limit, so this works
 * even when writes do not.
 */
async function freeSpace(keep: string): Promise<void> {
  const names = await listGraphs();
  const entries = await sandboxEntries().catch(() => []);
  const busy = new Set([keep, ...entries.filter((e) => inUse(e)).map((e) => e.id)]);
  for (const name of names) {
    if (name.startsWith(FORK_PREFIX) && !busy.has(forkOwner(name))) await deleteGraph(name).catch(() => undefined);
  }
  const known = new Set(entries.map((e) => e.id));
  for (const name of names) {
    const id = name.slice(SANDBOX_PREFIX.length);
    if (name.startsWith(SANDBOX_PREFIX) && id !== keep && !known.has(id)) await deleteGraph(name).catch(() => undefined);
  }
  const idle = entries.filter((e) => !busy.has(e.id)).sort((a, b) => a.seen - b.seen);
  for (const e of idle.slice(0, Math.ceil(idle.length / 2))) await dropVisitor(e.id).catch(() => undefined);
}

/**
 * Makes room for a what-if fork when the database is full: the least recently used half of the other visitors' idle
 * sandboxes goes, never one a request is using. Their owners get a fresh copy on their next visit.
 */
export async function makeRoom(keep: string): Promise<void> {
  const idle = (await sandboxEntries().catch(() => []))
    .filter((e) => e.id !== keep && !inUse(e))
    .sort((a, b) => a.seen - b.seen);
  for (const e of idle.slice(0, Math.max(1, Math.ceil(idle.length / 2)))) await dropVisitor(e.id).catch(() => undefined);
}

/** Copies a graph for a what-if; at the memory limit, makes room once and tries again. */
export async function copyForWhatIf(visitorId: string, source: string, destination: string): Promise<void> {
  try {
    await copyGraph(source, destination);
  } catch (error) {
    if (!isDatabaseFull(error)) throw error;
    await makeRoom(visitorId);
    await copyGraph(source, destination);
  }
}

let baseReady: Promise<void> | null = null;
let baseCheckedAt = 0;
/**
 * How often a warm server instance checks the shared graphs again. A free instance that restarts can come back
 * empty, and an instance that only remembered "seeded once" would never notice.
 */
const RECHECK_MS = 60_000;

/** Seeds the shared graphs, checking them again at most once a minute per server instance (self-healing after a wipe). */
export function ensureBase(): Promise<void> {
  if (!baseReady || Date.now() - baseCheckedAt > RECHECK_MS) {
    baseCheckedAt = Date.now();
    baseReady = ensureBaseGraphs().catch((err) => {
      baseReady = null;
      throw err;
    });
  }
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
    await evictIfFull(visitorId);
    const started = performance.now();
    try {
      await copyGraph(TEMPLATE_GRAPH, graph);
      created = true;
    } catch (error) {
      if (await graphExists(graph)) {
        // Another server instance made it first.
      } else if (isDatabaseFull(error)) {
        await freeSpace(visitorId);
        await copyGraph(TEMPLATE_GRAPH, graph);
        created = true;
      } else {
        throw error;
      }
    }
    copyMs = performance.now() - started;
  }
  try {
    await touchSandbox(visitorId);
  } catch (error) {
    // A returning visitor finds the database full: make room, then carry on.
    if (!isDatabaseFull(error)) throw error;
    await freeSpace(visitorId);
    await touchSandbox(visitorId);
  }
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

/**
 * Before a new sandbox is copied: expired sandboxes go, and past the cap the least recently used idle ones. A sandbox a
 * request is using stays even over the cap; if the database then fills, freeSpace makes room from the idle ones.
 */
async function evictIfFull(keep: string): Promise<void> {
  const now = Date.now();
  const entries = (await sandboxEntries(now)).filter((e) => e.id !== keep);
  const stale = entries.filter((e) => now - e.seen > SANDBOX_TTL_MS && !inUse(e, now));
  const live = entries.filter((e) => now - e.seen <= SANDBOX_TTL_MS).sort((a, b) => a.seen - b.seen);
  const overflow = Math.max(0, live.length - (MAX_SANDBOXES - 1));
  const idle = live.filter((e) => !inUse(e, now));
  for (const e of [...stale, ...idle.slice(0, overflow)]) await dropVisitor(e.id);
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
