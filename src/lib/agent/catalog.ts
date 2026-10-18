import { tool, type ToolSet } from "ai";
import { Tracer } from "../graph/trace";
import type { ToolContext, ToolResult } from "../graph/tools/types";
import { run } from "../graph/db";
import { toolsFor, type AgentRole } from "./toolbox";

export type AgentEvent =
  | { type: "run"; runId: string; agent: string; mode: "live" | "scripted" | "replay"; note?: string }
  | { type: "model"; agent: string; model: string; reason?: string }
  | { type: "text"; agent: string; delta: string }
  | { type: "tools"; agent: string; via: "mcp" | "in-process"; names: string[]; server: string | null }
  | { type: "tool-call"; agent: string; id: string; tool: string; input: unknown; via?: "mcp" | "in-process" }
  | { type: "tool-result"; agent: string; id: string; result: ToolResult }
  | { type: "tool-error"; agent: string; id: string; tool: string; message: string }
  | { type: "handoff"; from: string; to: string; note: string }
  | { type: "grounding"; agent: string; checked: number; unmatched: string[] }
  | { type: "done"; agent: string; text: string; steps: number; model: string | null }
  | { type: "error"; agent: string; message: string };

export type Emit = (event: AgentEvent) => void;


/** What the model sees from a tool: the answer shape, a summary, and only the data it needs to decide. */
export function forModel(r: ToolResult): unknown {
  const data = r.data as Record<string, unknown> | null;
  switch (r.tool) {
    case "measure_capacity": {
      const d = r.data as {
        reroute?: { overloaded: unknown[]; stranded: number };
        directions?: { direction: string; required: number; absorbed: number; unmet: number; cut: unknown[]; strandedAt: unknown[]; cutOff?: unknown[]; check?: { solver: string; checked: boolean } }[];
      } | null;
      return {
        outcome: r.outcome,
        summary: r.summary,
        overloaded: d?.reroute?.overloaded.slice(0, 6),
        stranded: d?.reroute?.stranded,
        directions: d?.directions?.map((x) => ({
          direction: x.direction,
          required: x.required,
          absorbed: x.absorbed,
          unmet: x.unmet,
          cut: x.cut.slice(0, 6),
          cutOff: x.cutOff?.slice(0, 6),
          strandedAt: x.strandedAt.slice(0, 6),
          certified: x.check ? { solver: x.check.solver, checked: x.check.checked } : undefined,
        })),
      };
    }
    case "simulate_plan": {
      const d = r.data as { planId: string; vehicles: number; before: unknown; after: unknown; reroute: { overloaded: unknown[] } } | null;
      return { outcome: r.outcome, summary: r.summary, planId: d?.planId, vehicles: d?.vehicles, before: d?.before, after: d?.after, stillOverloaded: d?.reroute.overloaded.slice(0, 4) };
    }
    case "affected_riders": {
      const d = r.data as { byDepth: unknown; topOrigins: unknown; topDestinations: unknown; totalRiders: number } | null;
      return { outcome: r.outcome, summary: r.summary, totalRiders: d?.totalRiders, byDepth: d?.byDepth, topOrigins: d?.topOrigins, topDestinations: d?.topDestinations };
    }
    case "close_line": {
      const d = r.data as { incident: { id: string; stretch: string[] } | null; peakLoad: number } | null;
      return { outcome: r.outcome, summary: r.summary, incidentId: d?.incident?.id, stretch: d?.incident?.stretch, peakLoad: d?.peakLoad };
    }
    case "riders_affected": {
      const d = r.data as { affected: { id: string; name: string; stepFree: boolean; preferences: unknown }[]; unaffected: string[] } | null;
      return { outcome: r.outcome, summary: r.summary, affected: d?.affected.map((a) => ({ id: a.id, name: a.name, stepFree: a.stepFree, preferences: a.preferences })), unaffected: d?.unaffected };
    }
    default:
      return { outcome: r.outcome, summary: r.summary, data };
  }
}

/**
 * What the browser needs from a tool result. Per-edge flow lists in the data (hundreds of kilobytes for
 * a capacity run) stay on the server; the map draws the highlight's top flows, which are kept.
 */
export function forClient(r: ToolResult): ToolResult {
  if (r.tool !== "measure_capacity" && r.tool !== "simulate_plan") return r;
  return { ...r, data: JSON.parse(JSON.stringify(r.data, (key, value) => (key === "flows" ? undefined : value))) };
}

/** Shortens text at a word boundary, with an ellipsis, so stored summaries never end mid-word. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).replace(/[\s,;:|]+$/, "")}…`;
}

/** The agents whose tool calls belong to the open incident's history; the brain's and outside agents' do not. */
const INCIDENT_AGENTS = new Set(["controller", "rider-desk"]);

/**
 * Persists each tool call as an Episode in the visitor's graph: the incident's history is graph state, including why
 * the agent made the call, which model chose it and with what input.
 */
export async function recordEpisode(ctx: ToolContext, r: ToolResult, extra: { why?: string; model?: string | null; input?: unknown } = {}) {
  try {
    await run(
      ctx.sandbox,
      `MATCH (ag:Agent {id: $agent})
       OPTIONAL MATCH (i:Incident {status: 'open'})
       WITH ag, CASE WHEN $incidental THEN i ELSE null END AS i
       CREATE (ag)-[:ACTED]->(e:Episode {tool: $tool, outcome: $outcome, summary: $summary, atMs: timestamp(),
         queries: $queries, ms: $ms, why: $why, model: $model, input: $input})
       FOREACH (_ IN CASE WHEN i IS NULL THEN [] ELSE [1] END | CREATE (e)-[:IN]->(i))`,
      {
        agent: ctx.agentId,
        incidental: INCIDENT_AGENTS.has(ctx.agentId),
        tool: r.tool,
        outcome: r.outcome,
        summary: clip(r.summary, 600),
        queries: r.trace.length,
        ms: Math.round(r.trace.reduce((s, t) => s + t.ms, 0)),
        why: clip(extra.why?.trim() ?? "", 300),
        model: extra.model ?? "",
        input: extra.input === undefined ? "" : clip(JSON.stringify(extra.input), 400),
      },
    );
  } catch {
    // History is best effort; the answer already reached the user.
  }
}

export function buildTools(base: Omit<ToolContext, "tracer">, emit: Emit, agent: string, why: () => string = () => ""): ToolSet {
  let seq = 0;
  const role: AgentRole = agent === "rider-desk" ? "rider-desk" : "controller";
  const tools: ToolSet = {};
  for (const def of toolsFor(role)) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: def.input,
      execute: async (input: Record<string, unknown>) => {
        const id = `${def.name}-${++seq}`;
        const reason = why();
        emit({ type: "tool-call", agent, id, tool: def.name, input, via: "in-process" });
        const ctx: ToolContext = { ...base, tracer: new Tracer() };
        try {
          const r = await def.run(ctx, input);
          emit({ type: "tool-result", agent, id, result: forClient(r) });
          void recordEpisode(ctx, r, { why: reason, input });
          return forModel(r);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emit({ type: "tool-error", agent, id, tool: def.name, message });
          return { outcome: "error", summary: `The tool failed: ${message}. Try a different step or report the gap.` };
        }
      },
    });
  }
  return tools;
}
