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
