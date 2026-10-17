import type { AgentEvent } from "@/lib/agent/catalog";
import type { CapacityData, PlanData } from "@/lib/graph/tools/capacity";
import type { ImpactData } from "@/lib/graph/tools/impact";
import type { Incident } from "@/lib/graph/tools/incident";
import type { PlanRecord } from "@/lib/graph/tools/plan";
import type { RiderProfile, RouteAnswer } from "@/lib/graph/tools/riders";
import type { Highlight, ToolResult } from "@/lib/graph/tools/types";
import { TOOL_TITLE } from "@/lib/tool-titles";
import type { MapOverlay, Overloaded } from "../map/subway-map";

/**
 * The control room's state: one timeline of everything the agents said and did, built from the
 * NDJSON events of a run and of the approval that follows it. Pure, so it is tested on recordings.
 */
export type Mode = "live" | "scripted" | "replay";

export interface ToolStep {
  kind: "tool";
  id: string;
  agent: string;
  tool: string;
  input: unknown;
  result?: ToolResult;
  error?: string;
}

export type Item =
  | { kind: "say"; agent: string; text: string }
  | ToolStep
  | { kind: "handoff"; from: string; to: string; note: string }
  | { kind: "approval"; planId: string }
  | { kind: "error"; agent: string; message: string };

export interface RunState {
  status: "idle" | "running" | "done" | "error";
  mode: Mode | null;
  note: string | null;
  model: string | null;
  items: Item[];
  brief: string | null;
  /** Rider id -> advisory text, filled by the rider desk after approval. */
  advisories: Record<string, string>;
  published: string | null;
  /** Scenario id when the run is a recording (approval then plays the recorded approval too). */
  recorded: string | null;
  stage: "control" | "desk";
}

export type RunAction =
  | { type: "start"; stage: "control" | "desk"; planId?: string }
  | { type: "event"; event: AgentEvent; scenarioId?: string }
  | { type: "fail"; message: string }
  | { type: "settle" }
  | { type: "reset" };

export const initialRun: RunState = {
  status: "idle",
  mode: null,
  note: null,
  model: null,
  items: [],
  brief: null,
  advisories: {},
  published: null,
  recorded: null,
  stage: "control",
};

const riderOf = (agent: string) => (agent.startsWith("rider:") ? agent.slice(6) : null);

export function reduce(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "reset":
      return initialRun;
    case "start":
      if (action.stage === "control") return { ...initialRun, status: "running" };
      return {
        ...state,
        status: "running",
        stage: "desk",
        advisories: {},
        items: [...state.items, { kind: "approval", planId: action.planId ?? "" }],
      };
    case "fail":
      return { ...state, status: "error", items: [...state.items, { kind: "error", agent: state.stage === "desk" ? "rider-desk" : "controller", message: action.message }] };
    case "settle":
      return state.status === "running" ? { ...state, status: "done" } : state;
    case "event":
      return onEvent(state, action.event, action.scenarioId);
  }
}

function onEvent(state: RunState, e: AgentEvent, scenarioId?: string): RunState {
  switch (e.type) {
    case "run":
      if (state.stage === "desk") return state;
      return { ...state, mode: e.mode, note: e.note ?? null, recorded: e.mode === "replay" ? (scenarioId ?? null) : null };
    case "model":
      return { ...state, model: e.model };
    case "text": {
      const rider = riderOf(e.agent);
      if (rider) return { ...state, advisories: { ...state.advisories, [rider]: (state.advisories[rider] ?? "") + e.delta } };
      const items = state.items.slice();
      const last = items[items.length - 1];
      if (last?.kind === "say" && last.agent === e.agent) items[items.length - 1] = { ...last, text: last.text + e.delta };
      else items.push({ kind: "say", agent: e.agent, text: e.delta });
      return { ...state, items };
    }
    case "tool-call":
      return { ...state, items: [...state.items, { kind: "tool", id: e.id, agent: e.agent, tool: e.tool, input: e.input }] };
    case "tool-result": {
      const items = state.items.slice();
      const at = findStep(items, e.id, e.agent);
      if (at >= 0) items[at] = { ...(items[at] as ToolStep), result: e.result };
      else items.push({ kind: "tool", id: e.id, agent: e.agent, tool: e.result.tool, input: null, result: e.result });
      const published = e.result.tool === "publish_plan" && e.result.outcome === "answered" ? ((e.result.data as { plan: PlanRecord | null }).plan?.id ?? null) : state.published;
      return { ...state, items, published };
    }
    case "tool-error": {
      const items = state.items.slice();
      const at = findStep(items, e.id, e.agent);
      if (at >= 0) items[at] = { ...(items[at] as ToolStep), error: e.message };
      return { ...state, items };
    }
    case "handoff":
      return { ...state, items: [...state.items, { kind: "handoff", from: e.from, to: e.to, note: e.note }] };
    case "done": {
      const rider = riderOf(e.agent);
      if (rider) return { ...state, advisories: { ...state.advisories, [rider]: e.text } };
      if (e.agent === "controller") {
        // The brief is shown as its own card; drop it from the narration it streamed in.
        const items = state.items.slice();
        const brief = e.text.trim();
        const last = items[items.length - 1];
        if (brief && last?.kind === "say" && last.text.trim().endsWith(brief)) {
          const rest = last.text.trim().slice(0, -brief.length).trim();
          if (rest) items[items.length - 1] = { ...last, text: rest };
          else items.pop();
        }
        return { ...state, items, brief: brief || state.brief, status: "done" };
      }
      return { ...state, status: "done" };
    }
    case "error":
      return { ...state, status: "error", items: [...state.items, { kind: "error", agent: e.agent, message: e.message }] };
  }
}

