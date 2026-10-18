import { z } from "zod";
import { affectedRiders } from "../graph/tools/impact";
import { closeLine } from "../graph/tools/incident";
import { measureCapacity, measureHeadroom, shuttleCandidates, simulatePlan } from "../graph/tools/capacity";
import { recall, remember } from "../graph/tools/memory";
import { proposeSteering } from "../graph/tools/plan";
import { resolvePlaces } from "../graph/tools/places";
import { ridersAffected, routeRider } from "../graph/tools/riders";
import type { ToolContext, ToolResult } from "../graph/tools/types";

/**
 * The agents' tool catalogue, defined once. The MCP server at /api/mcp serves every entry; the controller and the
 * rider desk discover their own subset from it over MCP (tools/list) and call them there (tools/call), the same way
 * an outside agent does. buildTools in catalog.ts turns the same entries into in-process tools when MCP is
 * unreachable.
 */
export type AgentRole = "controller" | "rider-desk";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  /** The in-app agents that get this tool. */
  roles: AgentRole[];
  /**
   * Whether it needs the caller's own graph: it writes, or reads the caller's open incident. Without a session the
   * other tools run on the shared template graph, which is never written.
   */
  session: boolean;
  /** MCP tool annotations: hints for clients about what a call does. */
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: false };
  run: (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolResult>;
}

const ids = z.array(z.string().regex(/^\d{1,4}$/, 'a station id such as "120"')).max(12);
const routeList = z.array(z.string().max(3));
const read = { readOnlyHint: true, openWorldHint: false } as const;
const write = (destructiveHint: boolean, idempotentHint = false) => ({ readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint: false }) as const;

