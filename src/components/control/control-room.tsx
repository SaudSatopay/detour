"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Scenario } from "@/lib/network/data";
import { MapPanel } from "../map/map-panel";
import type { LabelExclusion } from "../map/subway-map";
import { useMapModel } from "../map/use-map-model";
import { ImpactPanel } from "./impact-panel";
import { PlaybackBar, type Speed } from "./playback-bar";
import { capacityOf, impactOf, incidentOf, lastDrawable, overlayAt, plansOf, recommendedPlan, ridersOf, stepView, type RunState } from "./run-state";
import { agentName, Trace } from "./trace";
import { useControlRun } from "./use-control-run";

interface SandboxStatus {
  incident: { id: string; title: string; routes: string[] } | null;
  error?: string;
}

function ModeBadge({ state }: { state: RunState }) {
  if (!state.mode) return null;
  const tone =
    state.mode === "live"
      ? "bg-signal-strong text-signal-ink"
      : state.mode === "scripted"
        ? "bg-warn-wash text-ink-900 border border-warn"
        : "bg-sunk text-ink-900 border border-line-strong";
  const text = state.mode === "live" ? `Live · ${state.model?.split(":").pop() ?? "model"}` : state.mode === "scripted" ? "Scripted · no model" : "Recorded run";
  return (
    <span className={`label inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 ${tone}`} title={state.note ?? undefined}>
      {state.mode === "live" ? <span aria-hidden="true" className="size-1.5 rounded-full bg-signal-ink" /> : null}
      {text}
    </span>
  );
}

// The step caption (top-left) and the legend (bottom-left) sit over the map; no station labels under them.
const MAP_OVERLAYS: LabelExclusion[] = [
  { anchor: "tl", w: 430, h: 52 },
  { anchor: "bl", w: 540, h: 56, minWidth: 640 },
  // On phones the legend wraps across the full width.
  { anchor: "bl", w: 640, h: 88, maxWidth: 639 },
];

function Legend({ overlay }: { overlay: ReturnType<typeof overlayAt>["overlay"] }) {
  const items: { key: string; label: string; swatch: React.ReactNode }[] = [];
  if (overlay.closedEids?.length)
    items.push({ key: "closed", label: "Closed", swatch: <span className="swatch-closed block h-1 w-5 rounded-full" /> });
  if (overlay.flows?.length) items.push({ key: "flow", label: "Displaced riders", swatch: <span className="block h-1 w-5 rounded-full bg-signal" /> });
  if (overlay.overloaded?.length) items.push({ key: "over", label: "Over capacity", swatch: <span className="block h-1 w-5 rounded-full bg-crit" /> });
  if (overlay.cut?.length) items.push({ key: "cut", label: "Bottleneck", swatch: <span className="swatch-cut block h-1.5 w-5" /> });
  if (overlay.shuttles?.length)
    items.push({ key: "bus", label: "Shuttle bus", swatch: <span className="swatch-bus block h-1 w-5 rounded-full" /> });
  if (overlay.depth) items.push({ key: "depth", label: "Where hit riders board", swatch: <span className="block size-2.5 rounded-full bg-crit" /> });
  if (overlay.path?.length) items.push({ key: "path", label: "Rider's route", swatch: <span className="block h-1 w-5 rounded-full bg-ink-900" /> });
  if (!items.length) return null;
  return (
    <ul className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-4.5rem)] flex-wrap gap-x-3 gap-y-1 rounded-md border border-line bg-panel/95 px-2.5 py-1.5 text-xs text-ink-700 shadow-lift">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-1.5">
          {i.swatch}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

const noSubscribe = () => () => {};

/**
 * `value`, one frame late: a new value is shown, as a transition, from the frame after it arrives. A step
 * changes the trace and impact panels and the map at once; drawn in one frame, the two took longer than a frame
 * budget allows at 4x CPU, so the map follows a frame behind the panels.
 */
function useNextFrame<T>(value: T): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (Object.is(shown, value)) return;
    const frame = requestAnimationFrame(() => startTransition(() => setShown(value)));
    return () => cancelAnimationFrame(frame);
  }, [shown, value]);
  return shown;
}

/** One playback step per beat at 1x. */
const STEP_MS = 1400;

