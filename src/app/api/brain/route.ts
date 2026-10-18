import { z } from "zod";
import { answerBrain } from "@/lib/agent/brain";
import { recordEpisode } from "@/lib/agent/catalog";
import { hasLiveModel } from "@/lib/agent/models";
import { recentTurns, rememberTurns } from "@/lib/graph/conversation";
import { ingest, extractMentions } from "@/lib/graph/intake";
import { ensureOrgLayer } from "@/lib/graph/org";
import { Tracer } from "@/lib/graph/trace";
import { ensureSandbox } from "@/lib/graph/tenancy";
import { brainDirectory } from "@/lib/graph/tools/brain";
import { loadNetwork } from "@/lib/network/data";
import { allow, allowToday, friendlyError, visitorId } from "@/lib/server/http";

export const maxDuration = 120;

/** Live brain answers a day across all visitors, alongside the control room's and rider desk's share of the free tiers. */
const LIVE_PER_DAY = 60;

const Body = z.union([
  z.object({ question: z.string().trim().min(2).max(400) }),
  z.object({ intake: z.object({ kind: z.enum(["message", "ticket", "note"]), text: z.string().trim().min(8).max(1200) }) }),
]);

/** The visitor's graph with the agency layer in it: teams, people and what they own, open tickets, decisions, and their conversation. */
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
 * { question }: answers one question about the agency with cited sources, and stores the question and answer
 * as Turn nodes, so the next question (today or in a later visit) has the conversation as context.
 * { intake }: adds a chat message, ticket or note to the brain, linked to what it names, filing work with its owner.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Send { question } (2 to 400 characters) or { intake: { kind, text } } (8 to 1,200 characters)." }, { status: 400 });
  }
  try {
    const visitor = await visitorId();
    const sandbox = await ensureSandbox(visitor);
    await ensureOrgLayer(sandbox.graph);
    const base = { visitorId: visitor, sandbox: sandbox.graph, agentId: "brain" };

    if ("intake" in parsed.data) {
      const ctx = { ...base, tracer: new Tracer() };
      const r = await ingest(ctx, parsed.data.intake);
      void recordEpisode(ctx, r);
      return Response.json(r.data);
    }

    const question = parsed.data.question;
    const live =
      hasLiveModel() &&
      (await allow(visitor, "brain", 20).catch(() => false)) &&
      (await allowToday("brain", LIVE_PER_DAY).catch(() => false));
    const note = live
      ? undefined
      : hasLiveModel()
        ? "The free model runs are used up for now, so the standard procedure answered: the same graph tools, with templated wording."
        : "No model is configured, so the standard procedure answered: the same graph tools, with templated wording.";
    const history = live ? await recentTurns(sandbox.graph, "brain", 8) : [];
    const answer = await answerBrain(base, question, { live, note, abortSignal: request.signal, history });

    const network = await loadNetwork();
    const m = extractMentions(
      question,
      network.stations.map((s) => ({ id: s.id, name: s.name, routes: s.routes })),
      network.routes.map((r) => r.id),
      [],
    );
    await rememberTurns(sandbox.graph, "brain", [
      { role: "user", text: question, stations: m.stations.map((s) => s.id), routes: m.routes },
      { role: "assistant", text: answer.answer, mode: answer.mode, cites: answer.sources.map((s) => s.id) },
    ]);
    return Response.json(answer);
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}
