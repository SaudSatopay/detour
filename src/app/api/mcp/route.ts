import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { forClient, forModel, recordEpisode } from "@/lib/agent/catalog";
import { TOOLBOX } from "@/lib/agent/toolbox";
import { copyGraph, deleteGraph, run } from "@/lib/graph/db";
import { newVisitorId, sandboxGraph, TEMPLATE_GRAPH } from "@/lib/graph/names";
import { dropForks, ensureBase, ensureSandbox } from "@/lib/graph/tenancy";
import { Tracer } from "@/lib/graph/trace";
import { affectedRiders } from "@/lib/graph/tools/impact";
import { closeLine } from "@/lib/graph/tools/incident";
import { measureCapacity, simulatePlan, type CapacityData, type PlanData } from "@/lib/graph/tools/capacity";
import { routeRider } from "@/lib/graph/tools/riders";
import type { ToolContext, ToolResult } from "@/lib/graph/tools/types";
import type { ImpactData } from "@/lib/graph/tools/impact";
import { allow, friendlyError } from "@/lib/server/http";
import { newMcpVisitor, signSession, verifySession } from "@/lib/server/mcp-session";

export const maxDuration = 60;

/**
 * Detour's agent tools over MCP (Streamable HTTP, stateless). This is the same catalogue the control room's own
 * agents use: they list it here (tools/list) and call it here (tools/call), with a session for the visitor's sandbox.
 *
 * An outside agent calls open_session for a graph of its own and passes the token as `session`. Without one, the
 * reading tools run on the shared template graph, which is never written, and the tools that change a graph say to
 * open a session first. Publishing a plan to riders is not here: that takes a person in the control room.
 */
const station = z.string().regex(/^\d{1,4}$/, 'a station id from resolve_places, such as "120"');
const routes = z.array(z.string().regex(/^[A-Z0-9]{1,3}$/i)).min(1).max(4);
const SESSION = z.string().max(120).optional().describe("The token from open_session (outside agents; the control room's agents send theirs in a header).");