/* eslint-disable @typescript-eslint/no-explicit-any -- each run() receives the input its own schema just validated */
export const TOOLBOX: ToolDef[] = [
  {
    name: "resolve_places",
    title: "Resolve station and route names",
    description:
      "Resolve station and route names to graph ids before using them. Returns ids, ambiguous candidates, or unknown names (never guess an id). Use route_hint to disambiguate stations that share a name.",
    input: z.object({ names: z.array(z.string().min(1).max(80)).min(1).max(8), route_hint: z.string().max(3).optional() }),
    roles: ["controller", "rider-desk"],
    session: false,
    annotations: read,
    run: (ctx, i: any) => resolvePlaces(ctx, { names: i.names, routeHint: i.route_hint }),
  },
  {
    name: "recall_memory",
    title: "Recall what earlier incidents taught",
    description:
      "Read what earlier sessions learned about stations or routes: current and closed facts with dates, past incidents with planned versus observed shuttle capacity, and playbooks. Call this early; cite dates when you use it.",
    input: z.object({ station_ids: ids.optional(), routes: routeList.max(8).optional() }),
    roles: ["controller", "rider-desk"],
    session: false,
    annotations: read,
    run: (ctx, i: any) => recall(ctx, { stations: i.station_ids, routes: i.routes }),
  },
  {
    name: "close_line",
    title: "Close a line between two stations",
    description:
      "Open an incident: close the given routes between two resolved station ids (both directions) in this sandbox graph. Replaces any earlier closure.",
    input: z.object({
      routes: routeList.min(1).max(4),
      from_station_id: z.string(),
      to_station_id: z.string(),
      report: z.string().max(400),
      title: z.string().max(80).optional(),
    }),
    roles: ["controller"],
    session: true,
    annotations: write(true, true),
    run: (ctx, i: any) => closeLine(ctx, { routes: i.routes, fromStation: i.from_station_id, toStation: i.to_station_id, report: i.report, title: i.title }),
  },
  {
    name: "affected_riders",
    title: "Riders the closure hits",
    description:
      "Riders per hour whose trips cross the closure, by how many stops their origin is from it (depth 0 to 8). Compare depth 1 with depth 4 to show riders far from the closure who are still hit.",
    input: z.object({ depth: z.number().int().min(0).max(8).optional() }),
    roles: ["controller"],
    session: true,
    annotations: read,
    run: (ctx, i: any) => affectedRiders(ctx, { depth: i.depth }),
  },
  {
    name: "measure_capacity",
    title: "What the open network can carry",
    description:
      "Capacity picture of the open closure on a forked graph: (1) every displaced rider takes the fastest open path: which segments overflow and who has no path; (2) algo.maxFlow on spare capacity: how many could get through if spread perfectly, and the min-cut bottleneck.",
    input: z.object({}),
    roles: ["controller"],
    session: true,
    annotations: write(false, true),
    run: (ctx) => measureCapacity(ctx),
  },
  {
    name: "measure_headroom",
    title: "How much more the network can take",
    description:
      "How much more displaced demand the open network can take before an open segment saturates, on a forked graph: an exact parametric max flow (a few certified algo.maxFlow solves with the demand scaled). Returns the multiplier per direction, the segments that fill first, and the stations the closure cuts off. Run after measure_capacity.",
    input: z.object({ max_scale: z.number().min(1.5).max(100).optional().describe("Largest demand multiplier to search; default 20") }),
    roles: ["controller"],
    session: true,
    annotations: read,
    run: (ctx, i: any) => measureHeadroom(ctx, { maxScale: i.max_scale }),
  },
  {
    name: "shuttle_candidates",
    title: "Where a shuttle bus could help",
    description:
      "Station pairs for a shuttle-bus bridge: stations whose riders cannot move, paired with nearby stations on open lines with spare capacity, with suggested buses per hour.",
    input: z.object({ max_km: z.number().min(0.5).max(4).optional() }),
    roles: ["controller"],
    session: true,
    annotations: read,
    run: (ctx, i: any) => shuttleCandidates(ctx, { maxKm: i.max_km }),
  },
  {
    name: "simulate_plan",
    title: "Test a shuttle plan on a fork",
    description:
      "Test a shuttle plan (1 to 4 legs) on its own fork of the graph: adds bus links, reroutes riders, reruns max flow. Returns overflow, riders with no path and max-flow shortfall before and after, the buses needed (fleet limit 120), and a plan id.",
    input: z.object({
      shuttles: z
        .array(z.object({ from_station_id: z.string(), to_station_id: z.string(), buses_per_hour: z.number().int().min(1).max(60) }))
        .min(1)
        .max(4),
      label: z.string().max(80).optional(),
    }),
    roles: ["controller"],
    session: true,
    annotations: write(false),
    run: (ctx, i: any) =>
      simulatePlan(ctx, {
        shuttles: (i.shuttles as { from_station_id: string; to_station_id: string; buses_per_hour: number }[]).map((s) => ({
          from: s.from_station_id,
          to: s.to_station_id,
          busesPerHour: s.buses_per_hour,
        })),
        label: i.label,
      }),
  },
  {
    name: "propose_steering",
    title: "Propose steering with no buses",
    description:
      "Record a plan with no buses, for when measure_capacity shows nobody stranded and no max-flow shortfall. Once published, the rider desk routes riders around the segments measure_capacity found over capacity. Publishable like a shuttle plan.",
    input: z.object({}),
    roles: ["controller"],
    session: true,
    annotations: write(false),
    run: (ctx) => proposeSteering(ctx),
  },
  {
    name: "riders_affected",
    title: "Remembered riders the closure hits",
    description: "Which remembered riders' usual trips cross the open closure, with their needs and preferences.",
    input: z.object({}),
    roles: ["rider-desk"],
    session: true,
    annotations: read,
    run: (ctx) => ridersAffected(ctx),
  },
  {
    name: "route_rider",
    title: "Route a rider",
    description:
      "Fastest open route for a remembered rider (rider_id) or between two resolved station ids, using any published shuttle. step_free keeps boarding, transfer and exit stations accessible and skips stations with an elevator outage in memory. While the incident's crowding is set, paths avoid segments over capacity when a reasonable alternative exists.",
    input: z.object({
      rider_id: z.string().max(20).optional(),
      from_station_id: z.string().optional(),
      to_station_id: z.string().optional(),
      step_free: z.boolean().optional(),
      avoid_routes: routeList.max(4).optional(),
    }),
    roles: ["rider-desk"],
    session: false,
    annotations: read,
    run: (ctx, i: any) => routeRider(ctx, { riderId: i.rider_id, from: i.from_station_id, to: i.to_station_id, stepFree: i.step_free, avoidRoutes: i.avoid_routes }),
  },
  {
    name: "remember",
    title: "Write a finding to memory",
    description:
      "Write a finding to memory with today's date and its provenance (stations, routes, this incident). Use supersedes with an older finding id when a fact changed; the old one is closed, not deleted. Set about_incident to false for a fact unrelated to the open closure.",
    input: z.object({
      text: z.string().min(10).max(400),
      kind: z.enum(["observation", "capacity", "accessibility", "crowding", "plan"]),
      station_ids: ids.optional(),
      routes: routeList.max(8).optional(),
      supersedes: z.string().max(40).optional(),
      about_incident: z.boolean().optional(),
    }),
    roles: ["controller", "rider-desk"],
    session: true,
    annotations: write(false),
    run: (ctx, i: any) => remember(ctx, { text: i.text, kind: i.kind, stations: i.station_ids, routes: i.routes, supersedes: i.supersedes, aboutIncident: i.about_incident }),
  },
];
/* eslint-enable @typescript-eslint/no-explicit-any */

export const toolsFor = (role: AgentRole) => TOOLBOX.filter((t) => t.roles.includes(role));
