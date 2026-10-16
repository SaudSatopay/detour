import { z } from "zod";
import { recordEpisode } from "@/lib/agent/catalog";
import { Tracer } from "@/lib/graph/trace";
import { ensureSandbox } from "@/lib/graph/tenancy";
import { reportElevator } from "@/lib/graph/tools/memory";
import { loadNetwork } from "@/lib/network/data";
import { friendlyError, visitorId } from "@/lib/server/http";

export const maxDuration = 30;

const Body = z.object({
  action: z.literal("elevator"),
  station: z.string().regex(/^\d{1,4}$/),
  route: z.string().regex(/^[A-Z0-9]{1,3}$/),
  working: z.boolean(),
});

/** Writes a rider-desk report into the visitor's memory graph, superseding the fact it replaces. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { action: 'elevator', station, route, working }." }, { status: 400 });
  try {
    const visitor = await visitorId();
    const sandbox = await ensureSandbox(visitor);
    const network = await loadNetwork();
    const station = network.stations.find((s) => s.id === parsed.data.station);
    if (!station) return Response.json({ error: `No station ${parsed.data.station} in the graph.` }, { status: 404 });
    const ctx = { visitorId: visitor, sandbox: sandbox.graph, agentId: "rider-desk", tracer: new Tracer() };
    const res = await reportElevator(ctx, { station: station.id, stationName: station.name, route: parsed.data.route, working: parsed.data.working });
    void recordEpisode(ctx, res);
    return Response.json(res);
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}
