import { openIncident, reopenAll } from "./incident";
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
 * sandbox as BUS edges (so rider routing uses them) and the controller hands off to the rider desk.
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
     CREATE (a)-[:BUS {bid: l.bid, plan: $plan, capacity: l.capacity, spare: l.capacity, minutes: l.minutes, busesPerHour: l.busesPerHour}]->(b),
            (b)-[:BUS {bid: l.bid, plan: $plan, capacity: l.capacity, spare: l.capacity, minutes: l.minutes, busesPerHour: l.busesPerHour}]->(a)`,
    { plan: plan.id, legs: plan.legs.map((l, bid) => ({ bid, from: l.from, to: l.to, capacity: l.capacity, minutes: l.minutes, busesPerHour: l.busesPerHour })) },
  );
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
 * A plan with no buses, for closures the open network can absorb: riders are steered onto the lines
 * max flow uses. Recorded and published like a shuttle plan, so the rider desk still gets the handoff.
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

/** Ends the incident: segments reopen, shuttles are removed, and what was observed is remembered. */
export async function resolveIncident(ctx: ToolContext): Promise<ToolResult<{ incident: string | null }>> {
  const incident = await openIncident(ctx);
  if (!incident) return result(ctx, "resolve_incident", "not_in_graph", "No closure is open.", { incident: null });
  await ctx.tracer.run("remove shuttles", ctx.sandbox, "MATCH ()-[b:BUS]->() DELETE b");
  const reopened = await reopenAll(ctx, "resolved");
  await ctx.tracer.run(
    "update playbook use",
    ctx.sandbox,
    `MATCH (p:Playbook)-[:FOR]->(r:Route) WHERE r.id IN $routes
     SET p.uses = p.uses + 1, p.lastUsedMs = timestamp()`,
    { routes: incident.routes },
  );
  return result(ctx, "resolve_incident", "answered", `${incident.id} resolved; ${reopened} segments reopened and shuttles withdrawn.`, { incident: incident.id });
}
