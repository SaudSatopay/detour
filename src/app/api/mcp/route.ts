import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { copyGraph, deleteGraph } from "@/lib/graph/db";
import { newVisitorId, sandboxGraph, TEMPLATE_GRAPH } from "@/lib/graph/names";
import { dropForks, ensureBase } from "@/lib/graph/tenancy";
import { Tracer } from "@/lib/graph/trace";
import { affectedRiders } from "@/lib/graph/tools/impact";
import { closeLine } from "@/lib/graph/tools/incident";
import { measureCapacity, simulatePlan, type CapacityData, type PlanData } from "@/lib/graph/tools/capacity";
import { recall } from "@/lib/graph/tools/memory";
import { resolvePlaces } from "@/lib/graph/tools/places";
import { routeRider } from "@/lib/graph/tools/riders";
import type { ToolContext, ToolResult } from "@/lib/graph/tools/types";
import type { ImpactData } from "@/lib/graph/tools/impact";
import { allow, friendlyError } from "@/lib/server/http";

export const maxDuration = 60;

/**
 * Detour's graph tools over MCP (Streamable HTTP, stateless). Reads run on the shared template graph,
 * which is never written; assess_closure copies the template into a throwaway graph per call, so
 * clients never see each other's closures.
 */
const station = z.string().regex(/^\d{1,4}$/, 'a station id from resolve_places, such as "120"');
const routes = z.array(z.string().regex(/^[A-Z0-9]{1,3}$/i)).min(1).max(4);

const text = (r: ToolResult, extra?: unknown) => ({
  content: [
    { type: "text" as const, text: `[${r.outcome}] ${r.summary}` },
    ...(extra === undefined ? [] : [{ type: "text" as const, text: JSON.stringify(extra) }]),
  ],
  isError: false,
});
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

const readCtx = (): ToolContext => ({ visitorId: "mcptemplate", sandbox: TEMPLATE_GRAPH, agentId: "mcp", tracer: new Tracer() });

async function guarded<T>(fn: () => Promise<T>) {
  try {
    await ensureBase();
    return await fn();
  } catch (error) {
    return failure(friendlyError(error));
  }
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "resolve_places",
      {
        title: "Resolve station and route names",
        description:
          "Resolve New York City subway station and route names to graph ids. Returns ids, ambiguous candidates, or unknown names. Call before any tool that takes a station id.",
        inputSchema: z.object({ names: z.array(z.string().min(1).max(80)).min(1).max(8), route_hint: z.string().max(3).optional() }),
      },
      async ({ names, route_hint }) => guarded(async () => {
        const r = await resolvePlaces(readCtx(), { names, routeHint: route_hint });
        return text(r, r.data);
      }),
    );

    server.registerTool(
      "route_trip",
      {
        title: "Fastest subway route",
        description:
          "Fastest route between two station ids at 8 a.m. on a weekday, by riding, transferring (wait plus penalty) and walking. step_free keeps every boarding and exit at accessible stations and skips platforms with an elevator outage remembered as current.",
        inputSchema: z.object({ from_station_id: station, to_station_id: station, step_free: z.boolean().optional() }),
      },
      async ({ from_station_id, to_station_id, step_free }) => guarded(async () => {
        const r = await routeRider(readCtx(), { from: from_station_id, to: to_station_id, stepFree: step_free });
        return text(r, r.data.answer ? { minutes: r.data.answer.minutes, transfers: r.data.answer.transfers, legs: r.data.answer.legs } : undefined);
      }),
    );

    server.registerTool(
      "recall_memory",
      {
        title: "Recall what earlier incidents taught",
        description: "Facts with validity dates, past incidents with planned versus observed shuttle capacity, and playbooks, for the given routes and station ids.",
        inputSchema: z.object({ routes: z.array(z.string().max(3)).max(8).optional(), station_ids: z.array(station).max(12).optional() }),
      },
      async ({ routes: r, station_ids }) => guarded(async () => {
        const res = await recall(readCtx(), { routes: r, stations: station_ids });
        return text(res);
      }),
    );

    server.registerTool(
      "assess_closure",
      {
        title: "Assess a line closure",
        description:
          "Close the given routes between two station ids on a private copy of the graph, then report riders hit by distance from the closure, where their fastest paths overflow, what max flow says the open network can carry with the min cut, and optionally test a shuttle-bus plan. Takes a few seconds.",
        inputSchema: z.object({
          routes,
          from_station_id: station,
          to_station_id: station,
          shuttles: z
            .array(z.object({ from_station_id: station, to_station_id: station, buses_per_hour: z.number().int().min(1).max(60) }))
            .max(4)
            .optional(),
        }),
      },
      async (input, ctx) => guarded(async () => {
        const who = ctx.http?.req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
        if (!(await allow(who.replace(/[^a-z0-9.:]/gi, ""), "mcp-assess", 30))) return failure("Rate limited: 30 closure assessments an hour per client. Try again later.");

        const id = `mcp${newVisitorId()}`.slice(0, 32);
        const graph = sandboxGraph(id);
        await copyGraph(TEMPLATE_GRAPH, graph);
        try {
          const c = (): ToolContext => ({ visitorId: id, sandbox: graph, agentId: "controller", tracer: new Tracer() });
          const closed = await closeLine(c(), {
            routes: input.routes.map((x) => x.toUpperCase()),
            fromStation: input.from_station_id,
            toStation: input.to_station_id,
            report: "Assessment requested over MCP",
          });
          if (closed.outcome !== "answered") return text(closed);
          const impact = await affectedRiders(c(), { depth: 4 });
          const capacity = await measureCapacity(c());
          const plan = input.shuttles?.length
            ? await simulatePlan(c(), { shuttles: input.shuttles.map((s) => ({ from: s.from_station_id, to: s.to_station_id, busesPerHour: s.buses_per_hour })) })
            : null;
          const imp = impact.data as ImpactData | null;
          const cap = capacity.data as CapacityData | null;
          const p = plan?.data as PlanData | null | undefined;
          return {
            content: [
              { type: "text" as const, text: [closed.summary, impact.summary, capacity.summary, plan?.summary].filter(Boolean).join("\n\n") },
              {
                type: "text" as const,
                text: JSON.stringify({
                  displaced: imp?.totalRiders,
                  byDepth: imp?.byDepth.map((d) => ({ depth: d.depth, riders: d.riders })),
                  overloaded: cap?.reroute.overloaded.slice(0, 6).map((o) => ({ route: o.route, from: o.from, to: o.to, pct: o.pct })),
                  stranded: cap?.reroute.stranded,
                  maxFlow: cap?.directions.map((d) => ({ direction: d.direction, required: d.required, absorbed: d.absorbed, unmet: d.unmet })),
                  plan: p ? { vehicles: p.vehicles, before: p.before, after: p.after } : undefined,
                  queries: [closed, impact, capacity, plan].reduce((s, r) => s + (r?.trace.length ?? 0), 0),
                }),
              },
            ],
            isError: false,
          };
        } finally {
          await dropForks(id).catch(() => undefined);
          await deleteGraph(graph).catch(() => undefined);
        }
      }),
    );
  },
  { serverInfo: { name: "detour", version: "1.0.0" } },
);

export { handler as GET, handler as POST };
