import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import { buildTools, recordEpisode, type AgentEvent, type Emit } from "@/lib/agent/catalog";
import { ground } from "@/lib/agent/grounding";
import { mcpToolset } from "@/lib/agent/mcp-tools";
import { hasLiveModel, isRetryable, liveModelAvailable } from "@/lib/agent/models";
import { ASK_INSTRUCTIONS, CONTROLLER_INSTRUCTIONS } from "@/lib/agent/prompts";
import { recorder, replayRun } from "@/lib/agent/replay";
import { NoModelError, runAgent } from "@/lib/agent/run";
import { scriptedControl } from "@/lib/agent/scripted";
import { scriptedAsk } from "@/lib/agent/scripted-ask";
import { recentTurns, rememberTurns } from "@/lib/graph/conversation";
import { ensureSandbox } from "@/lib/graph/tenancy";
import { Tracer } from "@/lib/graph/trace";
import type { ToolResult } from "@/lib/graph/tools/types";
import { loadScenarios } from "@/lib/network/data";
import { allow, allowToday, ndjson, visitorId } from "@/lib/server/http";

export const maxDuration = 300;

/** Live runs a day across all visitors: what the chain of free Gemini and Groq models carries, with room for the demo. */
const LIVE_PER_DAY = { control: 40, ask: 150 } as const;

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

