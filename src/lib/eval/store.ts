import { run } from "../graph/db";
import { graphExists } from "../graph/meta";
import { EVAL_GRAPH } from "../graph/names";
import type { ArmRecord } from "./runner";

/**
 * The eval's bookkeeping in a graph of its own (FalkorDB Cloud's user may run graph commands only): one EvalRun node
 * for the run in progress or the last one finished, and one EvalResult node per question and arm, holding the record
 * as JSON. Starting a run clears the previous one, so the graph stays at a few hundred small nodes.
 */
export interface EvalRun {
  id: string;
  startedMs: number;
  finishedMs: number | null;
  /** Question ids in the order they run: held-out first, so a run cut short still has its headline. */
  order: string[];
  status: "running" | "done";
}

export async function currentRun(): Promise<EvalRun | null> {
  if (!(await graphExists(EVAL_GRAPH))) return null;
  const res = await run<{ id: string; startedMs: number; finishedMs: number | null; order: string; status: EvalRun["status"] }>(
    EVAL_GRAPH,
    "MATCH (r:EvalRun) RETURN r.id AS id, r.startedMs AS startedMs, r.finishedMs AS finishedMs, r.order AS order, r.status AS status ORDER BY startedMs DESC LIMIT 1",
    {},
    { readOnly: true },
  );
  const r = res.rows[0];
  return r ? { ...r, finishedMs: r.finishedMs ?? null, order: JSON.parse(r.order) as string[] } : null;
}

export async function startRun(r: EvalRun): Promise<void> {
  await run(EVAL_GRAPH, "MATCH (n) WHERE n:EvalRun OR n:EvalResult DELETE n");
  await run(EVAL_GRAPH, "CREATE (:EvalRun {id: $id, startedMs: $startedMs, order: $order, status: 'running'})", {
    id: r.id,
    startedMs: r.startedMs,
    order: JSON.stringify(r.order),
  });
}

/**
 * Reopens a run: drops the results whose error `retry` accepts (so those arms run again; every other result stays)
 * and sets the order the remaining questions follow. Returns how many arms will run again.
 */
export async function reopenRun(id: string, order: string[], retry: (error: string) => boolean): Promise<number> {
  const failed = await run<{ key: string; json: string }>(
    EVAL_GRAPH,
    "MATCH (x:EvalResult {run: $run}) WHERE x.json CONTAINS '\"error\":' RETURN x.key AS key, x.json AS json",
    { run: id },
    { readOnly: true },
  );
  const keys = failed.rows.filter((r) => retry((JSON.parse(r.json) as ArmRecord).error ?? "")).map((r) => r.key);
  if (keys.length) await run(EVAL_GRAPH, "UNWIND $keys AS k MATCH (x:EvalResult {key: k}) DELETE x", { keys });
  await run(EVAL_GRAPH, "MATCH (r:EvalRun {id: $id}) SET r.status = 'running', r.finishedMs = null, r.order = $order", { id, order: JSON.stringify(order) });
  return keys.length;
}

export async function finishRun(id: string, now = Date.now()): Promise<void> {
  await run(EVAL_GRAPH, "MATCH (r:EvalRun {id: $id}) SET r.status = 'done', r.finishedMs = $now", { id, now });
}

export async function saveResult(runId: string, record: ArmRecord): Promise<void> {
  await run(
    EVAL_GRAPH,
    "MERGE (x:EvalResult {key: $key}) SET x.run = $run, x.qid = $qid, x.arm = $arm, x.at = $at, x.json = $json",
    { key: `${runId}|${record.qid}|${record.arm}`, run: runId, qid: record.qid, arm: record.arm, at: record.at, json: JSON.stringify(record) },
  );
}

/** "qid|arm" for every result the run already has. */
export async function doneKeys(runId: string): Promise<Set<string>> {
  const res = await run<{ qid: string; arm: string }>(EVAL_GRAPH, "MATCH (x:EvalResult {run: $run}) RETURN x.qid AS qid, x.arm AS arm", { run: runId }, { readOnly: true });
  return new Set(res.rows.map((r) => `${r.qid}|${r.arm}`));
}

export async function getResult(runId: string, qid: string, arm: string): Promise<ArmRecord | null> {
  const res = await run<{ json: string }>(EVAL_GRAPH, "MATCH (x:EvalResult {key: $key}) RETURN x.json AS json", { key: `${runId}|${qid}|${arm}` }, { readOnly: true });
  return res.rows[0] ? (JSON.parse(res.rows[0].json) as ArmRecord) : null;
}

export async function countResults(runId: string): Promise<number> {
  const res = await run<{ n: number }>(EVAL_GRAPH, "MATCH (x:EvalResult {run: $run}) RETURN count(x) AS n", { run: runId }, { readOnly: true });
  return res.rows[0]?.n ?? 0;
}

/** One page of results in the order they were written. */
export async function resultPage(runId: string, offset: number, limit: number): Promise<ArmRecord[]> {
  const skip = Math.max(0, Math.floor(offset));
  const take = Math.min(200, Math.max(1, Math.floor(limit)));
  const res = await run<{ json: string; at: number }>(
    EVAL_GRAPH,
    `MATCH (x:EvalResult {run: $run}) RETURN x.json AS json, x.at AS at ORDER BY at, json SKIP ${skip} LIMIT ${take}`,
    { run: runId },
    { readOnly: true },
  );
  return res.rows.map((r) => JSON.parse(r.json) as ArmRecord);
}
