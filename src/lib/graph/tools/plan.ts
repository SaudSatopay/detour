import { loadNetwork } from "../../network/data";
import { applyCrowding, openIncident, reopenAll, type Incident } from "./incident";
import { recall, shuttleShare } from "./memory";
import { result, type ToolContext, type ToolResult } from "./types";

export interface PlanLeg {
  from: string;
  to: string;
  busesPerHour: number;
  capacity: number;
  minutes: number;
  meters: number;
}

export interface PlanRecord {
  id: string;
  label: string;
  status: string;
  legs: PlanLeg[];
  vehicles: number;
  overflowBefore: number;
  overflowAfter: number;
  unmetBefore: number;
  unmetAfter: number;
  strandedBefore: number;
  strandedAfter: number;
  createdMs: number;
  publishedMs: number | null;
  incident: string;
}

export async function listPlans(ctx: ToolContext, incidentId?: string): Promise<PlanRecord[]> {
  const res = await ctx.tracer.run<Omit<PlanRecord, "legs"> & { legs: string }>(
    "plans for the incident",
    ctx.sandbox,
    `MATCH (p:Plan)-[:FOR]->(i:Incident)
     WHERE $incident = '' OR i.id = $incident
     RETURN p.id AS id, p.label AS label, p.status AS status, p.legs AS legs, p.vehicles AS vehicles,
            p.overflowBefore AS overflowBefore, p.overflowAfter AS overflowAfter, p.unmetBefore AS unmetBefore,
            p.unmetAfter AS unmetAfter, p.strandedBefore AS strandedBefore, p.strandedAfter AS strandedAfter,
            p.createdMs AS createdMs, p.publishedMs AS publishedMs, i.id AS incident
     ORDER BY createdMs DESC LIMIT 12`,
    { incident: incidentId ?? "" },
    { readOnly: true },
  );
  return res.rows.map((p) => ({ ...p, legs: JSON.parse(p.legs) as PlanLeg[] }));
}

/**
 * The human-approved step: the plan becomes graph state. Its shuttle legs are added to the
 * sandbox as BUS edges (so rider routing uses them), what still overflows with the plan running
 * (simulate_plan's reroute) becomes the rides' crowding cost, so the rider desk steers riders off
 * those segments, and the controller hands off to the rider desk. A steering plan keeps the
 * crowding measure_capacity set.
 */
export async function publishPlan(ctx: ToolContext, input: { planId: string; approvedBy: string }): Promise<ToolResult<{ plan: PlanRecord | null }>> {
  const incident = await openIncident(ctx);
  if (!incident) return result(ctx, "publish_plan", "not_in_graph", "No closure is open.", { plan: null });
  const plan = (await listPlans(ctx, incident.id)).find((p) => p.id === input.planId);
  if (!plan) return result(ctx, "publish_plan", "unknown_entity", `No plan ${input.planId} for ${incident.id}.`, { plan: null });

  await ctx.tracer.run("remove earlier shuttles", ctx.sandbox, "MATCH ()-[b:BUS]->() DELETE b");
  await ctx.tracer.run(
    "add the plan's shuttle legs",
    ctx.sandbox,
    `UNWIND $legs AS l
     MATCH (a:Station {id: l.from}), (b:Station {id: l.to})
     CREATE (a)-[:BUS {bid: l.bid, plan: $plan, capacity: l.capacity, spare: l.capacity, minutes: l.minutes, cost: l.minutes, busesPerHour: l.busesPerHour}]->(b),
            (b)-[:BUS {bid: l.bid, plan: $plan, capacity: l.capacity, spare: l.capacity, minutes: l.minutes, cost: l.minutes, busesPerHour: l.busesPerHour}]->(a)`,
    { plan: plan.id, legs: plan.legs.map((l, bid) => ({ bid, from: l.from, to: l.to, capacity: l.capacity, minutes: l.minutes, busesPerHour: l.busesPerHour })) },
  );
  const stored = await ctx.tracer.run<{ crowding: string | null }>(
    "what overflows with the plan running",
    ctx.sandbox,
    "MATCH (p:Plan {id: $plan}) RETURN p.crowding AS crowding",
    { plan: plan.id },
    { readOnly: true },
  );
  const crowding = parseCrowding(stored.rows[0]?.crowding ?? null);
  if (crowding) await applyCrowding(ctx, crowding);
  await ctx.tracer.run(
    "publish and hand off to the rider desk",
    ctx.sandbox,
    `MATCH (p:Plan {id: $plan}), (c:Agent {id: 'controller'}), (r:Agent {id: 'rider-desk'})
     SET p.status = 'published', p.publishedMs = timestamp(), p.approvedBy = $approvedBy
     CREATE (c)-[:HANDED_OFF {atMs: timestamp(), incident: $incident, plan: $plan,
       note: 'Plan published. Tell every remembered rider whose trip crosses the closure what to take instead.'}]->(r)`,
    { plan: plan.id, incident: incident.id, approvedBy: input.approvedBy },
  );
  return result(ctx, "publish_plan", "answered", `${plan.id} published: ${plan.label}. The rider desk has the handoff.`, {
    plan: { ...plan, status: "published", publishedMs: Date.now() },
  });
}