export function ControlRoom({ scenarios }: { scenarios: Scenario[] }) {
  // The page is static; the URL's ?scenario, ?run and ?step are read on the client. null during prerender and
  // hydration (the server has no URL), so nothing rewrites the address before it has been read.
  const search = useSyncExternalStore<string | null>(noSubscribe, () => window.location.search, () => null);
  const params = useMemo(() => new URLSearchParams(search ?? ""), [search]);
  const autoRun = params.get("run") === "1";
  const [picked, setPicked] = useState<string | null>(null);
  const [edited, setEdited] = useState<string | null>(null);
  const scenarioId = picked ?? scenarios.find((s) => s.id === params.get("scenario"))?.id ?? scenarios[0].id;
  const [pinned, setPinned] = useState<number | null>(null);
  const [tab, setTab] = useState<"trace" | "impact" | "riders">("trace");
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [resetting, setResetting] = useState(false);
  const [editing, setEditing] = useState(false);
  const { timeline, state, run, approve, clear } = useControlRun();
  // Playback: null follows the newest step; a number shows the run as it stood after that step.
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [linkDone, setLinkDone] = useState(false);
  const { model } = useMapModel();

  const nameOf = useCallback((id: string) => model?.stations.get(id)?.name ?? id, [model]);
  const colorOf = useCallback((route: string) => model?.routes.get(route)?.color ?? "", [model]);

  const loadStatus = useCallback(() => {
    // With ?recorded the server answers 200 even when the database is down, marking the state as recorded.
    fetch("/api/sandbox?recorded=l-canarsie", { cache: "no-store" })
      .then((r) => r.json() as Promise<SandboxStatus & { recorded?: string }>)
      .then((s) => setStatus(s.recorded ? { incident: null, error: "unreachable" } : s))
      .catch(() => setStatus({ incident: null, error: "unreachable" }));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  const scenario = scenarios.find((s) => s.id === scenarioId) ?? null;
  const message = edited ?? scenario?.report ?? "";
  const custom = !scenario || message.trim() !== scenario.report;
  const running = state.status === "running";

  const start = useCallback(() => {
    setPinned(null);
    setCursor(null);
    setPlaying(false);
    setEditing(false);
    setTab("trace");
    void run({ message: message.trim(), scenarioId: custom ? undefined : scenarioId }).then(loadStatus);
  }, [custom, loadStatus, message, run, scenarioId]);

  // Arriving from "Break the L train" starts the run straight away (once, even under Strict Mode).
  const autoRan = useRef(false);
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!autoRun || autoRan.current) return;
    // Deferred, so a Strict Mode remount (which aborts streams on unmount) cancels the timer, not the run.
    const timer = setTimeout(() => {
      autoRan.current = true;
      start();
    }, 0);
    return () => clearTimeout(timer);
  }, [autoRun, start]);

  // When the rider desk starts, bring its advisories into view in the right rail.
  const deskStarted = state.stage === "desk";
  useEffect(() => {
    const el = rail.current?.querySelector<HTMLElement>("[data-riders]");
    // Scroll the rail only; scrollIntoView would also move the page under the sticky header.
    if (deskStarted && el && rail.current) rail.current.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" });
  }, [deskStarted]);

  const onApprove = useCallback(
    (planId: string) => {
      setPinned(null);
      setTab("riders");
      void approve(planId, state.recorded).then(loadStatus);
    },
    [approve, loadStatus, state.recorded],
  );

  const resetSandbox = useCallback(async () => {
    setResetting(true);
    try {
      await fetch("/api/sandbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset" }) });
    } finally {
      clear();
      setPinned(null);
      setCursor(null);
      setPlaying(false);
      setResetting(false);
      loadStatus();
    }
  }, [clear, loadStatus]);

  /* Playback */
  const ready = timeline.ready;
  // The step on screen: an earlier finished step, or (while a run streams) the newest one the visitor stopped on.
  const at = cursor !== null && cursor >= 1 && (cursor < ready || (cursor === ready && running)) ? cursor : null;
  const isPlaying = playing && at !== null;

  const go = useCallback(
    (step: number) => {
      setPinned(null);
      // A visitor's move outranks a ?step still waiting for its step (and ?step now echoes the cursor).
      setLinkDone(true);
      if (step >= ready) {
        // The end of the run is the live state: follow it again.
        setCursor(null);
        setPlaying(false);
      } else setCursor(Math.max(1, step));
    },
    [ready],
  );
  const toLatest = useCallback(() => go(Infinity), [go]);
  const togglePlay = () => {
    if (isPlaying) {
      setPlaying(false);
      return;
    }
    if (at === null) {
      // From the end, play the run again from its first step.
      setPinned(null);
      setLinkDone(true);
      setCursor(1);
    }
    setPlaying(true);
  };

  // Play advances one step per beat and stops at the end (go() stops it there).
  useEffect(() => {
    if (!isPlaying || at === null) return;
    const timer = setTimeout(() => go(at + 1), STEP_MS / speed);
    return () => clearTimeout(timer);
  }, [isPlaying, at, speed, go]);

  // ?step=N opens the run at step N once that step has finished (or the run ended short of it).
  const wanted = Math.floor(Number(params.get("step"))) || 0;
  if (!linkDone && wanted > 0 && ready > 0 && (ready >= wanted || !running)) {
    setLinkDone(true);
    setCursor(Math.min(wanted, ready));
  }
  // Keep ?step in the address as the visitor scrubs; replaceState, so scrubbing adds no history entries.
  useEffect(() => {
    if (search === null || (wanted > 0 && !linkDone)) return;
    const url = new URL(window.location.href);
    if (at === null) url.searchParams.delete("step");
    else url.searchParams.set("step", String(at));
    if (url.search !== window.location.search) window.history.replaceState(null, "", url);
  }, [at, linkDone, search, wanted]);

  // Everything below reads the run as it stood at the step on screen; stepView memoizes per step.
  const snapshot = at === null ? null : timeline.at[at - 1];
  const view = snapshot && at !== null ? stepView(snapshot, at) : state;
  const viewRunning = view.status === "running";

  const items = view.items;
  const latestIndex = lastDrawable(items);
  const selected = pinned !== null && pinned < items.length ? pinned : latestIndex;
  const selectedStep = items[selected]?.kind === "tool" ? items[selected] : null;
  // The map, its caption and its legend, a frame behind the panels (overlayAt hands back the same view per step).
  const drawn = overlayAt(items, selected);
  const map = useNextFrame(useMemo(() => ({ ...drawn, step: selectedStep }), [drawn, selectedStep]));
  const { overlay, focus, step: mapStep } = map;
  const plans = useMemo(() => plansOf(items), [items]);
  const recommended = recommendedPlan(view.brief, plans);
  const riders = useMemo(() => ridersOf(view), [view]);
  const incident = incidentOf(items);
  const impactProps = {
    incident,
    impact: impactOf(items),
    capacity: capacityOf(items),
    plans,
    recommended: viewRunning && view.stage === "control" ? null : recommended,
    published: view.published,
    riders,
    stage: view.stage,
    // An earlier step is history: its plans cannot be approved from there.
    running: viewRunning,
    nameOf,
    colorOf,
    onApprove,
  };

  // Keyboard users jump from the brief to the recommended plan's Approve button.
  const jumpToPlan = () => {
    const focusIn = (root: ParentNode | null) => {
      const button = root?.querySelector<HTMLElement>("[data-recommended] button") ?? root?.querySelector<HTMLElement>("article button");
      button?.focus({ preventScroll: false });
      return Boolean(button);
    };
    const desktop = window.matchMedia("(min-width: 1024px)").matches;
    const rewound = at !== null;
    if (rewound) toLatest();
    if (desktop && !rewound) {
      focusIn(rail.current);
      return;
    }
    if (!desktop) setTab("impact");
    requestAnimationFrame(() => requestAnimationFrame(() => focusIn(desktop ? rail.current : document.getElementById("run-tabpanel"))));
  };

  // On phones the intake folds to one line once a run exists, so the map and its evidence come first.
  const compact = state.items.length > 0 && !editing;
  const intake = (
    <form
      className="flex flex-col gap-3 border-b border-line p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!running && message.trim().length >= 2) start();
      }}
    >
      {compact ? (
        <div className="flex items-baseline gap-2 lg:hidden">
          <span className="label text-ink-500">Disruption</span>
          <span className="min-w-0 flex-1 truncate font-display text-base font-semibold">{custom ? message : scenario?.title}</span>
          <button type="button" onClick={() => setEditing(true)} className="label shrink-0 text-ink-700 underline decoration-line-strong underline-offset-4">
            Change
          </button>
        </div>
      ) : null}
      <fieldset className={`flex min-w-0 flex-col gap-1.5 ${compact ? "max-lg:hidden" : ""}`}>
        <legend className="label mb-1.5 text-ink-500">Report a disruption</legend>
        {scenarios.map((s) => {
          const active = s.id === scenarioId && !custom;
          return (
            <label
              key={s.id}
              className={`flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors duration-150 ${
                active ? "border-ink-900 bg-panel" : "border-line hover:border-line-strong"
              }`}
            >
              <input
                type="radio"
                name="scenario"
                value={s.id}
                checked={active}
                onChange={() => {
                  setPicked(s.id);
                  setEdited(null);
                }}
                className="mt-1 accent-[var(--ink-900)]"
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-display text-base font-semibold leading-tight text-ink-900">{s.title}</span>
                <span className="truncate text-xs text-ink-500">{s.report}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <label className={`flex flex-col gap-1 ${compact ? "max-lg:hidden" : ""}`}>
        <span className="label text-ink-500">Dispatcher&apos;s report</span>
        <textarea
          value={message}
          onChange={(e) => setEdited(e.target.value)}
          rows={3}
          maxLength={600}
          className="resize-none rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:border-signal"
          placeholder="Describe a closure: which line, between which stations."
        />
        {custom ? <span className="text-xs text-ink-500">A report of your own needs a live model; the presets also run without one.</span> : null}
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={running || message.trim().length < 2}
          className="shrink-0 whitespace-nowrap rounded-md bg-ink-900 px-4 py-2.5 font-display text-lg font-semibold tracking-wide text-paper transition-transform duration-150 ease-out enabled:hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "Running…" : state.items.length ? "Run again" : "Run the controller"}
        </button>
        {state.brief && plans.length && state.stage === "control" && !running ? (
          <button
            type="button"
            onClick={jumpToPlan}
            className="label rounded-sm border border-ink-900 px-2.5 py-1.5 text-ink-900 transition-colors duration-150 hover:bg-sunk"
          >
            Go to the recommended plan
          </button>
        ) : (
          <span className="text-xs leading-snug text-ink-500">On your own copy of the graph. Nothing reaches riders until you approve.</span>
        )}
      </div>
      {status?.incident && !state.items.length ? (
        <p className="text-xs text-ink-500">
          Your sandbox still has {status.incident.id} open ({status.incident.title}). A new run replaces it.
        </p>
      ) : null}
      {status?.error && !state.items.length ? (
        <p className="text-xs text-ink-500">The graph database is not reachable right now, so preset runs will play their recordings.</p>
      ) : null}
    </form>
  );

  const tracePane = state.items.length ? (
    <Trace state={view} live={at === null} selected={selected} onSelect={setPinned} onJumpToPlan={plans.length ? jumpToPlan : undefined} />
  ) : (
    <div className="flex flex-col gap-2 text-sm text-ink-700">
      <p className="font-display text-xl font-semibold text-ink-900">The agents&apos; work shows here.</p>
      <p>
        Every step is a tool call on FalkorDB: its answer shape, a one-line summary and the Cypher that ran. Click a step to see its evidence on
        the map.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-3rem)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2">
        <h1 className="font-display text-xl font-bold tracking-wide">Control room</h1>
        <ModeBadge state={state} />
        {state.note ? <p className="hidden min-w-0 flex-1 truncate text-xs text-ink-500 md:block">{state.note}</p> : null}
        <button
          type="button"
          onClick={resetSandbox}
          disabled={running || resetting}
          className="label ml-auto rounded-sm border border-line px-2 py-1 text-ink-700 transition-colors duration-150 enabled:hover:border-line-strong enabled:hover:text-ink-900 disabled:opacity-50"
        >
          {resetting ? "Resetting…" : "Reset my sandbox"}
        </button>
      </div>
      {state.note ? <p className="border-b border-line px-4 py-2 text-xs text-ink-500 md:hidden">{state.note}</p> : null}

      <div className="grid flex-1 lg:min-h-0 lg:grid-cols-[minmax(300px,370px)_minmax(0,1fr)_minmax(320px,400px)]">
        <aside className="flex min-w-0 flex-col lg:min-h-0 lg:border-r lg:border-line">
          {intake}
          <div data-scroll tabIndex={0} role="region" aria-label="Agent trace" className="hidden flex-1 overflow-y-auto p-4 lg:block">
            {tracePane}
          </div>
        </aside>

        <div className="flex min-w-0 flex-col max-lg:border-b max-lg:border-line lg:min-h-0">
          {/* The map is a lit display on the night stage, in both themes. */}
          <section aria-label="Subway map" className="night relative h-[58vh] min-w-0 overflow-hidden lg:h-auto lg:min-h-0 lg:flex-1">
            <div className="absolute inset-0">
              <MapPanel
                overlay={overlay}
                focus={focus.length ? focus : undefined}
                className="h-full w-full"
                exclude={MAP_OVERLAYS}
                label={mapStep?.kind === "tool" && mapStep.result ? mapStep.result.summary : "The New York City subway network."}
              />
            </div>
            {mapStep?.kind === "tool" ? (
              <div className="pointer-events-none absolute left-3 right-14 top-3 flex flex-wrap items-center gap-2">
                <span className="label rounded-sm bg-sign px-2 py-1 text-sign-ink">
                  {agentName(mapStep.agent)} · {mapStep.tool}
                </span>
                {pinned !== null ? (
                  <button
                    type="button"
                    onClick={() => setPinned(null)}
                    className="label pointer-events-auto rounded-sm border border-line bg-panel px-2 py-1 text-ink-900 shadow-lift hover:bg-sunk"
                  >
                    {at === null ? "Follow the latest step" : `Back to step ${at}`}
                  </button>
                ) : null}
              </div>
            ) : null}
            <Legend overlay={overlay} />
          </section>
          {/* Docked under the map, outside it, so the legend and the zoom controls stay clear; on phones it sits above the tabs. */}
          <PlaybackBar
            steps={timeline.steps.slice(0, ready)}
            position={at ?? ready}
            following={at === null}
            running={running}
            playing={isPlaying}
            speed={speed}
            onGo={go}
            onPlay={togglePlay}
            onSpeed={setSpeed}
            onLatest={toLatest}
          />
        </div>

        <aside ref={rail} data-scroll tabIndex={0} aria-label="Impact, plans and rider advisories" className="relative hidden min-w-0 overflow-y-auto lg:block lg:border-l lg:border-line">
          <ImpactPanel {...impactProps} />
        </aside>

        <div className="min-w-0 lg:hidden">
          <div
            role="tablist"
            aria-label="Run details"
            className="sticky top-12 z-10 grid grid-cols-3 border-b border-line bg-paper"
            onKeyDown={(e) => {
              // The tabs pattern: arrows move between tabs, Home and End jump to the ends.
              const order = ["trace", "impact", "riders"] as const;
              const at = order.indexOf(tab);
              const next =
                e.key === "ArrowRight" ? order[(at + 1) % 3] : e.key === "ArrowLeft" ? order[(at + 2) % 3] : e.key === "Home" ? order[0] : e.key === "End" ? order[2] : null;
              if (!next) return;
              e.preventDefault();
              setTab(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
          >
            {(["trace", "impact", "riders"] as const).map((t) => (
              <button
                key={t}
                id={`tab-${t}`}
                role="tab"
                type="button"
                aria-selected={tab === t}
                aria-controls="run-tabpanel"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                className={`label py-3 transition-colors duration-150 ${tab === t ? "border-b-2 border-ink-900 text-ink-900" : "text-ink-500"}`}
              >
                {t === "trace" ? "Trace" : t === "impact" ? "Impact" : "Riders"}
              </button>
            ))}
          </div>
          <div role="tabpanel" id="run-tabpanel" aria-labelledby={`tab-${tab}`} className={tab === "trace" ? "p-4" : ""}>
            {tab === "trace" ? tracePane : <ImpactPanel {...impactProps} part={tab === "impact" ? "impact" : "riders"} />}
          </div>
        </div>
      </div>
    </div>
  );
}
