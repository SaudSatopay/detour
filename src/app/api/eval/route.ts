import { z } from "zod";
import { liveChain, soonestModelMs } from "@/lib/agent/models";
import { unavailable } from "@/lib/eval/availability";
import { evalToolset, EVAL_VISITOR, runBatch, runOrder } from "@/lib/eval/runner";
import type { EvalQuestion } from "@/lib/eval/questions";
import { countResults, currentRun, doneKeys, finishRun, getResult, reopenRun, resultPage, saveResult, startRun } from "@/lib/eval/store";
import { releaseLock, takeLock } from "@/lib/graph/meta";
import { dropSandbox, ensureBase, ensureSandbox, whileHeld } from "@/lib/graph/tenancy";
import { allow, allowToday, friendlyError } from "@/lib/server/http";
import questionsJson from "../../../../data/eval/questions.json";

export const maxDuration = 300;

/**
 * The agent eval, run on the deployment itself because the model keys live only there. Off unless EVAL_ENABLED=1.
 *
 *   POST { "start": true }  begins a run (one a UTC day), then runs questions until about 270 s have passed
 *   POST {}                 runs the next batch of the run in progress
 *   POST { "retry": true }  reopens the last run: its arms that met spent free quotas run again, in the next batches
 *   POST { "start": true, "skip": [ids] }  begins a run without questions an earlier run already answered on
 *                           every arm (its records are merged when the results are fetched)
 *   GET  ?offset=&limit=    progress and a page of per-question results
 *
 * Every batch works on one sandbox graph of its own (EVAL_VISITOR), runs no brain, publishes nothing and touches no
 * visitor's sandbox; the sandbox is dropped when the run finishes. The model arms run on the live chain less its first
 * models, which stay with visitors; when nothing else is left, a batch pauses and the run keeps its place.
 */
const QUESTIONS = questionsJson as unknown as EvalQuestion[];
const ARMS_PER_QUESTION = 3;
const BATCH_MS = 270_000;
const ARM_TIMEOUT_MS = 100_000;
/**
 * The first models of the live chain stay with visitors: the eval runs on the ones after them, and pauses when only
 * these are left, so it never spends the free quota a judge's live run needs.
 */
const LEFT_FOR_VISITORS = 2;
const evalChain = async () => (await liveChain()).slice(LEFT_FOR_VISITORS);

const Body = z.object({ start: z.boolean().optional(), retry: z.boolean().optional(), skip: z.array(z.string().max(80)).max(200).optional() }).strict();
const enabled = () => process.env.EVAL_ENABLED === "1";
const clientOf = (request: Request) => (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon").replace(/[^a-z0-9.:]/gi, "");

export async function POST(request: Request) {
  if (!enabled()) return Response.json({ error: "The eval runner is off. The owner turns it on with EVAL_ENABLED=1." }, { status: 403 });
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: 'Send {} to run the next batch, { "start": true } to begin a run, or { "retry": true } to reopen the last one.' }, { status: 400 });

  const started = Date.now();
  const owner = crypto.randomUUID();
  try {
    await ensureBase();
    if (!(await allow(clientOf(request), "eval", 30))) return Response.json({ error: "Rate limited: 30 eval batches an hour per client." }, { status: 429 });
    if (!(await takeLock("eval-batch", owner, (maxDuration + 30) * 1000))) {
      return Response.json({ error: "A batch is already running. Try again when it ends (up to five minutes)." }, { status: 409 });
    }
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }

  try {
    // Before a run starts or the day's run is spent: with no model, the graph and baseline arms could not run.
    if (!(await evalChain()).length) {
      return Response.json(
        { error: `No model is free for the eval right now: it leaves the first ${LEFT_FOR_VISITORS} live models to visitors, and the rest are spent or cooling off. Try again later; nothing ran.` },
        { status: 503 },
      );
    }
    let current = await currentRun();
    // A run whose model arms met spent free quotas is reopened: those arms run again, every other result stays.
    if (current && parsed.data.retry) {
      // The run keeps its own questions (a run started with skip has fewer), taken in the current run order.
      const rank = new Map(runOrder(QUESTIONS).map((id, i) => [id, i]));
      const order = [...current.order].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
      const cleared = await reopenRun(current.id, order, unavailable);
      current = { ...current, status: "running", finishedMs: null, order };
      console.warn(`[eval] reopened ${current.id}: ${cleared} arms to run again`);
    }
    if (!current || current.status === "done") {
      if (!parsed.data.start) {
        return Response.json({ error: 'No run is in progress. Send { "start": true } to begin one.', run: current }, { status: 409 });
      }
      if (!(await allowToday("eval-run", 1))) {
        return Response.json({ error: "One full evaluation a UTC day: today's has started already." }, { status: 429 });
      }
      const skip = new Set(parsed.data.skip ?? []);
      const order = runOrder(QUESTIONS).filter((id) => !skip.has(id));
      current = { id: `eval-${new Date(started).toISOString().slice(0, 10)}-${owner.slice(0, 6)}`, startedMs: started, finishedMs: null, order, status: "running" };
      await startRun(current);
    }

    const origin = new URL(request.url).origin;
    const runId = current.id;
    const order = current.order;
    // The eval's sandbox is held for the batch, so a visitor making room never deletes it between two tool calls.
    const { ran, remaining, paused } = await whileHeld(EVAL_VISITOR, async () => {
      const sandbox = await ensureSandbox(EVAL_VISITOR);
      const base = { visitorId: EVAL_VISITOR, sandbox: sandbox.graph, agentId: "controller" };
      return runBatch({
        questions: QUESTIONS,
        order,
        deps: { base, toolset: (emit) => evalToolset(base, emit, origin), chain: evalChain, soonest: () => soonestModelMs(), armTimeoutMs: ARM_TIMEOUT_MS },
        done: await doneKeys(runId),
        save: (r) => saveResult(runId, r),
        graphModel: async (qid) => (await getResult(runId, qid, "graph"))?.model ?? null,
        until: started + BATCH_MS,
      });
    });
    if (remaining === 0) {
      await finishRun(runId);
      await dropSandbox(EVAL_VISITOR).catch(() => undefined);
    }
    return Response.json({
      run: runId,
      ran: ran.map((r) => ({ qid: r.qid, arm: r.arm, model: r.model, correct: r.correct, ms: r.ms, error: r.error })),
      remaining,
      paused,
      note: paused ? "No free model can answer right now; the run keeps its place. Send {} again once the quotas recover." : undefined,
      done: remaining === 0,
      seconds: Math.round((Date.now() - started) / 1000),
    });
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  } finally {
    await releaseLock("eval-batch", owner).catch(() => undefined);
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
  const limit = Number(url.searchParams.get("limit") ?? 100) || 100;
  try {
    const current = await currentRun();
    if (!current) return Response.json({ enabled: enabled(), run: null, questions: QUESTIONS.length, results: [], next: null });
    const [stored, page] = await Promise.all([countResults(current.id), resultPage(current.id, offset, limit)]);
    const total = current.order.length * ARMS_PER_QUESTION;
    return Response.json({
      enabled: enabled(),
      run: { id: current.id, startedMs: current.startedMs, finishedMs: current.finishedMs, status: current.status, questions: current.order.length },
      progress: { stored, total },
      results: page,
      next: offset + page.length < stored ? offset + page.length : null,
    });
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}
