import { z } from "zod";
import { Tracer } from "@/lib/graph/trace";
import { ensureSandbox } from "@/lib/graph/tenancy";
import { routeRider } from "@/lib/graph/tools/riders";
import { friendlyError, visitorId } from "@/lib/server/http";

export const maxDuration = 30;

const Body = z.object({
  riderId: z.string().regex(/^[a-z]{2,20}$/),
  stepFree: z.boolean().optional(),
});

/** A remembered rider's fastest open route on the visitor's graph right now: closure, published shuttles and memory included. No model involved. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { riderId } for a remembered rider." }, { status: 400 });
  try {
    const visitor = await visitorId();
    const sandbox = await ensureSandbox(visitor);
    const ctx = { visitorId: visitor, sandbox: sandbox.graph, agentId: "rider-desk", tracer: new Tracer() };
    return Response.json(await routeRider(ctx, { riderId: parsed.data.riderId, stepFree: parsed.data.stepFree }));
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}
