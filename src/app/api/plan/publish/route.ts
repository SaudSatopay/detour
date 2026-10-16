import { z } from "zod";
import type { AgentEvent } from "@/lib/agent/catalog";
import { runRiderDesk } from "@/lib/agent/riders";
import { Tracer } from "@/lib/graph/trace";
import { ensureSandbox } from "@/lib/graph/tenancy";
import { publishPlan } from "@/lib/graph/tools/plan";
import { ndjson, visitorId } from "@/lib/server/http";

export const maxDuration = 120;

const Body = z.object({ planId: z.string().regex(/^PLAN-[A-Z0-9]+$/) });

/** Human approval: publishes the plan into the graph, hands off to the rider desk, runs one agent per affected rider. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { planId: 'PLAN-…' }." }, { status: 400 });
  const visitor = await visitorId();

  return ndjson<AgentEvent>(
    async (emit) => {
      const sandbox = await ensureSandbox(visitor);
      const base = { visitorId: visitor, sandbox: sandbox.graph };
      const published = await publishPlan({ ...base, agentId: "controller", tracer: new Tracer() }, { planId: parsed.data.planId, approvedBy: "dispatcher" });
      emit({ type: "tool-result", agent: "controller", id: "publish", result: published });
      if (published.outcome !== "answered") {
        emit({ type: "error", agent: "controller", message: published.summary });
        return;
      }
      emit({ type: "handoff", from: "controller", to: "rider-desk", note: "Plan published. Tell every remembered rider whose trip crosses the closure what to take instead." });
      const advisories = await runRiderDesk(base, emit);
      emit({ type: "done", agent: "rider-desk", text: `${advisories.length} advisories written.`, steps: advisories.length, model: null });
    },
    (message) => ({ type: "error", agent: "rider-desk", message }),
  );
}
