import { loadNetwork, type Scenario } from "../network/data";
import { choosePlan } from "../graph/flow";
import { Tracer } from "../graph/trace";
import { affectedRiders, type ImpactData } from "../graph/tools/impact";
import { closeLine } from "../graph/tools/incident";
import { measureCapacity, shuttleCandidates, simulatePlan, type CapacityData, type Candidate, type PlanData } from "../graph/tools/capacity";
import { recall, remember, type RecallData } from "../graph/tools/memory";
import { resolvePlaces } from "../graph/tools/places";
import { proposeSteering } from "../graph/tools/plan";
import type { ToolContext, ToolResult } from "../graph/tools/types";
import { forClient, recordEpisode, type Emit } from "./catalog";

const fmt = (n: number) => (Math.round(n) || 0).toLocaleString("en-US");
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

/** What past shuttles on these routes actually carried, as a share of plan: the lowest ratio, with its source. */
function shuttleRatio(memory: RecallData | null): { ratio: number; note: string } | null {
  let worst: { ratio: number; note: string } | null = null;
  for (const inc of memory?.incidents ?? []) {
    for (const s of inc.shuttles) {
      if (!s.planned || !s.observed) continue;
      const ratio = s.observed / s.planned;
      if (!worst || ratio < worst.ratio) {
        worst = { ratio, note: `on ${day(inc.openedMs)} the ${s.from} ↔ ${s.to} shuttle carried ${Math.round(ratio * 100)}% of plan` };
      }
    }
  }
  return worst && worst.ratio < 0.97 ? worst : null;
}

/**
 * The controller's procedure without a model: the same tools on the visitor's own graph, with the decisions
 * written as code, each step saying which result made it the next one. Used when no model quota is left, and to
 * record replays; the interface labels these runs as scripted.
 *
 * When a live run loses its model halfway, `prior` holds what it already found, and the procedure carries on from
 * there instead of starting over: a step whose answer is already on screen is not run again.
 */
