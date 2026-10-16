import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Tracer } from "../graph/trace";
import { affectedRiders } from "../graph/tools/impact";
import { closeLine } from "../graph/tools/incident";
import { measureCapacity, shuttleCandidates, simulatePlan } from "../graph/tools/capacity";
import { recall, remember } from "../graph/tools/memory";
import { proposeSteering } from "../graph/tools/plan";
import { resolvePlaces } from "../graph/tools/places";
import { ridersAffected, routeRider } from "../graph/tools/riders";
import type { ToolContext, ToolResult } from "../graph/tools/types";
import { run } from "../graph/db";

export type AgentEvent =
  | { type: "run"; runId: string; agent: string; mode: "live" | "scripted" | "replay"; note?: string }
  | { type: "model"; agent: string; model: string; reason?: string }
  | { type: "text"; agent: string; delta: string }
  | { type: "tool-call"; agent: string; id: string; tool: string; input: unknown }
  | { type: "tool-result"; agent: string; id: string; result: ToolResult }
  | { type: "tool-error"; agent: string; id: string; tool: string; message: string }
  | { type: "handoff"; from: string; to: string; note: string }
  | { type: "done"; agent: string; text: string; steps: number; model: string | null }
  | { type: "error"; agent: string; message: string };

export type Emit = (event: AgentEvent) => void;

const ids = z.array(z.string().regex(/^\d{1,4}$/, "a station id such as \"120\"")).max(12);

