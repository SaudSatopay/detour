import { z } from "zod";
import type { AgentEvent } from "@/lib/agent/catalog";
import { publishAndAdvise } from "@/lib/agent/publish";
import { replayRun } from "@/lib/agent/replay";
import { ensureSandbox } from "@/lib/graph/tenancy";
import { ndjson, visitorId } from "@/lib/server/http";

export const maxDuration = 120;

const Body = z.object({
  planId: z.string().regex(/^PLAN-[A-Z0-9]+$/),
  /** Set when the plan came from a recorded run: plays the recorded approval instead of writing to the graph. */
  recorded: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});

/** Human approval: publishes the plan into the graph, hands off to the rider desk, runs one agent per affected rider. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { planId: 'PLAN-…' }." }, { status: 400 });
  const body = parsed.data;

  return ndjson<AgentEvent>(
    async (emit) => {
      if (body.recorded) {
        emit({ type: "run", runId: `run-${Date.now().toString(36)}`, agent: "rider-desk", mode: "replay" });
        await replayRun(body.recorded, "publish", emit, request.signal);
        return;
      }
      const visitor = await visitorId();
      const sandbox = await ensureSandbox(visitor);
      await publishAndAdvise({ visitorId: visitor, sandbox: sandbox.graph }, body.planId, emit);
    },
    (message) => ({ type: "error", agent: "rider-desk", message }),
  );
}
