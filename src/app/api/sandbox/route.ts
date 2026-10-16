import { z } from "zod";
import { run } from "@/lib/graph/db";
import { Tracer } from "@/lib/graph/trace";
import { ensureSandbox, resetSandbox } from "@/lib/graph/tenancy";
import { openIncident } from "@/lib/graph/tools/incident";
import { listPlans, resolveIncident } from "@/lib/graph/tools/plan";
import { listRiders } from "@/lib/graph/tools/riders";
import { friendlyError, visitorId } from "@/lib/server/http";

export const maxDuration = 60;

/** The visitor's sandbox: open incident, plans, remembered riders with their latest advisory, memory. */
export async function GET() {
  try {
    const visitor = await visitorId();
    const sandbox = await ensureSandbox(visitor);
    const ctx = { visitorId: visitor, sandbox: sandbox.graph, agentId: "controller", tracer: new Tracer() };
    const [incident, riders, advisories, findings, episodes] = await Promise.all([
      openIncident(ctx),
      listRiders(ctx),
      run<{ rider: string; text: string; atMs: number; minutes: number; route: string[]; stepFree: boolean }>(
        sandbox.graph,
        `MATCH (a:Advisory)-[:FOR]->(r:Rider)
         RETURN r.id AS rider, a.text AS text, a.atMs AS atMs, a.minutes AS minutes, a.route AS route, a.stepFree AS stepFree
         ORDER BY atMs DESC`,
        {},
        { readOnly: true },
      ),
      run<{ id: string; text: string; kind: string; validFromMs: number; validToMs: number | null; example: boolean | null; about: string[]; agent: string | null; supersedes: string | null }>(
        sandbox.graph,
        `MATCH (f:Finding)
         OPTIONAL MATCH (f)-[:ABOUT]->(n)
         OPTIONAL MATCH (ag:Agent)-[:WROTE]->(f)
         OPTIONAL MATCH (f)-[:SUPERSEDES]->(old:Finding)
         RETURN f.id AS id, f.text AS text, f.kind AS kind, f.validFromMs AS validFromMs, f.validToMs AS validToMs,
                f.example AS example, collect(DISTINCT coalesce(n.name, n.id)) AS about, ag.name AS agent, old.id AS supersedes
         ORDER BY validFromMs DESC`,
        {},
        { readOnly: true },
      ),
      run<{ tool: string; outcome: string; summary: string; atMs: number; agent: string; queries: number; ms: number }>(
        sandbox.graph,
        `MATCH (ag:Agent)-[:ACTED]->(e:Episode)
         RETURN e.tool AS tool, e.outcome AS outcome, e.summary AS summary, e.atMs AS atMs, ag.id AS agent, e.queries AS queries, e.ms AS ms
         ORDER BY atMs DESC LIMIT 40`,
        {},
        { readOnly: true },
      ),
    ]);
    const plans = incident ? await listPlans(ctx, incident.id) : [];
    const latest = new Map<string, (typeof advisories.rows)[number]>();
    for (const a of advisories.rows) if (!latest.has(a.rider)) latest.set(a.rider, a);
    return Response.json({
      visitor: { sandbox: sandbox.graph, created: sandbox.created, copyMs: Math.round(sandbox.copyMs) },
      incident,
      plans,
      riders: riders.map((r) => ({ ...r, advisory: latest.get(r.id) ?? null })),
      findings: findings.rows,
      episodes: episodes.rows,
    });
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}

const Body = z.object({ action: z.enum(["reset", "resolve"]) });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { action: 'reset' | 'resolve' }." }, { status: 400 });
  try {
    const visitor = await visitorId();
    if (parsed.data.action === "reset") {
      await resetSandbox(visitor);
      return Response.json({ ok: true, message: "Your sandbox was copied fresh from the template." });
    }
    const sandbox = await ensureSandbox(visitor);
    const res = await resolveIncident({ visitorId: visitor, sandbox: sandbox.graph, agentId: "controller", tracer: new Tracer() });
    return Response.json({ ok: res.outcome === "answered", message: res.summary, trace: res.trace });
  } catch (error) {
    return Response.json({ error: friendlyError(error) }, { status: 503 });
  }
}