/** What the model sees from a tool: the answer shape, a summary, and only the data it needs to decide. */
function forModel(r: ToolResult): unknown {
  const data = r.data as Record<string, unknown> | null;
  switch (r.tool) {
    case "measure_capacity": {
      const d = r.data as { reroute?: { overloaded: unknown[]; stranded: number }; directions?: { direction: string; required: number; absorbed: number; unmet: number; cut: unknown[]; strandedAt: unknown[] }[] } | null;
      return {
        outcome: r.outcome,
        summary: r.summary,
        overloaded: d?.reroute?.overloaded.slice(0, 6),
        stranded: d?.reroute?.stranded,
        directions: d?.directions?.map((x) => ({ direction: x.direction, required: x.required, absorbed: x.absorbed, unmet: x.unmet, cut: x.cut.slice(0, 6), strandedAt: x.strandedAt.slice(0, 6) })),
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

/** Persists each tool call as an Episode in the visitor's graph: the incident's history is graph state. */
export async function recordEpisode(ctx: ToolContext, r: ToolResult) {
  try {
    await run(
      ctx.sandbox,
      `MATCH (ag:Agent {id: $agent})
       OPTIONAL MATCH (i:Incident {status: 'open'})
       CREATE (ag)-[:ACTED]->(e:Episode {tool: $tool, outcome: $outcome, summary: $summary, atMs: timestamp(),
         queries: $queries, ms: $ms})
       FOREACH (_ IN CASE WHEN i IS NULL THEN [] ELSE [1] END | CREATE (e)-[:IN]->(i))`,
      {
        agent: ctx.agentId,
        tool: r.tool,
        outcome: r.outcome,
        summary: clip(r.summary, 600),
        queries: r.trace.length,
        ms: Math.round(r.trace.reduce((s, t) => s + t.ms, 0)),
      },
    );
  } catch {
    // History is best effort; the answer already reached the user.
  }
}

export function buildTools(base: Omit<ToolContext, "tracer">, emit: Emit, agent: string): ToolSet {
  let seq = 0;
  const wrap = <I>(name: string, fn: (ctx: ToolContext, input: I) => Promise<ToolResult>) => {
    return async (input: I) => {
      const id = `${name}-${++seq}`;
      emit({ type: "tool-call", agent, id, tool: name, input });
      const ctx: ToolContext = { ...base, tracer: new Tracer() };
      try {
        const r = await fn(ctx, input);
        emit({ type: "tool-result", agent, id, result: forClient(r) });
        void recordEpisode(ctx, r);
        return forModel(r);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "tool-error", agent, id, tool: name, message });
        return { outcome: "error", summary: `The tool failed: ${message}. Try a different step or report the gap.` };
      }
    };
  };

  return {
    recall_memory: tool({
      description:
        "Read what earlier sessions learned about stations or routes: current and closed facts with dates, past incidents with planned versus observed shuttle capacity, and playbooks. Call this early; cite dates when you use it.",
      inputSchema: z.object({ station_ids: ids.optional(), routes: z.array(z.string().max(3)).max(8).optional() }),
      execute: wrap("recall_memory", (ctx, i: { station_ids?: string[]; routes?: string[] }) => recall(ctx, { stations: i.station_ids, routes: i.routes })),
    }),
    resolve_places: tool({
      description:
        "Resolve station and route names to graph ids before using them. Returns ids, ambiguous candidates, or unknown names (never guess an id). Use route_hint to disambiguate stations that share a name.",
      inputSchema: z.object({ names: z.array(z.string().min(1).max(80)).min(1).max(8), route_hint: z.string().max(3).optional() }),
      execute: wrap("resolve_places", (ctx, i: { names: string[]; route_hint?: string }) => resolvePlaces(ctx, { names: i.names, routeHint: i.route_hint })),
    }),
    close_line: tool({
      description:
        "Open an incident: close the given routes between two resolved station ids (both directions) in this sandbox graph. Replaces any earlier closure.",
      inputSchema: z.object({
        routes: z.array(z.string().max(3)).min(1).max(4),
        from_station_id: z.string(),
        to_station_id: z.string(),
        report: z.string().max(400),
        title: z.string().max(80).optional(),
      }),
      execute: wrap("close_line", (ctx, i: { routes: string[]; from_station_id: string; to_station_id: string; report: string; title?: string }) =>
        closeLine(ctx, { routes: i.routes, fromStation: i.from_station_id, toStation: i.to_station_id, report: i.report, title: i.title }),
      ),
    }),
    affected_riders: tool({
      description:
        "Riders per hour whose trips cross the closure, by how many stops their origin is from it (depth 0 to 8). Compare depth 1 with depth 4 to show riders far from the closure who are still hit.",
      inputSchema: z.object({ depth: z.number().int().min(0).max(8).optional() }),
      execute: wrap("affected_riders", (ctx, i: { depth?: number }) => affectedRiders(ctx, { depth: i.depth })),
    }),
    measure_capacity: tool({
      description:
        "Capacity picture of the open closure on a forked graph: (1) every displaced rider takes the fastest open path: which segments overflow and who has no path; (2) algo.maxFlow on spare capacity: how many could get through if spread perfectly, and the min-cut bottleneck.",
      inputSchema: z.object({}),
      execute: wrap("measure_capacity", (ctx) => measureCapacity(ctx)),
    }),
    shuttle_candidates: tool({
      description:
        "Station pairs for a shuttle-bus bridge: stations whose riders cannot move, paired with nearby stations on open lines with spare capacity, with suggested buses per hour.",
      inputSchema: z.object({ max_km: z.number().min(0.5).max(4).optional() }),
      execute: wrap("shuttle_candidates", (ctx, i: { max_km?: number }) => shuttleCandidates(ctx, { maxKm: i.max_km })),
    }),
    simulate_plan: tool({
      description:
        "Test a shuttle plan (1 to 4 legs) on its own fork of the graph: adds bus links, reroutes riders, reruns max flow. Returns overflow, riders with no path and max-flow shortfall before and after, the buses needed (fleet limit 120), and a plan id.",
      inputSchema: z.object({
        shuttles: z
          .array(z.object({ from_station_id: z.string(), to_station_id: z.string(), buses_per_hour: z.number().int().min(1).max(60) }))
          .min(1)
          .max(4),
        label: z.string().max(80).optional(),
      }),
      execute: wrap("simulate_plan", (ctx, i: { shuttles: { from_station_id: string; to_station_id: string; buses_per_hour: number }[]; label?: string }) =>
        simulatePlan(ctx, { shuttles: i.shuttles.map((s) => ({ from: s.from_station_id, to: s.to_station_id, busesPerHour: s.buses_per_hour })), label: i.label }),
      ),
    }),
    propose_steering: tool({
      description:
        "Record a plan with no buses, for when measure_capacity shows nobody stranded and no max-flow shortfall: riders are steered onto open lines. Publishable like a shuttle plan.",
      inputSchema: z.object({}),
      execute: wrap("propose_steering", (ctx) => proposeSteering(ctx)),
    }),
    riders_affected: tool({
      description: "Which remembered riders' usual trips cross the open closure, with their needs and preferences.",
      inputSchema: z.object({}),
      execute: wrap("riders_affected", (ctx) => ridersAffected(ctx)),
    }),
    route_rider: tool({
      description:
        "Fastest open route for a remembered rider (rider_id) or between two resolved station ids, using any published shuttle. step_free keeps boarding, transfer and exit stations accessible and skips stations with an elevator outage in memory.",
      inputSchema: z.object({
        rider_id: z.string().max(20).optional(),
        from_station_id: z.string().optional(),
        to_station_id: z.string().optional(),
        step_free: z.boolean().optional(),
        avoid_routes: z.array(z.string().max(3)).max(4).optional(),
      }),
      execute: wrap("route_rider", (ctx, i: { rider_id?: string; from_station_id?: string; to_station_id?: string; step_free?: boolean; avoid_routes?: string[] }) =>
        routeRider(ctx, { riderId: i.rider_id, from: i.from_station_id, to: i.to_station_id, stepFree: i.step_free, avoidRoutes: i.avoid_routes }),
      ),
    }),
    remember: tool({
      description:
        "Write a finding to memory with today's date and its provenance (stations, routes, this incident). Use supersedes with an older finding id when a fact changed; the old one is closed, not deleted.",
      inputSchema: z.object({
        text: z.string().min(10).max(400),
        kind: z.enum(["observation", "capacity", "accessibility", "crowding", "plan"]),
        station_ids: ids.optional(),
        routes: z.array(z.string().max(3)).max(8).optional(),
        supersedes: z.string().max(40).optional(),
      }),
      execute: wrap("remember", (ctx, i: { text: string; kind: "observation" | "capacity" | "accessibility" | "crowding" | "plan"; station_ids?: string[]; routes?: string[]; supersedes?: string }) =>
        remember(ctx, { text: i.text, kind: i.kind, stations: i.station_ids, routes: i.routes, supersedes: i.supersedes }),
      ),
    }),
  };
}