/**
 * Runs an agent on the visitor's sandbox graph and streams its events as NDJSON. Three modes, named
 * in the stream's first event:
 *   live      a free model chooses the tools (Gemini, then Groq)
 *   scripted  no model quota left: the controller's standard procedure, same tools, templated words
 *   replay    the graph database is unreachable: a recorded run of a preset scenario
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Send { mode: 'control' | 'ask', message } with a message of 2 to 600 characters." }, { status: 400 });
  }
  const body = parsed.data;
  const visitor = await visitorId();
  const agent = body.mode === "control" ? "controller" : "rider-desk";
  const scenario = body.scenarioId ? (await loadScenarios()).find((s) => s.id === body.scenarioId) : undefined;

  return ndjson<AgentEvent>(
    async (send) => {
      let emit = send;
      const runId = `run-${Date.now().toString(36)}`;
      const replay = async (note: string) => {
        emit({ type: "run", runId, agent, mode: "replay", note });
        await replayRun(body.scenarioId, body.mode, emit, request.signal);
      };
      if (body.replay) return replay("A recorded run of this scenario.");

      const sandbox = await ensureSandbox(visitor).catch(() => null);
      if (!sandbox) {
        // A question has no recording to fall back on: say so, with the real cause.
        if (body.mode === "ask") {
          emit({
            type: "error",
            agent,
            message: "The graph database is unreachable right now, so the rider desk cannot answer questions. The control room's preset closures still play their recorded runs.",
          });
          return;
        }
        return replay("The graph database is unreachable, so this is a recorded run of the same scenario.");
      }
      const base = { visitorId: visitor, sandbox: sandbox.graph, agentId: agent };

      const quota =
        (await liveModelAvailable()) &&
        (await allow(visitor, body.mode, body.mode === "control" ? 8 : 30).catch(() => false)) &&
        (await allowToday(body.mode, LIVE_PER_DAY[body.mode]).catch(() => false));
      /** The controller's standard procedure: the same tools on the visitor's graph, without a model. */
      const scripted = async (note: string, prior: ToolResult[] = []) => {
        emit({ type: "run", runId, agent, mode: "scripted", note });
        const out = await scriptedControl(base, scenario!, emit, prior);
        emit({ type: "done", agent, text: out.brief, steps: out.steps, model: null });
      };
      /** The rider desk's rules without a model: the same tools, and the conversation the graph remembers. */
      const scriptedRider = async (note: string) => {
        emit({ type: "run", runId, agent, mode: "scripted", note });
        const stored = await recentTurns(sandbox.graph, agent, 8).catch(() => []);
        const out = await scriptedAsk(base, body.message, emit, stored.length ? stored : (body.history ?? []));
        emit({ type: "done", agent, text: out.text, steps: out.steps, model: null });
        await rememberTurns(sandbox.graph, agent, [
          { role: "user", text: body.message },
          { role: "assistant", text: out.text, mode: "scripted" },
        ]).catch(() => undefined);
      };
      if (!quota) {
        if (body.mode === "ask") {
          return scriptedRider("The free model runs are used up for now, so the rider desk answered with its rules: the same graph tools, with templated wording.");
        }
        if (body.mode === "control" && scenario) {
          return scripted(
            hasLiveModel()
              ? "The free model runs are used up for now, so the controller follows its standard procedure without a model: the same tools on your own graph, with templated wording."
              : "No model is configured, so the controller follows its standard procedure without one: the same tools on your own graph, with templated wording.",
          );
        }
        emit({
          type: "error",
          agent,
          message:
            "Free-text questions need a live model, and the free quota is used up for now. Pick a preset scenario or a rider instead; those run on the graph without a model.",
        });
        return;
      }

      const rec = recorder(body.scenarioId, body.mode, emit);
      emit = rec.emit;
      emit({ type: "run", runId, agent, mode: "live" });

      // What the model said last is why it chose its next tool; the results feed the grounding check on its brief.
      let model: string | null = null;
      let narration = "";
      const results: ToolResult[] = [];
      const tap: Emit = (e) => {
        if (e.type === "model" && e.agent === agent) model = e.model;
        if (e.type === "text" && e.agent === agent) narration += e.delta;
        if (e.type === "tool-result" && e.agent === agent) results.push(e.result);
        emit(e);
      };
      const why = () => lastSentence(narration);

      // The agent finds its tools on Detour's own MCP server, as an outside agent would; in-process only if it is unreachable.
      let tools: ToolSet;
      let closeTools = async () => undefined as void;
      try {
        const mcp = await mcpToolset({
          origin: new URL(request.url).origin,
          visitorId: visitor,
          role: agent,
          emit: tap,
          why,
          onResult: (r, input, reason) => void recordEpisode({ ...base, tracer: new Tracer() }, r, { why: reason, input, model }),
        });
        tools = mcp.tools;
        closeTools = mcp.close;
        tap({ type: "tools", agent, via: "mcp", names: mcp.names, server: mcp.server });
      } catch {
        tools = buildTools(base, tap, agent, why);
        tap({ type: "tools", agent, via: "in-process", names: Object.keys(tools), server: null });
      }
      // The rider desk's conversation lives in the visitor's graph, so it carries over between visits; the
      // browser's copy is only a fallback for a graph that has none yet.
      const stored = body.mode === "ask" ? await recentTurns(sandbox.graph, agent, 8) : [];
      const history = stored.length ? stored : (body.history ?? []);
      const messages: ModelMessage[] = [
        ...history.map((m) => ({ role: m.role, content: m.content }) as ModelMessage),
        { role: "user", content: body.message },
      ];
      let out: Awaited<ReturnType<typeof runAgent>>;
      try {
        out = await runAgent({
          agent,
          instructions: body.mode === "control" ? CONTROLLER_INSTRUCTIONS : ASK_INSTRUCTIONS,
          messages,
          tools,
          emit: tap,
          maxSteps: body.mode === "control" ? 12 : 6,
          abortSignal: request.signal,
        });
      } catch (error) {
        await closeTools().catch(() => undefined);
        if (body.mode === "ask" && (isRetryable(error) || error instanceof NoModelError)) {
          return scriptedRider("The free models' quotas ran out mid-answer, so the rider desk answered with its rules: the same graph tools, with templated wording.");
        }
        // Free model quotas run out (a daily cap, or every provider rate limited): a preset closure finishes on the
        // controller's standard procedure, from the start, rather than stopping halfway.
        if (body.mode === "control" && scenario && (isRetryable(error) || error instanceof NoModelError)) {
          // An open handover: the procedure carries on from the live run's last answer instead of starting over.
          if (results.length) {
            emit({ type: "model", agent, model: "standard procedure", reason: `every free model's quota ran out after ${results.length} steps; the standard procedure continues from here with the same tools` });
          }
          return scripted(
            results.length
              ? "The free models' quotas ran out partway, so the controller's standard procedure took over from the last step: the same tools on your own graph, with templated wording."
              : "The free model's quota ran out, so the controller finished with its standard procedure: the same tools on your own graph, with templated wording.",
            results,
          );
        }
        throw error;
      }
      await closeTools().catch(() => undefined);
      if (body.mode === "control" && out.text.trim()) {
        const g = ground(out.text, results);
        emit({ type: "grounding", agent, checked: g.checked, unmatched: g.unmatched });
      }
      emit({ type: "done", agent, text: out.text, steps: out.steps, model: out.model });
      if (body.mode === "ask" && out.text.trim()) {
        await rememberTurns(sandbox.graph, agent, [
          { role: "user", text: body.message },
          { role: "assistant", text: out.text, mode: "live" },
        ]);
      }
      await rec.save();
    },
    (message) => ({ type: "error", agent, message }),
  );
}

/** The model's latest sentence: what it said it was checking, and why, before its next tool call. */
function lastSentence(text: string): string {
  const lines = text.trim().split(/\n+/).filter((l) => l.trim());
  const last = lines[lines.length - 1] ?? "";
  return last.length > 300 ? `${last.slice(0, 299)}…` : last;
}
