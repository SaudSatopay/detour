import { Tracer } from "../graph/trace";
import { affectedRiders, type ImpactData } from "../graph/tools/impact";
import { closeLine } from "../graph/tools/incident";
import { measureCapacity, type CapacityData } from "../graph/tools/capacity";
import { recall, type RecallData } from "../graph/tools/memory";
import { resolvePlaces } from "../graph/tools/places";
import { routeRider } from "../graph/tools/riders";
import type { ToolContext, ToolResult } from "../graph/tools/types";
import { loadNetwork } from "../network/data";

/**
 * The rules-only floor: no model. A deterministic router reads the question with regular expressions, calls the
 * same graph tools the agent has, in a fixed order, and fills a template answer from their results. It was written
 * against the question templates (which dev and held-out share), so it is an optimistic floor: what plain rules on
 * the graph get when they know exactly how questions are worded.
 */
export interface RulesOutcome {
  text: string;
  calls: { tool: string; input: unknown; result: ToolResult }[];
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

const CLOSURE = /\bthe ([A-Z0-9, ]+?)(?: and ([A-Z0-9]+))? trains? (?:is|are) suspended in both directions between (.+?) and (.+?)\.(?:\s|$)/;
const FROM_TO = /\bfrom (.+?) to (.+?)(?: take| at 8| using| by subway| \(|\?|$)/;

/** Route letters named in a question about memory: "on the L", "(A and C trains)", "the G platform". */
function routesNamed(q: string): string[] {
  const found = new Set<string>();
  for (const m of q.matchAll(/\bthe\s+([A-Z0-9])(?:\s+and\s+(?:the\s+)?([A-Z0-9]))?\b(?!-)/g)) {
    found.add(m[1]);
    if (m[2]) found.add(m[2]);
  }
  for (const m of q.matchAll(/\(([A-Z0-9])(?: and ([A-Z0-9]))? trains?\)/g)) {
    found.add(m[1]);
    if (m[2]) found.add(m[2]);
  }
  return [...found];
}

export async function rulesAnswer(base: Omit<ToolContext, "tracer">, question: string): Promise<RulesOutcome> {
  const calls: RulesOutcome["calls"] = [];
  const call = async <T>(tool: string, input: unknown, fn: (ctx: ToolContext) => Promise<ToolResult<T>>): Promise<ToolResult<T>> => {
    const result = await fn({ ...base, tracer: new Tracer() });
    calls.push({ tool, input, result });
    return result;
  };
  const done = (answer: string, why = "") => ({ text: `${why}${why ? "\n" : ""}Answer: ${answer}`, calls });

  /** Resolves names to station ids; null (with an answer) when one is not in the graph. */
  const resolve = async (names: string[], routeHint?: string) => {
    const r = await call("resolve_places", { names, route_hint: routeHint }, (ctx) => resolvePlaces(ctx, { names, routeHint }));
    const matches = r.data.matches;
    const unknown = matches.filter((m) => m.kind !== "station");
    if (unknown.length) return { ids: null, unknown: unknown.map((m) => m.query), matches };
    return { ids: matches.map((m) => m.stations![0].id), unknown: [], matches };
  };

  // ---- a closure, then what the question measures on it
  const closure = CLOSURE.exec(question);
  if (closure) {
    const routes = [...closure[1].split(/,\s*/), ...(closure[2] ? [closure[2]] : [])].map((r) => r.trim()).filter(Boolean);
    const [a, b] = [closure[3], closure[4]];
    const places = await resolve([a, b], routes[0]);
    if (!places.ids) return done(`unknown: ${places.unknown.join(", ")} is not in the graph`);
    const closed = await call("close_line", { routes, from_station_id: places.ids[0], to_station_id: places.ids[1] }, (ctx) =>
      closeLine(ctx, { routes, fromStation: places.ids![0], toStation: places.ids![1], report: "Eval question" }),
    );
    if (closed.outcome !== "answered") return done(`unknown: not in the graph (${closed.summary})`);

    const rest = question.slice(closure.index + closure[0].length);
    const depth = /within (\d+) stops?/.exec(rest);
    if (/cross/.test(rest) || depth) {
      const k = depth ? Number(depth[1]) : 4;
      const imp = await call("affected_riders", { depth: k }, (ctx) => affectedRiders(ctx, { depth: k }));
      const d = imp.data as ImpactData | null;
      if (!d) return done("unknown");
      return done(fmt(depth ? (d.byDepth.find((x) => x.depth === k)?.riders ?? 0) : d.totalRiders));
    }
    const reach = /can a rider get from (.+?) to (.+?) by subway/.exec(rest);
    if (reach) {
      const trip = await resolve([reach[1], reach[2]]);
      if (!trip.ids) return done(`unknown: ${trip.unknown.join(", ")} is not in the graph`);
      const routed = await call("route_rider", { from_station_id: trip.ids[0], to_station_id: trip.ids[1] }, (ctx) => routeRider(ctx, { from: trip.ids![0], to: trip.ids![1] }));
      return done(routed.outcome === "answered" ? "yes" : "no", routed.summary);
    }
    const cap = await call("measure_capacity", {}, (ctx) => measureCapacity(ctx));
    const c = cap.data as CapacityData | null;
    if (!c) return done("unknown");
    const peak = c.directions.find((d) => d.direction === c.peak) ?? c.directions[0];
    if (/could the network carry all/.test(rest)) return done(c.directions.every((d) => d.unmet < 1) ? "yes" : "no");
    if (/still could not move/.test(rest)) return done(fmt(peak?.unmet ?? 0));
    if (/could the open network carry/.test(rest)) return done(fmt(peak?.absorbed ?? 0));
    if (/min cut/.test(rest)) {
      const stuck = peak?.strandedAt[0]?.id ?? peak?.cut[0]?.from;
      if (!stuck) return done("unknown");
      const network = await loadNetwork();
      return done(network.stations.find((s) => s.id === stuck)?.name ?? stuck, cap.summary);
    }
    return done("unknown");
  }

  // ---- trips: minutes, transfers, step-free, reachability
  const trip = FROM_TO.exec(question);
  if (trip && /trip|route|get from/.test(question)) {
    const places = await resolve([trip[1], trip[2]]);
    if (!places.ids) return done(`unknown: ${places.unknown.join(", ")} is not in the graph`);
    const stepFree = /step-free/.test(question);
    const routed = await call("route_rider", { from_station_id: places.ids[0], to_station_id: places.ids[1], step_free: stepFree || undefined }, (ctx) =>
      routeRider(ctx, { from: places.ids![0], to: places.ids![1], stepFree: stepFree || undefined }),
    );
    const answer = routed.data.answer;
    if (/Answer yes or no/.test(question)) return done(answer ? "yes" : "no", routed.summary);
    if (!answer) return done("unknown: no open path in the graph", routed.summary);
    if (/change trains/.test(question)) return done(String(answer.transfers), routed.summary);
    return done(`${answer.minutes} minutes`, routed.summary);
  }

  // ---- which lines stop at a station
  const lines = /Which subway lines stop at (.+?) in the/.exec(question);
  if (lines) {
    const places = await resolve([lines[1]]);
    if (!places.ids) return done(`unknown: ${places.unknown.join(", ")} is not in the graph`);
    return done(places.matches[0].stations![0].routes.join(", "));
  }

  // ---- memory: elevators at a station, past incidents, playbooks
  const elevator = /elevator to the ([A-Z0-9]) platform at (.+?) (?:been|out|reported|first)/.exec(question);
  // An elevator is a fact about one station: recalling by route too would bring in other stations' elevators.
  const routes = elevator ? [] : routesNamed(question);
  let stations: string[] = [];
  if (elevator) {
    const places = await resolve([elevator[2]], elevator[1]);
    if (!places.ids) return done(`unknown: ${places.unknown.join(", ")} is not in the graph`);
    stations = places.ids;
  }
  if (!routes.length && !stations.length) return done("unknown");
  const recalled = await call("recall_memory", { station_ids: stations, routes }, (ctx) => recall(ctx, { stations, routes }));
  const memory = recalled.data as RecallData;

  if (elevator) {
    const about = memory.findings.filter((f) => /elevator/i.test(f.text) && f.kind === "accessibility" && f.text.includes(`${elevator[1]} platform`));
    const current = about.find((f) => f.validToMs === null || f.validToMs === undefined);
    const closed = about.find((f) => f.validToMs !== null && f.validToMs !== undefined);
    if (/right now/.test(question)) return done(current ? "yes" : "no", recalled.summary);
    if (/back in service/.test(question)) return closed ? done(day(closed.validToMs!), recalled.summary) : done("unknown: nothing remembered");
    if (/first reported/.test(question)) return about.length ? done(day((closed ?? about[0]).validFromMs), recalled.summary) : done("unknown: nothing remembered");
    return current ? done(day(current.validFromMs), recalled.summary) : done("unknown: nothing remembered about that elevator");
  }
  const incident = memory.incidents.find((i) => i.shuttles.length) ?? memory.incidents[0];
  const shuttle = incident?.shuttles[0];
  if (/share of its planned riders/.test(question) && shuttle) return done(`${Math.round((shuttle.observed / shuttle.planned) * 100)}%`, recalled.summary);
  if (/planned to carry/.test(question) && shuttle) return done(fmt(shuttle.planned), recalled.summary);
  if (/actually carry/.test(question) && shuttle) return done(fmt(shuttle.observed), recalled.summary);
  if (/buses an hour/.test(question) && shuttle) return done(String(shuttle.bph), recalled.summary);
  if (/On what date did/.test(question) && incident) return done(day(incident.openedMs), recalled.summary);
  if (/minutes in/.test(question)) {
    const m = memory.findings.map((f) => /(\d+) minutes in/.exec(f.text)).find(Boolean);
    if (m) return done(m[1], recalled.summary);
  }
  if (/nominal bus capacity|share of its plan/.test(question)) {
    const m = memory.playbooks.map((p) => /(\d+)% of (?:nominal|plan)/.exec(p.steps.join(" "))).find(Boolean);
    if (m) return done(`${m[1]}%`, recalled.summary);
  }
  return done("unknown: nothing remembered", recalled.summary);
}