type Extra = { http?: { req?: Request } };
const text = (r: ToolResult, extra?: unknown) => ({
  content: [
    { type: "text" as const, text: `[${r.outcome}] ${r.summary}` },
    ...(extra === undefined ? [] : [{ type: "text" as const, text: JSON.stringify(extra) }]),
  ],
  isError: false,
});
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
const clientOf = (extra: Extra) => (extra.http?.req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon").replace(/[^a-z0-9.:]/gi, "");

const templateCtx = (): ToolContext => ({ visitorId: "mcptemplate", sandbox: TEMPLATE_GRAPH, agentId: "mcp", tracer: new Tracer() });

/** An outside agent's steps are recorded as episodes under an agent of its own. */
async function ensureMcpAgent(graph: string): Promise<void> {
  await run(graph, "MERGE (a:Agent {id: 'mcp'}) ON CREATE SET a.name = $name, a.role = $role", {
    name: "Outside agent over MCP",
    role: "An agent connected through Detour's MCP server",
  });
}

interface Caller {
  ctx: () => ToolContext;
  /** Whether the call runs on a graph of the caller's own. */
  own: boolean;
  /** The control room's agents: already rate limited by their run, and they record their own episodes with the model's reason. */
  inApp: boolean;
}

async function callerOf(token: string | undefined, extra: Extra): Promise<Caller> {
  const session = verifySession(extra.http?.req?.headers.get("x-detour-session") || token);
  if (!session) return { ctx: templateCtx, own: false, inApp: false };
  const sandbox = await ensureSandbox(session.visitorId);
  if (session.role === "mcp") await ensureMcpAgent(sandbox.graph);
  return {
    ctx: () => ({ visitorId: session.visitorId, sandbox: sandbox.graph, agentId: session.role, tracer: new Tracer() }),
    own: true,
    inApp: session.role !== "mcp",
  };
}

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
      "open_session",
      {
        title: "Open a session with a graph of your own",
        description:
          "Copies the New York subway graph into a sandbox only you can change and returns a session token. Pass it as `session` to every tool that closes lines, measures capacity, tests plans or writes memory. A session lasts three days; the free database keeps the 8 most recently used sandboxes.",
        inputSchema: z.object({}),
        annotations: { title: "Open a session", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (_input, extra) => guarded(async () => {
        if (!(await allow(clientOf(extra), "mcp-session", 10))) return failure("Rate limited: 10 sessions an hour per client. Reuse the session you have.");
        const visitor = newMcpVisitor();
        const sandbox = await ensureSandbox(visitor);
        await ensureMcpAgent(sandbox.graph);
        const session = signSession(visitor, "mcp");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                session,
                graph: sandbox.graph,
                next: "Pass session to close_line, then affected_riders, measure_capacity, shuttle_candidates and simulate_plan; recall_memory and remember read and write this graph's memory.",
              }),
            },
          ],
          structuredContent: { session, graph: sandbox.graph },
          isError: false,
        };
      }),
    );

    for (const def of TOOLBOX) {
      server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.session ? `${def.description} Works on your own graph: pass the session from open_session.` : def.description,
          inputSchema: def.input.extend({ session: SESSION }),
          annotations: { title: def.title, ...def.annotations },
        },
        async (input, extra) => guarded(async () => {
          const { session, ...args } = input as Record<string, unknown> & { session?: string };
          const caller = await callerOf(session, extra);
          if (!caller.inApp && !(await allow(clientOf(extra), "mcp", 240))) return failure("Rate limited: 240 tool calls an hour per client. Try again later.");
          if (def.session && !caller.own) return failure(`${def.name} works on a graph of your own: call open_session first, then pass its session.`);
          const ctx = caller.ctx();
          const r = await def.run(ctx, args);
          if (!caller.inApp && caller.own) void recordEpisode(ctx, r, { input: args, model: "outside agent" });
          // The text is what a model reads; the structured result carries the whole answer (and its Cypher) for a UI.
          return { content: [{ type: "text" as const, text: JSON.stringify(forModel(r)) }], structuredContent: { result: forClient(r) }, isError: false };
        }),
      );
    }

    server.registerTool(
      "route_trip",
      {
        title: "Fastest subway route",
        description:
          "Fastest route between two station ids at 8 a.m. on a weekday, by riding, transferring (wait plus penalty) and walking. step_free keeps every boarding and exit at accessible stations and skips platforms with an elevator outage remembered as current.",
        inputSchema: z.object({ from_station_id: station, to_station_id: station, step_free: z.boolean().optional() }),
        annotations: { title: "Fastest subway route", readOnlyHint: true, openWorldHint: false },
      },
      async ({ from_station_id, to_station_id, step_free }) => guarded(async () => {
        const r = await routeRider(templateCtx(), { from: from_station_id, to: to_station_id, stepFree: step_free });
        return text(r, r.data.answer ? { minutes: r.data.answer.minutes, transfers: r.data.answer.transfers, legs: r.data.answer.legs } : undefined);
      }),
    );

    server.registerTool(
      "assess_closure",
      {
        title: "Assess a line closure",
        description:
          "One call for the whole assessment, on a private copy of the graph that is deleted afterwards: close the given routes between two station ids, then report riders hit by distance from the closure, where their fastest paths overflow, what max flow says the open network can carry with the min cut, and optionally test a shuttle-bus plan. Takes a few seconds.",
        inputSchema: z.object({
          routes,
          from_station_id: station,
          to_station_id: station,
          shuttles: z
            .array(z.object({ from_station_id: station, to_station_id: station, buses_per_hour: z.number().int().min(1).max(60) }))
            .max(4)
            .optional(),
        }),
        annotations: { title: "Assess a line closure", readOnlyHint: true, openWorldHint: false },
      },
      async (input, extra) => guarded(async () => {
        if (!(await allow(clientOf(extra), "mcp-assess", 30))) return failure("Rate limited: 30 closure assessments an hour per client. Try again later.");

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
  { serverInfo: { name: "detour", version: "1.1.0" } },
);

export { handler as GET, handler as POST };