function findStep(items: Item[], id: string, agent: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.id === id && it.agent === agent) return i;
  }
  return -1;
}

/* Playback */

/** One tick of the playback bar: a tool step in call order, and the action (since the run started) that finished it. */
export interface StepMark {
  agent: string;
  id: string;
  tool: string;
  /** The plain name the trace shows, such as "Measure capacity". */
  title: string;
  /** Index of the action that finished the step; -1 while it runs. */
  end: number;
}

/**
 * A run kept for playback: the live state, every tool step, and the state as it stood once steps
 * 1..k had all finished (`at[k - 1]`), captured as the events arrive so scrubbing never re-reduces.
 */
export interface Timeline {
  run: RunState;
  steps: StepMark[];
  /** Steps 1..ready have all finished; only those can be scrubbed to. */
  ready: number;
  at: RunState[];
  /** Actions folded in since the run started. */
  count: number;
}

export const initialTimeline: Timeline = { run: initialRun, steps: [], ready: 0, at: [], count: 0 };

const stepTitle = (tool: string) => TOOL_TITLE[tool] ?? tool;

/** `reduce`, plus the bookkeeping playback needs. Steps mirror the tool items `reduce` creates, one for one. */
export function advance(t: Timeline, action: RunAction): Timeline {
  if (action.type === "reset") return initialTimeline;
  const base = action.type === "start" && action.stage === "control" ? initialTimeline : t;
  const index = base.count;
  const run = reduce(base.run, action);
  let steps = base.steps;
  if (action.type === "event") {
    const e = action.event;
    if (e.type === "tool-call") steps = [...steps, { agent: e.agent, id: e.id, tool: e.tool, title: stepTitle(e.tool), end: -1 }];
    else if (e.type === "tool-result" || e.type === "tool-error") {
      let at = -1;
      for (let i = steps.length - 1; i >= 0 && at < 0; i--) if (steps[i].id === e.id && steps[i].agent === e.agent) at = i;
      if (at >= 0 && steps[at].end < 0) steps = steps.map((s, i) => (i === at ? { ...s, end: index } : s));
      else if (at < 0 && e.type === "tool-result") steps = [...steps, { agent: e.agent, id: e.id, tool: e.result.tool, title: stepTitle(e.result.tool), end: index }];
    }
  }
  let ready = base.ready;
  while (ready < steps.length && steps[ready].end >= 0) ready++;
  // The action that unblocks the prefix is the last one any newly ready step waited for.
  const at = ready > base.ready ? [...base.at, ...Array.from({ length: ready - base.ready }, () => run)] : base.at;
  return { run, steps, ready, at, count: index + 1 };
}

const views = new WeakMap<RunState, Map<number, RunState>>();

/**
 * The run as the control room shows it at step k: tool steps after k are left out (parallel calls
 * may already have started). Memoized per state and step, so a scrub hands the panels the same objects.
 */
export function stepView(state: RunState, k: number): RunState {
  let byStep = views.get(state);
  if (!byStep) views.set(state, (byStep = new Map()));
  const hit = byStep.get(k);
  if (hit) return hit;
  let n = 0;
  const items = state.items.filter((it) => it.kind !== "tool" || ++n <= k);
  const view = items.length === state.items.length ? state : { ...state, items };
  byStep.set(k, view);
  return view;
}

/* Selectors */

const steps = (items: Item[]) => items.filter((i): i is ToolStep => i.kind === "tool");

function latest<T>(items: Item[], tool: string): ToolResult<T> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.tool === tool && it.result) return it.result as ToolResult<T>;
  }
  return undefined;
}

export const incidentOf = (items: Item[]) => (latest<{ incident: Incident | null }>(items, "close_line")?.data?.incident ?? null);
export const impactOf = (items: Item[]) => latest<ImpactData | null>(items, "affected_riders")?.data ?? null;
export const capacityOf = (items: Item[]) => latest<CapacityData | null>(items, "measure_capacity")?.data ?? null;
export interface PlanCard {
  id: string;
  kind: "shuttle" | "steer";
  label: string;
  legs: { from: string; to: string; busesPerHour: number; capacity: number }[];
  vehicles: number;
  before: { stranded: number; unmet: number; overflow: number };
  after: { stranded: number; unmet: number; overflow: number };
}

