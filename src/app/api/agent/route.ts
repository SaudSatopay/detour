import type { ModelMessage } from "ai";
import { z } from "zod";
import { buildTools, type AgentEvent } from "@/lib/agent/catalog";
import { hasLiveModel } from "@/lib/agent/models";
import { ASK_INSTRUCTIONS, CONTROLLER_INSTRUCTIONS } from "@/lib/agent/prompts";
import { recorder, replayRun } from "@/lib/agent/replay";
import { runAgent } from "@/lib/agent/run";
import { ensureSandbox } from "@/lib/graph/tenancy";
import { allow, ndjson, visitorId } from "@/lib/server/http";

export const maxDuration = 300;

const Body = z.object({
  mode: z.enum(["control", "ask"]),
  message: z.string().trim().min(2).max(600),
  scenarioId: z.string().max(40).optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(12)
    .optional(),
  replay: z.boolean().optional(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Send { mode: 'control' | 'ask', message } with a message of 2 to 600 characters." }, { status: 400 });
  }
  const body = parsed.data;
  const visitor = await visitorId();
  const agent = body.mode === "control" ? "controller" : "rider-desk";

  return ndjson<AgentEvent>(
    async (send) => {
      let emit = send;
      const runId = `run-${Date.now().toString(36)}`;
      const live = !body.replay && hasLiveModel() && (await allow(visitor, body.mode, body.mode === "control" ? 8 : 30));
      if (!live) {
        emit({ type: "run", runId, agent, mode: "replay" });
        await replayRun(body.scenarioId, body.mode, emit, request.signal);
        return;
      }
      const rec = recorder(body.scenarioId, body.mode, emit);
      emit = rec.emit;
      emit({ type: "run", runId, agent, mode: "live" });
      const sandbox = await ensureSandbox(visitor);
      const tools = buildTools({ visitorId: visitor, sandbox: sandbox.graph, agentId: agent }, emit, agent);
      const messages: ModelMessage[] = [
        ...(body.history ?? []).map((m) => ({ role: m.role, content: m.content }) as ModelMessage),
        { role: "user", content: body.message },
      ];
      const out = await runAgent({
        agent,
        instructions: body.mode === "control" ? CONTROLLER_INSTRUCTIONS : ASK_INSTRUCTIONS,
        messages,
        tools,
        emit,
        maxSteps: body.mode === "control" ? 12 : 6,
        abortSignal: request.signal,
      });
      emit({ type: "done", agent, text: out.text, steps: out.steps, model: out.model });
      await rec.save();
    },
    (message) => ({ type: "error", agent, message }),
  );
}