const fmt = (n: number) => (Math.round(n) || 0).toLocaleString("en-US");

/**
 * A plan with no buses, for closures the open network can absorb: the rider desk steers riders off
 * the segments the fastest paths overload (measure_capacity left them as a crowding cost) and onto
 * lines with room. Recorded and published like a shuttle plan, so the rider desk still gets the handoff.
 */
export async function proposeSteering(ctx: ToolContext): Promise<ToolResult<{ plan: PlanRecord | null }>> {
  const incident = await openIncident(ctx);
  if (!incident) return result(ctx, "propose_steering", "not_in_graph", "No closure is open. Close a line first.", { plan: null });
  const measured = await ctx.tracer.run<{ overflow: number | null; stranded: number | null; unmet: number | null }>(
    "the measured capacity picture",
    ctx.sandbox,
    "MATCH (i:Incident {id: $id}) RETURN i.overflow AS overflow, i.stranded AS stranded, i.unmet AS unmet",
    { id: incident.id },
    { readOnly: true },
  );
  const m = measured.rows[0];
  if (m?.overflow === null || m?.overflow === undefined) {
    return result(ctx, "propose_steering", "not_in_graph", "Measure capacity first: a steering plan rests on the capacity picture.", { plan: null });
  }
  const overflow = m.overflow ?? 0;
  const stranded = m.stranded ?? 0;
  const unmet = m.unmet ?? 0;
  const id = `PLAN-${Date.now().toString(36).toUpperCase()}`;
  const label = "No extra buses: steer riders onto open lines";
  await ctx.tracer.run(
    "record the plan",
    ctx.sandbox,
    `MATCH (i:Incident {id: $incident}), (ag:Agent {id: $agent})
     CREATE (ag)-[:PROPOSED {atMs: timestamp()}]->(p:Plan {id: $id, label: $label, status: 'simulated', legs: '[]',
       vehicles: 0, overflowBefore: $o, overflowAfter: $o, unmetBefore: $u, unmetAfter: $u,
       strandedBefore: $s, strandedAfter: $s, createdMs: timestamp()})-[:FOR]->(i)`,
    { incident: incident.id, agent: ctx.agentId, id, label, o: overflow, u: unmet, s: stranded },
  );
  const why =
    !overflow && !stranded
      ? "Every displaced rider has an open path and nothing overflows on the fastest paths"
      : !unmet
        ? `Fastest paths overflow by ${fmt(overflow)} riders an hour, but max flow carries every displaced rider if they are spread onto other lines`
        : `This leaves ${fmt(unmet)} riders an hour the network cannot carry and ${fmt(stranded)} with no open path; a shuttle would do better`;
  const plan: PlanRecord = {
    id,
    label,
    status: "simulated",
    legs: [],
    vehicles: 0,
    overflowBefore: overflow,
    overflowAfter: overflow,
    unmetBefore: unmet,
    unmetAfter: unmet,
    strandedBefore: stranded,
    strandedAfter: stranded,
    createdMs: Date.now(),
    publishedMs: null,
    incident: incident.id,
  };
  return result(ctx, "propose_steering", "answered", `${id}: no extra buses. ${why}. Once published, the rider desk routes each remembered rider.`, { plan });
}

