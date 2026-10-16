import { run } from "./db";
import { ensureSandbox } from "./tenancy";
import { Tracer } from "./trace";
import { openIncident } from "./tools/incident";
import { listPlans, type PlanRecord } from "./tools/plan";
import { listRiders, type RiderProfile } from "./tools/riders";

export interface AdvisoryRow {
  rider: string;
  text: string;
  atMs: number;
  minutes: number | null;
  route: string[];
  stepFree: boolean;
}

export interface FindingRow {
  id: string;
  text: string;
  kind: string;
  validFromMs: number;
  validToMs: number | null;
  example: boolean | null;
  about: string[];
  agent: string | null;
  supersedes: string | null;
}

export interface EpisodeRow {
  tool: string;
  outcome: string;
  summary: string;
  atMs: number;
  agent: string;
  queries: number;
  ms: number;
}

export interface SandboxState {
  visitor: { sandbox: string; created: boolean; copyMs: number };
  incident: Awaited<ReturnType<typeof openIncident>>;
  plans: PlanRecord[];
  riders: (RiderProfile & { advisory: AdvisoryRow | null })[];
  findings: FindingRow[];
  episodes: EpisodeRow[];
  handoffs: { from: string; to: string; note: string; atMs: number }[];
  playbooks: { id: string; title: string; steps: string[]; uses: number; lastUsedMs: number; routes: string[] }[];
  pastIncidents: { id: string; title: string; openedMs: number; status: string; example: boolean | null; shuttles: { from: string; to: string; planned: number; observed: number }[] }[];
  /** Set when this state was recorded earlier and served because the database is unreachable. */
  recorded?: string;
}

/** Everything the control room, riders and memory pages read from a visitor's sandbox graph. */
export async function sandboxState(visitor: string): Promise<SandboxState> {
  const sandbox = await ensureSandbox(visitor);
  const ctx = { visitorId: visitor, sandbox: sandbox.graph, agentId: "controller", tracer: new Tracer() };
  const [incident, riders, advisories, findings, episodes, handoffs, playbooks, pastIncidents] = await Promise.all([
    openIncident(ctx),
    listRiders(ctx),
    run<AdvisoryRow>(
      sandbox.graph,
      `MATCH (a:Advisory)-[:FOR]->(r:Rider)
       RETURN r.id AS rider, a.text AS text, a.atMs AS atMs, a.minutes AS minutes, a.route AS route, a.stepFree AS stepFree
       ORDER BY atMs DESC`,
      {},
      { readOnly: true },
    ),
    run<FindingRow>(
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
    run<EpisodeRow>(
      sandbox.graph,
      `MATCH (ag:Agent)-[:ACTED]->(e:Episode)
       RETURN e.tool AS tool, e.outcome AS outcome, e.summary AS summary, e.atMs AS atMs, ag.id AS agent, e.queries AS queries, e.ms AS ms
       ORDER BY atMs DESC LIMIT 40`,
      {},
      { readOnly: true },
    ),
    run<{ from: string; to: string; note: string; atMs: number }>(
      sandbox.graph,
      `MATCH (a:Agent)-[h:HANDED_OFF]->(b:Agent)
       RETURN a.id AS from, b.id AS to, h.note AS note, h.atMs AS atMs
       ORDER BY atMs DESC LIMIT 12`,
      {},
      { readOnly: true },
    ),
    run<SandboxState["playbooks"][number]>(
      sandbox.graph,
      `MATCH (p:Playbook)-[:FOR]->(r:Route)
       RETURN p.id AS id, p.title AS title, p.steps AS steps, p.uses AS uses, p.lastUsedMs AS lastUsedMs, collect(r.id) AS routes`,
      {},
      { readOnly: true },
    ),
    run<SandboxState["pastIncidents"][number]>(
      sandbox.graph,
      `MATCH (i:Incident) WHERE i.status <> 'open'
       OPTIONAL MATCH (sh:Shuttle)-[:FOR]->(i)
       OPTIONAL MATCH (sh)-[:FROM]->(a:Station)
       OPTIONAL MATCH (sh)-[:TO]->(b:Station)
       WITH i, collect(CASE WHEN sh IS NULL THEN null ELSE {from: a.name, to: b.name, planned: sh.planned, observed: sh.observed} END) AS shuttles
       RETURN i.id AS id, i.title AS title, i.openedMs AS openedMs, i.status AS status, i.example AS example, shuttles
       ORDER BY openedMs DESC LIMIT 12`,
      {},
      { readOnly: true },
    ),
  ]);
  const plans = incident ? await listPlans(ctx, incident.id) : [];
  const latest = new Map<string, AdvisoryRow>();
  for (const a of advisories.rows) if (!latest.has(a.rider)) latest.set(a.rider, a);
  return {
    visitor: { sandbox: sandbox.graph, created: sandbox.created, copyMs: Math.round(sandbox.copyMs) },
    incident,
    plans,
    riders: riders.map((r) => ({ ...r, advisory: latest.get(r.id) ?? null })),
    findings: findings.rows,
    episodes: episodes.rows,
    handoffs: handoffs.rows,
    playbooks: playbooks.rows,
    pastIncidents: pastIncidents.rows.map((i) => ({ ...i, shuttles: (i.shuttles ?? []).filter(Boolean) })),
  };
}
