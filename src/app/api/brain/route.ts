import { z } from "zod";
import { answerBrain } from "@/lib/agent/brain";
import { hasLiveModel } from "@/lib/agent/models";
import { ensureOrgLayer } from "@/lib/graph/org";
import { Tracer } from "@/lib/graph/trace";
import { ensureSandbox } from "@/lib/graph/tenancy";
import { brainDirectory } from "@/lib/graph/tools/brain";
import { allow, allowToday, friendlyError, visitorId } from "@/lib/server/http";

export const maxDuration = 120;

/** Live brain answers a day across all visitors, alongside the control room's and rider desk's share of the free tiers. */
const LIVE_PER_DAY = 60;

const Body = z.object({ question: z.string().trim().min(2).max(400) });

/** The visitor's graph with the agency layer in it: teams, people and what they own, open tickets, decisions. */
export async function GET() {
  try {
    const visitor = await visitorId();
    const sandbox = await ensureSandbox(visitor);
    await ensureOrgLayer(sandbox.graph);
    return Response.json(await brainDirectory({ visitorId: visitor, sandbox: sandbox.graph, agentId: "brain", tracer: new Tracer() }));
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}

/**
 * Answers one question about the agency with cited sources. live: a free model picks the graph tools.
 * scripted: no model quota, so the standard procedure picks one tool and answers in templated words.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { question } with 2 to 400 characters." }, { status: 400 });
  try {
    const visitor = await visitorId();
    const sandbox = await ensureSandbox(visitor);
    await ensureOrgLayer(sandbox.graph);
    const live =
      hasLiveModel() &&
      (await allow(visitor, "brain", 20).catch(() => false)) &&
      (await allowToday("brain", LIVE_PER_DAY).catch(() => false));
    const note = live
      ? undefined
      : hasLiveModel()
        ? "The free model runs are used up for now, so the standard procedure answered: the same graph tools, with templated wording."
        : "No model is configured, so the standard procedure answered: the same graph tools, with templated wording.";
    const answer = await answerBrain({ visitorId: visitor, sandbox: sandbox.graph, agentId: "brain" }, parsed.data.question, {
      live,
      note,
      abortSignal: request.signal,
    });
    return Response.json(answer);
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}
