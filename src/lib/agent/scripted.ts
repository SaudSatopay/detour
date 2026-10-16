import { loadNetwork, type Scenario } from "../network/data";
import { Tracer } from "../graph/trace";
import { affectedRiders, type ImpactData } from "../graph/tools/impact";
import { closeLine } from "../graph/tools/incident";
import { measureCapacity, shuttleCandidates, simulatePlan, type CapacityData, type Candidate, type PlanData } from "../graph/tools/capacity";
import { recall, remember, type RecallData } from "../graph/tools/memory";
import { resolvePlaces } from "../graph/tools/places";
import { proposeSteering } from "../graph/tools/plan";
import type { ToolContext, ToolResult } from "../graph/tools/types";
import { recordEpisode, type Emit } from "./catalog";

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
 * The controller's procedure without a model: the same tools, in the order its instructions give
 * them, on the visitor's own graph, with the same decisions written as code. Used when no model
 * quota is left, and to record replays. The interface labels these runs as scripted.
 */
export async function scriptedControl(
  base: Omit<ToolContext, "tracer">,
  scenario: Scenario,
  emit: Emit,
): Promise<{ brief: string; planId: string | null; steps: number }> {
  const agent = "controller";
  const network = await loadNetwork();
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  const name = (id: string) => names.get(id) ?? id;
  let seq = 0;
  const say = (text: string) => emit({ type: "text", agent, delta: `${text}\n\n` });
  const step = async <T>(tool: string, input: unknown, fn: (ctx: ToolContext) => Promise<ToolResult<T>>): Promise<ToolResult<T>> => {
    const id = `${tool}-${++seq}`;
    emit({ type: "tool-call", agent, id, tool, input });
    const ctx: ToolContext = { ...base, tracer: new Tracer() };
    const r = await fn(ctx);
    emit({ type: "tool-result", agent, id, result: r });
    void recordEpisode(ctx, r);
    return r;
  };

  const first = scenario.stations[0];
  const last = scenario.stations[scenario.stations.length - 1];
  const lines = scenario.routes.join("/");
  say(`Resolving ${name(first)}, ${name(last)} and the ${lines} against the graph, and reading what memory holds for these routes.`);
  const [, recalled] = await Promise.all([
    step("resolve_places", { names: [name(first), name(last), ...scenario.routes] }, (ctx) =>
      resolvePlaces(ctx, { names: [name(first), name(last), ...scenario.routes] }),
    ),
    step("recall_memory", { routes: scenario.routes, station_ids: [first, last] }, (ctx) => recall(ctx, { routes: scenario.routes, stations: [first, last] })),
  ]);
  const memory = recalled.outcome === "memory" ? recalled.data : null;

  say(`Closing the ${lines} between ${name(first)} and ${name(last)} in this sandbox graph.`);
  await step("close_line", { routes: scenario.routes, from_station_id: first, to_station_id: last }, (ctx) =>
    closeLine(ctx, { routes: scenario.routes, fromStation: first, toStation: last, report: scenario.report, title: scenario.title }),
  );

  say("Counting whose trips cross the closure, by how many stops away they board.");
  const impact = await step("affected_riders", { depth: 4 }, (ctx) => affectedRiders(ctx, { depth: 4 }));

  say("Measuring the network on a fork: where riders go on their own, and what max flow says is possible.");
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
    return plan ? { planId: plan.id, text: `${plan.id}: no extra buses; the rider desk steers each remembered rider onto open lines.` } : null;
  };

  if (!stranded && !unmet) {
    choice = await steer("Everyone displaced still has an open path and max flow has no shortfall, so no buses: the plan is to steer riders.");
  } else {
    say("Looking for shuttle bridges: stations the network cannot clear first, then relief for overloaded lines.");
    const cands = await step("shuttle_candidates", { max_km: 2 }, (ctx) => shuttleCandidates(ctx, { maxKm: 2 }));
    const list: Candidate[] = (cands.data as { candidates: Candidate[] } | null)?.candidates ?? [];
    const options = [list.find((c) => c.reason === "stranded"), list.find((c) => c.reason === "relief")].filter((c): c is Candidate => Boolean(c));

    // Memory changes the plan: if past shuttles here carried less than planned, add buses for that ratio.
    const past = shuttleRatio(memory);
    const size = (c: Candidate) => Math.min(60, Math.ceil(c.suggestedBusesPerHour / (past?.ratio ?? 1)));
    if (past && options.length) say(`From memory: ${past.note}, so each leg gets ${Math.round((1 / past.ratio - 1) * 100)}% more buses than the raw estimate.`);

    const plans: PlanData[] = [];
    const simulate = async (legs: Candidate[]) => {
      const shuttles = legs.map((c) => ({ from: c.fromId, to: c.toId, busesPerHour: size(c) }));
      const r = await step(
        "simulate_plan",
        { shuttles: shuttles.map((l) => ({ from_station_id: l.from, to_station_id: l.to, buses_per_hour: l.busesPerHour })) },
        (ctx) => simulatePlan(ctx, { shuttles }),
      );
      if (r.data) plans.push(r.data);
    };
    if (options.length) {
      say(`Testing ${options.length === 2 ? "two plans" : "a plan"} on forks of the closure graph.`);
      await simulate(options.slice(0, 1));
      if (options.length === 2) await simulate(options);
    }

    // The plan that clears the most stranded riders and max-flow shortfall per bus; it has to help.
    const gain = (p: PlanData) => p.before.stranded - p.after.stranded + (p.before.unmet - p.after.unmet);
    const best = plans.filter((p) => gain(p) > 0).sort((a, b) => gain(b) / b.vehicles - gain(a) / a.vehicles)[0];
    if (best) {
      choice = {
        planId: best.planId,
        text: `${best.planId}: ${best.shuttles.map((s) => `${name(s.from)} ↔ ${name(s.to)} at ${s.busesPerHour} buses an hour`).join(", ")} (${best.vehicles} buses). Riders with no path ${fmt(best.before.stranded)} → ${fmt(best.after.stranded)}; max-flow shortfall ${fmt(best.before.unmet)} → ${fmt(best.after.unmet)}.`,
      };
    } else {
      choice = await steer("No tested shuttle reduces the riders with no path or the shortfall, so the plan is to steer riders instead.");
    }
  }

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
  const remembered = [
    ...(memory?.findings ?? []).filter((f) => f.validToMs === null || f.validToMs === undefined).slice(0, 2).map((f) => `${f.text} (since ${day(f.validFromMs)})`),
    ...(past ? [`${past.note[0].toUpperCase()}${past.note.slice(1)}.`] : []),
  ];
  const overloads = cap?.reroute.overloaded.length ?? 0;

  const brief = [
    `**What broke** ${scenario.title}: ${lines} closed from ${name(first)} to ${name(last)}.`,
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