export async function writeAdvisory(
  ctx: ToolContext,
  input: { riderId: string; text: string; minutes: number | null; stations: string[]; stepFree: boolean },
): Promise<void> {
  await ctx.tracer.run(
    "write advisory",
    ctx.sandbox,
    `MATCH (r:Rider {id: $rider}), (ag:Agent {id: 'rider-desk'})
     OPTIONAL MATCH (i:Incident {status: 'open'})
     CREATE (ag)-[:WROTE]->(a:Advisory {text: $text, minutes: $minutes, route: $stations, stepFree: $stepFree, atMs: timestamp()})-[:FOR]->(r)
     FOREACH (_ IN CASE WHEN i IS NULL THEN [] ELSE [1] END | CREATE (a)-[:ABOUT]->(i))`,
    { rider: input.riderId, text: input.text, minutes: input.minutes ?? -1, stations: input.stations, stepFree: input.stepFree },
  );
}

/** The crowding a plan stored when it was simulated; null for plans without it (steering, older plans). */
export function parseCrowding(json: string | null): { eid: number; pct: number }[] | null {
  if (!json) return null;
  try {
    const rows = JSON.parse(json) as unknown;
    if (!Array.isArray(rows)) return null;
    return rows.filter((r): r is { eid: number; pct: number } => Number.isFinite(r?.eid) && Number.isFinite(r?.pct));
  } catch {
    return null;
  }
}

/** What the dispatcher says one shuttle leg carried, in riders an hour. */
export interface ObservedLeg {
  from: string;
  to: string;
  riders: number;
}

export interface LearnedShuttle {
  from: string;
  to: string;
  busesPerHour: number;
  planned: number;
  observed: number;
  ratio: number;
}

/**
 * Pairs what each shuttle carried with the published plan's legs (a leg runs both ways, so either order
 * matches). Legs nobody reported, and counts that are not a positive number of riders, are left out.
 */
export function learnedShuttles(legs: PlanLeg[], observed: ObservedLeg[]): LearnedShuttle[] {
  const out: LearnedShuttle[] = [];
  for (const leg of legs) {
    const o = observed.find((x) => (x.from === leg.from && x.to === leg.to) || (x.from === leg.to && x.to === leg.from));
    if (!o || !Number.isFinite(o.riders) || o.riders <= 0 || !(leg.capacity > 0)) continue;
    const riders = Math.round(o.riders);
    out.push({ from: leg.from, to: leg.to, busesPerHour: leg.busesPerHour, planned: leg.capacity, observed: riders, ratio: riders / leg.capacity });
  }
  return out;
}

/**
 * The playbooks an incident applied: written for one of its routes and, when a playbook names the
 * stretch it is for, overlapping the closed stretch. The Canarsie Tube playbook is not applied when the
 * L closes in Canarsie.
 */
export function appliedPlaybooks<T extends { routes: string[]; stations: string[] | null }>(playbooks: T[], incident: Pick<Incident, "routes" | "stretch">): T[] {
  const routes = new Set(incident.routes);
  const stretch = new Set(incident.stretch);
  return playbooks.filter((p) => p.routes.some((r) => routes.has(r)) && (!p.stations?.length || p.stations.some((s) => stretch.has(s))));
}

