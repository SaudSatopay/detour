import { z } from "zod";
import { answerBrain, resolveFollowUp } from "@/lib/agent/brain";
import { recordEpisode } from "@/lib/agent/catalog";
import { hasLiveModel, liveModelAvailable } from "@/lib/agent/models";
import type { AgencyRefreshReply, AgencySummary } from "@/lib/brain/types";
import { agencyStatus, ensureAgency, refreshAgency } from "@/lib/graph/agency";
import { latestOutages } from "@/lib/graph/agency-tools";
import { lastExchange, recentTurns, rememberTurns } from "@/lib/graph/conversation";
import { ingest, extractMentions } from "@/lib/graph/intake";
import { ensureOrgLayer } from "@/lib/graph/org";
import { Tracer } from "@/lib/graph/trace";
import { ensureSandbox, holdFor, release } from "@/lib/graph/tenancy";
import { recordedAnswer, recordedDirectory } from "@/lib/brain/recorded";
import { brainDirectory } from "@/lib/graph/tools/brain";
import { loadNetwork } from "@/lib/network/data";
import { allow, allowToday, friendlyError, visitorId, wantsNoModel } from "@/lib/server/http";

export const maxDuration = 120;

/** Live brain answers a day across all visitors, alongside the control room's and rider desk's share of the free tiers. */
const LIVE_PER_DAY = 150;
/** Refreshes of the shared MTA records: per visitor an hour, and across everyone a day. */
const REFRESH_PER_HOUR = 4;
const REFRESH_PER_DAY = 200;

const Body = z.union([
  z.object({ question: z.string().trim().min(2).max(400) }),
  z.object({ intake: z.object({ kind: z.enum(["message", "ticket", "note"]), text: z.string().trim().min(8).max(1200) }) }),
  z.object({ refresh: z.literal(true) }),
]);

/** The shared agency graph's summary: as of when, what it holds, a few current outages. Null when it cannot be read. */
async function agencySummary(visitor: string, sandbox: string): Promise<AgencySummary | null> {
  try {
    await ensureAgency();
    const status = await agencyStatus();
    const outages = await latestOutages({ visitorId: visitor, sandbox, agentId: "brain", tracer: new Tracer() }, 5);
    return { ...status, outages };
  } catch {
    return null;
  }
}

/** The visitor's graph with the agency layer in it, and the shared graph of real MTA records beside it. */
export async function GET() {
  try {
    const visitor = await visitorId();
    const sandbox = await ensureSandbox(visitor);
    await ensureOrgLayer(sandbox.graph);
    const [directory, agency] = await Promise.all([
      brainDirectory({ visitorId: visitor, sandbox: sandbox.graph, agentId: "brain", tracer: new Tracer() }),
      agencySummary(visitor, sandbox.graph),
    ]);
    return Response.json({ ...directory, agency });
  } catch (error) {
    // The database is unreachable: the directory as recorded on the deployment, labeled, rather than nothing.
    const recorded = await recordedDirectory();
    if (recorded) return Response.json(recorded);
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}

/**
 * { question }: answers one question with cited sources, and stores the question and answer as Turn nodes, so the
 * next question (today or in a later visit) has the conversation as context; a follow-up ("when will it be back?")
 * is read with what the previous answer cited.
 * { intake }: adds a chat message, ticket or note to the brain, linked to what it names, filing work with its owner.
 * { refresh: true }: reads the MTA's live feeds into the shared agency graph now (rate limited).
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Send { question } (2 to 400 characters), { intake: { kind, text } } (8 to 1,200 characters) or { refresh: true }." },
      { status: 400 },
    );
  }
  let held: string | null = null;
  try {
    const visitor = await visitorId();
    // Held for the request, so another visitor making room never deletes this graph mid-answer.
    held = visitor;
    await holdFor(visitor);

    if ("refresh" in parsed.data) {
      const allowed = (await allow(visitor, "agency-refresh", REFRESH_PER_HOUR).catch(() => false)) && (await allowToday("agency-refresh", REFRESH_PER_DAY).catch(() => false));
      if (!allowed) {
        return Response.json({ error: "The MTA's records were refreshed several times in the last hour. They refresh on their own every day; try again later." }, { status: 429 });
      }
      const r = await refreshAgency("live");
      const sandbox = await ensureSandbox(visitor);
      const reply: AgencyRefreshReply = { ...r, agency: await agencySummary(visitor, sandbox.graph) };
      return Response.json(reply, { status: r.ok ? 200 : 502 });
    }

    const sandbox = await ensureSandbox(visitor);
    await ensureOrgLayer(sandbox.graph);
    await ensureAgency().catch(() => undefined);
    const base = { visitorId: visitor, sandbox: sandbox.graph, agentId: "brain" };

    if ("intake" in parsed.data) {
      const ctx = { ...base, tracer: new Tracer() };
      const r = await ingest(ctx, parsed.data.intake);
      void recordEpisode(ctx, r);
      return Response.json(r.data);
    }

    const question = parsed.data.question;
    const network = await loadNetwork();
    const names = new Map(network.stations.map((s) => [s.id, s.name]));
    // A follow-up is read with what the previous answer cited and the stations the previous question named.
    const prev = await lastExchange(sandbox.graph, "brain");
    const own = extractMentions(
      question,
      network.stations.map((s) => ({ id: s.id, name: s.name, routes: s.routes })),
      network.routes.map((r) => r.id),
      [],
    );
    const follow = resolveFollowUp(
      question,
      prev ? { cites: prev.cites, stations: prev.stations.map((id) => ({ id, name: names.get(id) ?? id })) } : null,
      own.stations.length > 0 || own.routes.length > 0,
    );
    const asked = follow?.question ?? question;

    const noModel = wantsNoModel(request);
    const live =
      !noModel &&
      (await liveModelAvailable()) &&
      (await allow(visitor, "brain", 20).catch(() => false)) &&
      (await allowToday("brain", LIVE_PER_DAY).catch(() => false));
    const note = live
      ? undefined
      : noModel
        ? "This request asked for no model, so the standard procedure answered: the same graph tools, with templated wording."
        : hasLiveModel()
          ? "The free model runs are used up for now, so the standard procedure answered: the same graph tools, with templated wording."
          : "No model is configured, so the standard procedure answered: the same graph tools, with templated wording.";
    const history = live ? await recentTurns(sandbox.graph, "brain", 8) : [];
    const answer = await answerBrain(base, asked, { live, note, abortSignal: request.signal, history });
    answer.question = question;
    answer.followUp = follow ? { entity: follow.entity, label: follow.label } : null;

    const m = follow
      ? extractMentions(
          asked,
          network.stations.map((s) => ({ id: s.id, name: s.name, routes: s.routes })),
          network.routes.map((r) => r.id),
          [],
        )
      : own;
    await rememberTurns(sandbox.graph, "brain", [
      { role: "user", text: question, stations: m.stations.map((s) => s.id), routes: m.routes },
      { role: "assistant", text: answer.answer, mode: answer.mode, cites: answer.sources.map((s) => s.id) },
    ]);
    return Response.json(answer);
  } catch (error) {
    // The database is unreachable: a question with a recorded answer gets it, labeled with when it was recorded.
    const recorded = "question" in parsed.data ? await recordedAnswer(parsed.data.question) : null;
    if (recorded) return Response.json(recorded);
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  } finally {
    if (held) await release(held);
  }
}
