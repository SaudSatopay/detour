// Builds public/map/story-l-canarsie.json, the landing page's scroll story of the L closure, from the run
// recorded on FalkorDB (data/replays/l-canarsie-*.ndjson) and the CI max-flow output already in
// public/map/hero-l-canarsie.json. Every number the story prints comes from this file; none is typed by hand.
// Run: node scripts/build-story.mjs
import { readFileSync, writeFileSync } from "node:fs";

const events = (file) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).event);

/** Tool results with the tool name and input of the call that produced them. */
function results(evs) {
  const calls = new Map(evs.filter((e) => e.type === "tool-call").map((e) => [e.id, e]));
  return evs.filter((e) => e.type === "tool-result").map((e) => ({ ...e.result, tool: calls.get(e.id)?.tool, input: calls.get(e.id)?.input, agent: e.agent }));
}

const control = events("data/replays/l-canarsie-control.ndjson");
const publish = events("data/replays/l-canarsie-publish.ndjson");
const hero = JSON.parse(readFileSync("public/map/hero-l-canarsie.json", "utf8"));
const map = JSON.parse(readFileSync("public/map/nyc.json", "utf8"));
const names = new Map(map.stations.map((s) => [s[0], s[1]]));

const run = results(control);
const one = (tool) => {
  const r = run.find((x) => x.tool === tool);
  if (!r) throw new Error(`No ${tool} result in the recorded run`);
  return r;
};
const close = one("close_line");
const impact = one("affected_riders");
const capacity = one("measure_capacity");
const recall = one("recall_memory");

const brief = control.find((e) => e.type === "done")?.text ?? "";
const recommendedId = brief.match(/\*\*Recommended plan\*\* (PLAN-[A-Z0-9]+)/)?.[1];
const plan = run.find((r) => r.tool === "simulate_plan" && r.data.planId === recommendedId);
if (!plan) throw new Error("The recommended plan named in the brief is not among the simulated plans");

// The worst planned-to-observed shuttle the controller remembered, which sized the recommended plan.
const remembered = (recall.data.incidents ?? [])
  .flatMap((i) => (i.shuttles ?? []).map((s) => ({ ...s, openedMs: i.openedMs, example: i.example })))
  .filter((s) => s.planned && s.observed)
  .sort((a, b) => a.observed / a.planned - b.observed / b.planned)[0];

const peak = capacity.data.directions.find((d) => d.direction === capacity.data.peak);
if (peak.required !== hero.peak.required || peak.absorbed !== hero.peak.absorbed) {
  throw new Error("The CI max-flow output and the recorded run disagree; rebuild public/map/hero-l-canarsie.json first");
}

const ridersRun = results(publish);
const affected = ridersRun.find((r) => r.tool === "riders_affected")?.data.affected ?? [];
const routes = ridersRun.filter((r) => r.tool === "route_rider");
const advice = new Map(publish.filter((e) => e.type === "done" && e.agent?.startsWith("rider:")).map((e) => [e.agent.slice(6), e.text]));
const featuredRider = affected.find((a) => a.stepFree) ?? affected[0];
const featuredRoute = routes.find((r) => r.input?.rider_id === featuredRider.id);

const keepFlow = (f) => ({ kind: f.kind, id: f.id, from: f.from, to: f.to, flow: Math.round(f.flow) });
const stationsUsed = new Set([
  ...close.data.incident.stretch,
  ...capacity.data.reroute.overloaded.flatMap((o) => [o.from, o.to]),
  ...peak.strandedAt.map((s) => s.id),
  ...plan.highlight.shuttles.flatMap((s) => [s.from, s.to]),
  ...(featuredRoute?.highlight.path ?? []),
  featuredRider.from,
  featuredRider.to,
]);

const story = {
  source: "Run of the L closure recorded on FalkorDB (data/replays/l-canarsie-*.ndjson); max-flow edge flows from the CI run on FalkorDB (public/map/hero-l-canarsie.json).",
  names: Object.fromEntries([...stationsUsed].map((id) => [id, names.get(id) ?? id])),
  incident: {
    title: close.data.incident.title,
    report: close.data.incident.report,
    routes: close.data.incident.routes,
    stretch: close.data.incident.stretch,
  },
  closedEids: close.highlight.closedEids,
  impact: {
    total: impact.data.totalRiders,
    pairs: impact.data.pairs,
    byDepth: impact.data.byDepth,
    depth: impact.highlight.depth,
    origins: impact.highlight.stations,
  },
  reroute: {
    rerouted: capacity.data.reroute.rerouted,
    stranded: capacity.data.reroute.stranded,
    overflow: capacity.data.reroute.overflow,
    overloaded: capacity.data.reroute.overloaded.map((o) => ({ kind: o.kind, id: o.id, route: o.route, from: o.from, to: o.to, pct: o.pct })),
    flows: capacity.highlight.flows.map(keepFlow),
  },
  maxFlow: {
    direction: peak.direction,
    required: peak.required,
    absorbed: peak.absorbed,
    unmet: peak.unmet,
    strandedAt: peak.strandedAt,
    // The steering plan the rider desk follows; edges under 25 riders an hour are left out of the picture only.
    flows: hero.peak.flows.filter((f) => f.flow >= 25).map(keepFlow),
  },
  plan: {
    id: plan.data.planId,
    shuttles: plan.data.shuttles.map((s) => ({ from: s.from, to: s.to, busesPerHour: s.busesPerHour, capacity: s.capacity, vehicles: s.vehicles, meters: s.meters })),
    vehicles: plan.data.vehicles,
    before: plan.data.before,
    after: plan.data.after,
    flows: plan.highlight.flows.map(keepFlow),
    alternatives: run.filter((r) => r.tool === "simulate_plan").length - 1,
  },
  memory: remembered
    ? {
        from: remembered.from,
        to: remembered.to,
        planned: remembered.planned,
        observed: remembered.observed,
        openedMs: remembered.openedMs,
        example: Boolean(remembered.example),
        uplift: Math.round((remembered.planned / remembered.observed - 1) * 100),
      }
    : null,
  riders: {
    advised: routes.length,
    featured: {
      id: featuredRider.id,
      name: featuredRider.name,
      persona: featuredRider.persona,
      stepFree: featuredRider.stepFree,
      minutes: Math.round(featuredRoute.data.answer.minutes),
      advisory: advice.get(featuredRider.id) ?? null,
      path: featuredRoute.highlight.path,
      pathEids: featuredRoute.highlight.pathEids,
    },
  },
};

writeFileSync("public/map/story-l-canarsie.json", `${JSON.stringify(story)}\n`);
const kb = Math.round(JSON.stringify(story).length / 1024);
console.log(`public/map/story-l-canarsie.json written (${kb} KB): ${story.impact.total} displaced, plan ${story.plan.id}, ${story.riders.advised} riders advised`);
