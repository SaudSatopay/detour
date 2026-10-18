import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sandboxState } from "@/lib/graph/state";
import { Tracer } from "@/lib/graph/trace";
import { ensureSandbox, resetSandbox } from "@/lib/graph/tenancy";
import { resolveIncident } from "@/lib/graph/tools/plan";
import { friendlyError, visitorId } from "@/lib/server/http";

export const maxDuration = 60;

const SCENARIO = /^[a-z0-9-]{1,40}$/;

/**
 * The visitor's sandbox: open incident, plans, remembered riders with their latest advisory, memory.
 * When the database is unreachable and the page is showing a recorded run, serves the state recorded
 * with it (labeled as recorded).
 */
export async function GET(request: Request) {
  const recorded = new URL(request.url).searchParams.get("recorded");
  try {
    return Response.json(await sandboxState(await visitorId()));
  } catch (error) {
    if (recorded && SCENARIO.test(recorded)) {
      try {
        const file = join(/* turbopackIgnore: true */ process.cwd(), "data", "replays", `${recorded}-state.json`);
        return Response.json({ ...JSON.parse(await readFile(file, "utf8")), recorded });
      } catch {
        // fall through to the error
      }
    }
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}

const STATION = /^[A-Za-z0-9]{1,8}$/;

/** reset, or resolve with what each published shuttle leg carried (riders an hour), which procedural memory learns from. */
const Body = z.object({
  action: z.enum(["reset", "resolve"]),
  observed: z
    .array(z.object({ from: z.string().regex(STATION), to: z.string().regex(STATION), riders: z.number().int().min(1).max(20_000) }))
    .max(4)
    .optional(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Send { action: 'reset' } or { action: 'resolve', observed?: [{ from, to, riders }] } with riders a whole number from 1 to 20,000." }, { status: 400 });
  }
  try {
    const visitor = await visitorId();
    if (parsed.data.action === "reset") {
      await resetSandbox(visitor);
      return Response.json({ ok: true, message: "Your sandbox was copied fresh from the template." });
    }
    const sandbox = await ensureSandbox(visitor);
    const res = await resolveIncident({ visitorId: visitor, sandbox: sandbox.graph, agentId: "controller", tracer: new Tracer() }, { observed: parsed.data.observed });
    return Response.json({ ok: res.outcome === "answered", message: res.summary, learned: res.data, trace: res.trace });
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}
