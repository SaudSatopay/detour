import { listGraphs, run } from "./db";
import { META_GRAPH } from "./names";

/*
 * Bookkeeping kept in a graph of its own instead of plain Redis keys: FalkorDB Cloud's user may run graph
 * commands only (SET, HSET, EXISTS or INCR answer NOPERM). FalkorDB runs one write at a time per graph, so each
 * MERGE below is atomic.
 */

/** Whether a graph exists (GRAPH.LIST, since EXISTS is a plain Redis command). */
export async function graphExists(name: string): Promise<boolean> {
  return (await listGraphs()).includes(name);
}

/** Records that a visitor's sandbox was used now. */
export async function touchSandbox(visitor: string, now = Date.now()): Promise<void> {
  await run(META_GRAPH, "MERGE (s:Sandbox {visitor: $visitor}) SET s.seen = $now", { visitor, now });
}

/**
 * Marks a visitor's sandbox in use by one more request, for `ms` at most (a request that dies without releasing it
 * stops counting then). Making room for another visitor never deletes a held sandbox, or its forks.
 */
export async function holdSandbox(visitor: string, ms: number, now = Date.now()): Promise<void> {
  await run(
    META_GRAPH,
    `MERGE (s:Sandbox {visitor: $visitor})
     SET s.seen = $now,
         s.holds = CASE WHEN coalesce(s.heldUntil, 0) > $now THEN coalesce(s.holds, 0) + 1 ELSE 1 END,
         s.heldUntil = $now + $ms`,
    { visitor, now, ms },
  );
}

/** Ends one request's hold on a visitor's sandbox. */
export async function releaseSandbox(visitor: string, now = Date.now()): Promise<void> {
  await run(
    META_GRAPH,
    "MATCH (s:Sandbox {visitor: $visitor}) SET s.seen = $now, s.holds = CASE WHEN coalesce(s.holds, 0) > 1 THEN s.holds - 1 ELSE 0 END",
    { visitor, now },
  );
}

/** Every sandbox the registry knows, with when it was last used and whether a request holds it now. */
export async function sandboxEntries(now = Date.now()): Promise<{ id: string; seen: number; held: boolean }[]> {
  if (!(await graphExists(META_GRAPH))) return [];
  const res = await run<{ id: string; seen: number; held: boolean }>(
    META_GRAPH,
    "MATCH (s:Sandbox) RETURN s.visitor AS id, s.seen AS seen, coalesce(s.holds, 0) > 0 AND coalesce(s.heldUntil, 0) > $now AS held",
    { now },
    { readOnly: true },
  );
  return res.rows;
}

export async function forgetSandbox(visitor: string): Promise<void> {
  await run(META_GRAPH, "MATCH (s:Sandbox {visitor: $visitor}) DELETE s", { visitor });
}

/** Takes a named lock for `ms`: true when this caller now holds it (newly taken, or taken over once it expired). */
export async function takeLock(name: string, owner: string, ms: number, now = Date.now()): Promise<boolean> {
  const res = await run<{ owner: string }>(
    META_GRAPH,
    `MERGE (l:Lock {name: $name})
     ON CREATE SET l.owner = $owner, l.until = $until
     WITH l
     WHERE l.owner = $owner OR l.until < $now
     SET l.owner = $owner, l.until = $until
     RETURN l.owner AS owner`,
    { name, owner, until: now + ms, now },
  );
  return res.rows[0]?.owner === owner;
}

export async function releaseLock(name: string, owner: string): Promise<void> {
  await run(META_GRAPH, "MATCH (l:Lock {name: $name, owner: $owner}) DELETE l", { name, owner });
}

/** Adds one to a counter and returns its new value. The counter is kept for `ttlMs`, then the cron drops it. */
export async function bump(key: string, ttlMs: number, now = Date.now()): Promise<number> {
  const res = await run<{ n: number }>(
    META_GRAPH,
    `MERGE (c:Counter {key: $key})
     ON CREATE SET c.n = 0, c.until = $until
     SET c.n = c.n + 1
     RETURN c.n AS n`,
    { key, until: now + ttlMs },
  );
  return res.rows[0]?.n ?? 1;
}

/** Takes a model out of every run until `until`: its daily quota is spent, or the provider does not serve it. */
export async function blockModel(model: string, until: number, reason: string): Promise<void> {
  await run(META_GRAPH, "MERGE (b:Block {key: $key}) SET b.until = $until, b.reason = $reason", { key: `model:${model}`, until, reason });
}

/** The models taken out of the chain right now, with when each comes back. */
export async function blockedModels(now = Date.now()): Promise<Map<string, number>> {
  if (!(await graphExists(META_GRAPH))) return new Map();
  const res = await run<{ key: string; until: number }>(
    META_GRAPH,
    "MATCH (b:Block) WHERE b.until > $now AND b.key STARTS WITH 'model:' RETURN b.key AS key, b.until AS until",
    { now },
    { readOnly: true },
  );
  return new Map(res.rows.map((r) => [r.key.slice("model:".length), r.until]));
}

/** Drops counters, locks and blocks past their time (the daily cron). */
export async function dropExpired(now = Date.now()): Promise<number> {
  if (!(await graphExists(META_GRAPH))) return 0;
  let dropped = 0;
  for (const label of ["Counter", "Lock", "Block"]) {
    const res = await run(META_GRAPH, `MATCH (n:${label}) WHERE n.until < $now DELETE n`, { now });
    dropped += res.stats["Nodes deleted"] ?? 0;
  }
  return dropped;
}
