import { z } from "zod";
import { recordedRoute } from "@/lib/agent/replay";
import { Tracer } from "@/lib/graph/trace";
import { ensureSandbox } from "@/lib/graph/tenancy";
import { routeRider } from "@/lib/graph/tools/riders";
import { friendlyError, visitorId } from "@/lib/server/http";

export const maxDuration = 30;

const Body = z.object({
  riderId: z.string().regex(/^[a-z]{2,20}$/),
  stepFree: z.boolean().optional(),
  /** Set when the page shows a recorded state (the database is unreachable): answers with that run's route for the rider. */
  recorded: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});

/** A remembered rider's fastest open route on the visitor's graph right now: closure, published shuttles and memory included. No model involved. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { riderId } for a remembered rider." }, { status: 400 });
  if (parsed.data.recorded) {
    const route = await recordedRoute(parsed.data.recorded, parsed.data.riderId);
    return route ? Response.json(route) : Response.json({ error: "The recorded run did not route this rider." }, { status: 404 });
  }
  try {
    const visitor = await visitorId();
    const sandbox = await ensureSandbox(visitor);
    const ctx = { visitorId: visitor, sandbox: sandbox.graph, agentId: "rider-desk", tracer: new Tracer() };
    return Response.json(await routeRider(ctx, { riderId: parsed.data.riderId, stepFree: parsed.data.stepFree }));
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}