export async function scriptedControl(
  base: Omit<ToolContext, "tracer">,
  scenario: Scenario,
  emit: Emit,
  prior: ToolResult[] = [],
): Promise<{ brief: string; planId: string | null; steps: number }> {
  const agent = "controller";
  const network = await loadNetwork();
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  const name = (id: string) => names.get(id) ?? id;
  let seq = prior.length ? 100 : 0;
  let why = "";
  const say = (text: string) => {
    why = text;
    emit({ type: "text", agent, delta: `${text}\n\n` });
  };
  const done = (tool: string) => [...prior].reverse().find((r) => r.tool === tool);
  const step = async <T>(tool: string, input: unknown, fn: (ctx: ToolContext) => Promise<ToolResult<T>>): Promise<ToolResult<T>> => {
    const already = done(tool);
    if (already) return already as ToolResult<T>;
    const id = `${tool}-${++seq}`;
    emit({ type: "tool-call", agent, id, tool, input });
    const ctx: ToolContext = { ...base, tracer: new Tracer() };
    const r = await fn(ctx);
    emit({ type: "tool-result", agent, id, result: forClient(r) });
    void recordEpisode(ctx, r, { why, input, model: "standard procedure" });
    return r;
  };
  /** Says why the next step comes next, unless the live run already took it. */
  const next = (tool: string, text: string) => {
    if (!done(tool)) say(text);
  };

  const first = scenario.stations[0];
  const last = scenario.stations[scenario.stations.length - 1];
  const lines = scenario.routes.join("/");
  next("resolve_places", `Resolving ${name(first)}, ${name(last)} and the ${lines} against the graph, and reading what memory holds for these routes.`);
  const [, recalled] = await Promise.all([
    step("resolve_places", { names: [name(first), name(last), ...scenario.routes] }, (ctx) =>
      resolvePlaces(ctx, { names: [name(first), name(last), ...scenario.routes] }),
    ),
    step("recall_memory", { routes: scenario.routes, station_ids: [first, last] }, (ctx) => recall(ctx, { routes: scenario.routes, stations: [first, last] })),
  ]);
  const memory = recalled.outcome === "memory" ? recalled.data : null;

  next("close_line", `Closing the ${lines} between ${name(first)} and ${name(last)} in this sandbox graph${memory ? ", with memory for these routes in hand" : ""}.`);
  await step("close_line", { routes: scenario.routes, from_station_id: first, to_station_id: last }, (ctx) =>
    closeLine(ctx, { routes: scenario.routes, fromStation: first, toStation: last, report: scenario.report, title: scenario.title }),
  );

  next("affected_riders", "The closure is in place; counting whose trips cross it, by how many stops away they board.");
  const impact = await step("affected_riders", { depth: 4 }, (ctx) => affectedRiders(ctx, { depth: 4 }));
  const hit = (impact.data as ImpactData | null)?.totalRiders ?? 0;

  next("measure_capacity", `${fmt(hit)} riders an hour are displaced; measuring on a fork where they go on their own, and what max flow says the open network can carry.`);
  const capacity = await step("measure_capacity", {}, (ctx) => measureCapacity(ctx));
  const cap = capacity.data as CapacityData | null;
  const peak = cap?.directions.find((d) => d.direction === cap.peak) ?? cap?.directions[0];
  const worst = cap?.reroute.overloaded[0];
  const stranded = cap?.reroute.stranded ?? 0;
  const unmet = cap?.directions.reduce((s, d) => s + d.unmet, 0) ?? 0;

  type Choice = { planId: string; text: string };
  let choice: Choice | null = null;
  const steer = async (why: string): Promise<Choice | null> => {
    say(why);
    const r = await step("propose_steering", {}, (ctx) => proposeSteering(ctx));
    const plan = r.data.plan;
    return plan ? { planId: plan.id, text: `${plan.id}: no extra buses; the rider desk routes each remembered rider around the segments that overflow, onto lines with room.` } : null;
  };

  if (!stranded && !unmet) {
    choice = await steer("Everyone displaced still has an open path and max flow has no shortfall, so no buses: the plan is to steer riders.");
  } else {
    next(
      "shuttle_candidates",
      `${stranded ? `${fmt(stranded)} riders have no open path` : "Nobody is cut off"}${unmet ? ` and max flow falls ${fmt(unmet)} short` : ""}, so looking for shuttle bridges: stations the network cannot clear first, then relief for overloaded lines.`,
    );
    const cands = await step("shuttle_candidates", { max_km: 2 }, (ctx) => shuttleCandidates(ctx, { maxKm: 2 }));
    const list: Candidate[] = (cands.data as { candidates: Candidate[] } | null)?.candidates ?? [];
    const options = [list.find((c) => c.reason === "stranded"), list.find((c) => c.reason === "relief")].filter((c): c is Candidate => Boolean(c));

    // Memory changes the plan: if past shuttles here carried less than planned, add buses for that ratio.
    const past = shuttleRatio(memory);
    const size = (c: Candidate) => Math.min(60, Math.ceil(c.suggestedBusesPerHour / (past?.ratio ?? 1)));
    if (past && options.length) say(`From memory: ${past.note}, so each leg gets ${Math.round((1 / past.ratio - 1) * 100)}% more buses than the raw estimate.`);

    // Plans the live run already tested count too; the procedure tests one only if none exists yet.
    const plans: PlanData[] = prior.filter((r) => r.tool === "simulate_plan" && r.data).map((r) => r.data as PlanData);
    const simulate = async (legs: Candidate[], sized?: Map<string, number>) => {
      const shuttles = legs.map((c) => ({ from: c.fromId, to: c.toId, busesPerHour: sized?.get(`${c.fromId}>${c.toId}`) ?? size(c) }));
      const r = await step(
        "simulate_plan",
        { shuttles: shuttles.map((l) => ({ from_station_id: l.from, to_station_id: l.to, buses_per_hour: l.busesPerHour })) },
        (ctx) => simulatePlan(ctx, { shuttles }),
      );
      if (r.data) plans.push(r.data);
    };
    if (options.length && !plans.length) {
      say(
        `Testing ${options.length === 2 ? "two plans" : "a plan"} on forks of the closure graph: ${options
          .map((c) => `${name(c.fromId)} ↔ ${name(c.toId)} (${c.reason === "stranded" ? "where riders are stuck" : "relief for a crowded line"})`)
          .join(" and ")}.`,
      );
      await simulate(options.slice(0, 1));
      if (options.length === 2) await simulate(options);
    }

    // A leg too small for the riders its fastest paths put on it is tested once more at the size they need, with
    // memory's correction for what past shuttles really carried.
    const tooSmall = plans.filter((p) => p.shuttles.some((s) => s.peak && s.peak.load > s.capacity));
    for (const p of tooSmall.slice(0, 2)) {
      const legs = p.shuttles.map((s) => options.find((c) => c.fromId === s.from && c.toId === s.to)).filter((c): c is Candidate => Boolean(c));
      if (legs.length !== p.shuttles.length) continue;
      const sized = new Map(p.shuttles.map((s) => [`${s.from}>${s.to}`, Math.min(60, Math.max(s.busesPerHour, Math.ceil((s.peak?.busesPerHour ?? 0) / (past?.ratio ?? 1))))]));
      say(`${p.planId} is too small for the riders it carries, so testing it again with each leg sized to its busier direction.`);
      await simulate(legs, sized);
    }

    // The plan that clears the most stranded riders and max-flow shortfall per bus, among plans whose buses carry
    // their riders when any does (choosePlan, shared with the held-out policy eval).
    const best = choosePlan(plans);
    if (best) {
      choice = {
        planId: best.planId,
        text: `${best.planId}: ${best.shuttles.map((s) => `${name(s.from)} ↔ ${name(s.to)} at ${s.busesPerHour} buses an hour`).join(", ")} (${best.vehicles} buses). Riders with no path ${fmt(best.before.stranded)} → ${fmt(best.after.stranded)}; max-flow shortfall ${fmt(best.before.unmet)} → ${fmt(best.after.unmet)}.`,
      };
    } else {
      choice = await steer("No tested shuttle reduces the riders with no path or the shortfall, so the plan is to steer riders instead.");
    }
  }

  if (!done("remember")) say("Writing what this closure taught to memory, so the next plan starts from it.");
  if (worst) {
    await step("remember", { kind: "crowding" }, (ctx) =>
      remember(ctx, {
        text: `During ${scenario.title}, the ${worst.route} overloads first: ${name(worst.from)} to ${name(worst.to)} reached ${worst.pct}% of capacity at 8 a.m.`,
        kind: "crowding",
        stations: [worst.from, worst.to],
        routes: [worst.route, ...scenario.routes],
      }),
    );
  } else if (peak) {
    await step("remember", { kind: "capacity" }, (ctx) =>
      remember(ctx, {
        text: `During ${scenario.title}, the open network absorbed all ${fmt(cap?.displacedRiders ?? 0)} displaced riders an hour at 8 a.m. without overloading a segment; no buses were needed.`,
        kind: "capacity",
        stations: [first, last],
        routes: scenario.routes,
      }),
    );
  }

  const imp = impact.data as ImpactData | null;
  const d1 = imp?.byDepth.find((d) => d.depth === 1);
  const d4 = imp?.byDepth.find((d) => d.depth === 4);
  const cut = peak?.unmet ? peak.cut.slice(0, 3) : [];
  const past = shuttleRatio(memory);
  const facts = (memory?.findings ?? []).filter((f) => f.validToMs === null || f.validToMs === undefined).slice(0, 2).map((f) => `Since ${day(f.validFromMs)}: ${f.text}`);
  // The shuttle ratio only when no recalled fact already states it.
  const ratioStated = past !== null && facts.some((f) => f.includes(`${Math.round(past.ratio * 100)}%`));
  const remembered = [...facts, ...(past && !ratioStated ? [`${past.note[0].toUpperCase()}${past.note.slice(1)}.`] : [])];
  const overloads = cap?.reroute.overloaded.length ?? 0;

  const brief = [
    `**What broke** No ${lines} service between ${name(first)} and ${name(last)}.`,
    `**Who it hits** ${fmt(imp?.totalRiders ?? 0)} riders an hour; ${fmt(d1?.riders ?? 0)} board within one stop of the closure and ${fmt(d4?.riders ?? 0)} within four.`,
    `**What the network can take** ${
      worst
        ? `On their fastest paths riders overload ${overloads} segment${overloads === 1 ? "" : "s"}; worst ${worst.route} ${name(worst.from)} → ${name(worst.to)} at ${worst.pct}%.`
        : "On their fastest paths nothing new overflows."
    }${stranded ? ` ${fmt(stranded)} riders have no open path.` : ""}${
      peak ? ` Max flow moves ${fmt(peak.absorbed)} of ${fmt(peak.required)} in the peak direction${peak.unmet ? `; ${fmt(peak.unmet)} cannot move` : ""}.` : ""
    }${cut.length ? ` Min cut: ${cut.map((c) => `${c.kind === "WALK" ? "walk" : (c.route ?? c.kind)} ${name(c.from)} → ${name(c.to)}`).join(", ")}.` : ""}`,
    `**Recommended plan** ${choice?.text ?? "None recorded."}`,
    `**From memory** ${remembered.length ? remembered.join(" ") : "Nothing remembered for these routes yet; this run's finding is the first."}`,
  ].join("\n");
  say(brief);
  return { brief, planId: choice?.planId ?? null, steps: seq };
}