/** Every plan the controller tested or proposed in this run, in order. */
export function plansOf(items: Item[]): PlanCard[] {
  const out: PlanCard[] = [];
  for (const s of steps(items)) {
    if (!s.result || s.result.outcome !== "answered") continue;
    if (s.tool === "simulate_plan") {
      const p = s.result.data as PlanData | null;
      if (!p) continue;
      out.push({
        id: p.planId,
        kind: "shuttle",
        label: "",
        legs: p.shuttles.map((l) => ({ from: l.from, to: l.to, busesPerHour: l.busesPerHour, capacity: l.capacity })),
        vehicles: p.vehicles,
        before: { stranded: p.before.stranded, unmet: p.before.unmet, overflow: p.before.overflow },
        after: { stranded: p.after.stranded, unmet: p.after.unmet, overflow: p.after.overflow },
      });
    } else if (s.tool === "propose_steering") {
      const p = (s.result.data as { plan: PlanRecord | null }).plan;
      if (!p) continue;
      out.push({
        id: p.id,
        kind: "steer",
        label: p.label,
        legs: [],
        vehicles: 0,
        before: { stranded: p.strandedBefore, unmet: p.unmetBefore, overflow: p.overflowBefore },
        after: { stranded: p.strandedAfter, unmet: p.unmetAfter, overflow: p.overflowAfter },
      });
    }
  }
  return out;
}

/** The plan the brief recommends (its "Recommended plan" line names the id), else the last one tested. */
export function recommendedPlan(brief: string | null, plans: PlanCard[]): string | null {
  const line = brief?.split("\n").find((l) => /recommended plan/i.test(l));
  const named = line?.match(/PLAN-[A-Z0-9]+/)?.[0];
  if (named && plans.some((p) => p.id === named)) return named;
  return plans.length ? plans[plans.length - 1].id : null;
}

export interface RiderCard {
  profile: RiderProfile;
  answer: RouteAnswer | null;
  summary: string | null;
  advisory: string | null;
}

/** Remembered riders whose trips cross the closure, with the rider desk's route and advisory for each. */
export function ridersOf(state: RunState): RiderCard[] {
  const affected = latest<{ affected: RiderProfile[] }>(state.items, "riders_affected")?.data?.affected ?? [];
  return affected.map((profile) => {
    let route: ToolResult<{ answer: RouteAnswer | null }> | undefined;
    for (const s of steps(state.items)) if (s.agent === `rider:${profile.id}` && s.tool === "route_rider" && s.result) route = s.result as ToolResult<{ answer: RouteAnswer | null }>;
    return { profile, answer: route?.data?.answer ?? null, summary: route?.summary ?? null, advisory: state.advisories[profile.id] ?? null };
  });
}

/* Map */

function overloadedOf(r: ToolResult): Overloaded[] | undefined {
  const d = r.data as { reroute?: { overloaded: { kind: "RUNS" | "BUS"; id: number; pct: number }[] } } | null;
  return d?.reroute?.overloaded.map((o) => ({ kind: o.kind, id: o.id, pct: o.pct }));
}

/** Index (into items) of the last tool step that has something to draw. */
export function lastDrawable(items: Item[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.result?.highlight) return i;
  }
  return -1;
}

/**
 * What the map shows for the step at `index`: the closure in force at that point, plus that
 * step's own evidence (depth, flows and cut, a tested shuttle, a rider's path).
 */
export function overlayAt(items: Item[], index: number): { overlay: MapOverlay; focus: string[] } {
  let closedEids: number[] | undefined;
  let stretch: string[] = [];
  let shuttles: Highlight["shuttles"];
  for (let i = 0; i <= index && i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "tool" || !it.result) continue;
    if (it.tool === "close_line" && it.result.highlight?.closedEids) {
      closedEids = it.result.highlight.closedEids;
      stretch = it.result.highlight.stations ?? [];
    }
    if (it.tool === "publish_plan") {
      const plan = (it.result.data as { plan: PlanRecord | null } | null)?.plan;
      shuttles = plan?.legs.map((l) => ({ from: l.from, to: l.to, busesPerHour: l.busesPerHour, capacity: l.capacity }));
    }
  }
  const it = items[index];
  const h = it?.kind === "tool" ? it.result?.highlight : undefined;
  const overlay: MapOverlay = { closedEids: h?.closedEids ?? closedEids, shuttles: h?.shuttles ?? shuttles };
  if (it?.kind === "tool" && it.result && h) {
    if (h.depth) overlay.depth = h.depth;
    if (h.flows) overlay.flows = h.flows;
    if (h.cut) overlay.cut = h.cut;
    if (h.path) {
      overlay.path = h.path;
      overlay.pathEids = h.pathEids;
    }
    if (h.stations && it.tool !== "close_line") overlay.stations = h.stations;
    const over = overloadedOf(it.result);
    if (over) overlay.overloaded = over;
  }
  const flowEnds = (overlay.flows ?? []).slice(0, 14).flatMap((f) => [f.from, f.to]);
  const focus = [...new Set([...stretch, ...(overlay.path ?? []), ...flowEnds, ...(overlay.shuttles ?? []).flatMap((s) => [s.from, s.to])])];
  return { overlay, focus };
}