/** A playbook's steps with its bus-sizing step replaced by what was learned (added when it has none). */
export function reviseSteps(steps: string[], lesson: string): string[] {
  const i = steps.findIndex((s) => /\b(bus|buses|shuttle|bridge)\b/i.test(s));
  return i < 0 ? [...steps, lesson] : steps.map((s, j) => (j === i ? lesson : s));
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

/**
 * The bus-sizing step a playbook keeps: what this incident's shuttle that fell furthest short carried,
 * and the share of plan the next plan sizes buses at (the lowest on record for these lines, which may
 * come from an earlier incident), so the playbook and the controller say the same thing.
 */
export function sizingLesson(
  learned: LearnedShuttle[],
  names: (id: string) => string,
  incident: string,
  atMs: number,
  next: { ratio: number; incident: string } | null,
): string | null {
  const worst = learned.slice().sort((a, b) => a.ratio - b.ratio)[0];
  if (!worst) return null;
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  const carried = `on ${day(atMs)} (${incident}) the ${names(worst.from)} ↔ ${names(worst.to)} shuttle carried ${worst.observed.toLocaleString("en-US")} of ${worst.planned.toLocaleString("en-US")} planned riders an hour, ${pct(worst.ratio)} of plan`;
  if (!next) return `Bridge with buses at nominal capacity: ${carried}.`;
  if (next.incident === incident) return `Bridge with buses sized at ${pct(next.ratio)} of nominal capacity: ${carried}.`;
  return `Bridge with buses sized at ${pct(next.ratio)} of nominal capacity, the lowest share on record for these lines (${next.incident}); ${carried}.`;
}

export interface ResolveData {
  incident: string | null;
  /** Shuttle legs recorded with what they carried. */
  learned: LearnedShuttle[];
  /** Playbooks revised (or written) from what was learned. */
  playbooks: { id: string; title: string; revision: number; steps: string[]; created: boolean }[];
  /** Playbooks this incident applied; their use count went up. */
  applied: string[];
  /** The share of plan the next shuttle plan on these routes sizes buses at, and which shuttle set it. */
  next: { ratio: number; incident: string; from: string; to: string } | null;
}

/**
 * Ends the incident: shuttles are withdrawn, segments reopen and the crowding cost is cleared. With what
 * each published shuttle actually carried (the dispatcher's count), procedural memory learns: Shuttle
 * nodes like the seeded history are linked to the incident, so the next plan on these routes sizes its
 * buses from them, and each playbook the incident applied gets a new revision that supersedes the old
 * steps (kept as a PlaybookRevision). A route with no playbook gets one.
 */
export async function resolveIncident(ctx: ToolContext, input: { observed?: ObservedLeg[] } = {}): Promise<ToolResult<ResolveData>> {
  const none: ResolveData = { incident: null, learned: [], playbooks: [], applied: [], next: null };
  const incident = await openIncident(ctx);
  if (!incident) return result(ctx, "resolve_incident", "not_in_graph", "No closure is open.", none);
  const published = await ctx.tracer.run<{ id: string; legs: string }>(
    "the published plan",
    ctx.sandbox,
    `MATCH (p:Plan {status: 'published'})-[:FOR]->(:Incident {id: $incident})
     RETURN p.id AS id, p.legs AS legs, p.publishedMs AS publishedMs
     ORDER BY publishedMs DESC LIMIT 1`,
    { incident: incident.id },
    { readOnly: true },
  );
  const plan = published.rows[0] ?? null;
  await ctx.tracer.run("remove shuttles", ctx.sandbox, "MATCH ()-[b:BUS]->() DELETE b");
  const reopened = await reopenAll(ctx, "resolved");

  const network = await loadNetwork();
  const stationNames = new Map(network.stations.map((s) => [s.id, s.name]));
  const name = (id: string) => stationNames.get(id) ?? id;
  const learned = plan ? learnedShuttles(JSON.parse(plan.legs) as PlanLeg[], input.observed ?? []) : [];
  if (learned.length) {
    await ctx.tracer.run(
      "remember what each shuttle carried",
      ctx.sandbox,
      `MATCH (i:Incident {id: $incident})
       UNWIND $shuttles AS sh
       MATCH (a:Station {id: sh.from}), (b:Station {id: sh.to})
       CREATE (s:Shuttle {busesPerHour: sh.busesPerHour, planned: sh.planned, observed: sh.observed, plan: $plan, learnedMs: timestamp()})-[:FOR]->(i),
              (s)-[:FROM]->(a), (s)-[:TO]->(b)`,
      { incident: incident.id, plan: plan!.id, shuttles: learned.map((l) => ({ from: l.from, to: l.to, busesPerHour: l.busesPerHour, planned: l.planned, observed: l.observed })) },
    );
  }

  const found = await ctx.tracer.run<{ id: string; title: string; steps: string[]; stations: string[] | null; revision: number; routes: string[] }>(
    "playbooks for these routes",
    ctx.sandbox,
    `MATCH (p:Playbook)-[:FOR]->(r:Route) WHERE r.id IN $routes
     WITH p, collect(r.id) AS routes
     RETURN p.id AS id, p.title AS title, p.steps AS steps, p.stations AS stations, coalesce(p.revision, 1) AS revision, routes`,
    { routes: incident.routes },
    { readOnly: true },
  );
  // A playbook is applied only when a plan was published: closing a line and reopening it applies nothing.
  const applied = plan ? appliedPlaybooks(found.rows, incident) : [];
  if (applied.length) {
    await ctx.tracer.run(
      "count the playbooks this incident applied",
      ctx.sandbox,
      `MATCH (p:Playbook), (i:Incident {id: $incident}) WHERE p.id IN $ids
       SET p.uses = p.uses + 1, p.lastUsedMs = timestamp()
       CREATE (p)-[:APPLIED {atMs: timestamp()}]->(i)`,
      { ids: applied.map((p) => p.id), incident: incident.id },
    );
  }

  // What the next plan on these routes will size buses at, read back the way the controller reads it
  // (recall hands back every query this context ran, so the earlier ones are put back first).
  const traces = ctx.tracer.traces.splice(0);
  const memory = await recall(ctx, { routes: incident.routes });
  ctx.tracer.traces.push(...traces, ...memory.trace);
  const share = shuttleShare(memory.data.incidents);
  const next = share ? { ratio: share.ratio, incident: share.incident, from: share.from, to: share.to } : null;

  const playbooks: ResolveData["playbooks"] = [];
  const lesson = sizingLesson(learned, name, incident.id, Date.now(), next);
  if (lesson) {
    for (const p of applied) {
      const steps = reviseSteps(p.steps, lesson);
      await ctx.tracer.run(
        "revise the playbook; the old steps are superseded, not deleted",
        ctx.sandbox,
        `MATCH (p:Playbook {id: $id}), (i:Incident {id: $incident})
         CREATE (p)-[:SUPERSEDES {atMs: timestamp(), incident: i.id}]->(:PlaybookRevision {playbook: p.id, revision: coalesce(p.revision, 1),
           title: p.title, steps: p.steps, supersededMs: timestamp()})
         SET p.steps = $steps, p.revision = coalesce(p.revision, 1) + 1, p.revisedMs = timestamp()
         CREATE (p)-[:LEARNED_FROM]->(i)`,
        { id: p.id, incident: incident.id, steps },
      );
      playbooks.push({ id: p.id, title: p.title, revision: p.revision + 1, steps, created: false });
    }
    if (!applied.length) {
      const id = `PB-${incident.id.replace(/^INC-/, "")}`;
      const lines = incident.routes.join("/");
      const steps = [
        `Close the ${lines} between ${name(incident.stretch[0])} and ${name(incident.stretch[incident.stretch.length - 1])}.`,
        "Measure what the open lines can absorb, and where max flow falls short.",
        lesson,
        "Steer riders off segments the reroute pushes over capacity.",
      ];
      await ctx.tracer.run(
        "write a playbook for these routes",
        ctx.sandbox,
        `MATCH (i:Incident {id: $incident})
         CREATE (p:Playbook {id: $id, title: $title, steps: $steps, stations: $stations, uses: 1, lastUsedMs: timestamp(), revision: 1})-[:LEARNED_FROM]->(i)
         WITH p
         MATCH (r:Route) WHERE r.id IN $routes
         CREATE (p)-[:FOR]->(r)`,
        { incident: incident.id, id, title: incident.title, steps, stations: incident.stretch, routes: incident.routes },
      );
      playbooks.push({ id, title: incident.title, revision: 1, steps, created: true });
    }
  }

  const said = [
    `${incident.id} resolved; ${reopened} segments reopened${plan ? " and shuttles withdrawn" : ""}.`,
    ...learned.map((l) => `The ${name(l.from)} ↔ ${name(l.to)} shuttle carried ${l.observed.toLocaleString("en-US")} of ${l.planned.toLocaleString("en-US")} planned riders an hour (${Math.round(l.ratio * 100)}%).`),
    ...playbooks.map((p) => (p.created ? `New playbook ${p.id} for the ${incident.routes.join("/")}.` : `${p.id} is now revision ${p.revision}.`)),
    next ? `The next shuttle plan on the ${incident.routes.join("/")} sizes buses at ${Math.round(next.ratio * 100)}% of plan (${next.incident}).` : "",
  ];
  return result(ctx, "resolve_incident", "answered", said.filter(Boolean).join(" "), { incident: incident.id, learned, playbooks, applied: applied.map((p) => p.id), next });
}
