"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Scenario } from "@/lib/network/data";
import { MapPanel } from "../map/map-panel";
import { useMapModel } from "../map/use-map-model";
import { ImpactPanel } from "./impact-panel";
import { capacityOf, impactOf, incidentOf, lastDrawable, overlayAt, plansOf, recommendedPlan, ridersOf, type RunState } from "./run-state";
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

export function ControlRoom({ scenarios }: { scenarios: Scenario[] }) {
  // The page is static; the URL's ?scenario and ?run are read on the client (empty during prerender).
  const search = useSyncExternalStore(noSubscribe, () => window.location.search, () => "");
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const autoRun = params.get("run") === "1";
  const [picked, setPicked] = useState<string | null>(null);
  const [edited, setEdited] = useState<string | null>(null);
  const scenarioId = picked ?? scenarios.find((s) => s.id === params.get("scenario"))?.id ?? scenarios[0].id;
  const [pinned, setPinned] = useState<number | null>(null);
  const [tab, setTab] = useState<"trace" | "impact" | "riders">("trace");
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [resetting, setResetting] = useState(false);
  const [editing, setEditing] = useState(false);
  const { state, run, approve, clear } = useControlRun();
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
      setResetting(false);
      loadStatus();
    }
  }, [clear, loadStatus]);

  const items = state.items;
  const latestIndex = lastDrawable(items);
  const selected = pinned ?? latestIndex;
  const { overlay, focus } = useMemo(() => overlayAt(items, selected), [items, selected]);
  const selectedStep = items[selected]?.kind === "tool" ? items[selected] : null;
  const plans = useMemo(() => plansOf(items), [items]);
  const recommended = recommendedPlan(state.brief, plans);
  const riders = useMemo(() => ridersOf(state), [state]);
  const incident = incidentOf(items);
  const impactProps = {
    incident,
    impact: impactOf(items),
    capacity: capacityOf(items),
    plans,
    recommended: state.status === "running" && state.stage === "control" ? null : recommended,
    published: state.published,
    riders,
    stage: state.stage,
    running,
    nameOf,
    colorOf,
    onApprove,
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
        <span className="text-xs leading-snug text-ink-500">On your own copy of the graph. Nothing reaches riders until you approve.</span>
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
    <Trace state={state} selected={selected} onSelect={(i) => setPinned(i === latestIndex ? null : i)} />
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

        <section aria-label="Subway map" className="relative h-[58vh] min-w-0 border-b border-line bg-paper lg:h-auto lg:border-b-0">
          <div className="absolute inset-0">
            <MapPanel
              overlay={overlay}
              focus={focus.length ? focus : undefined}
              className="h-full w-full"
              label={selectedStep?.kind === "tool" && selectedStep.result ? selectedStep.result.summary : "The New York City subway network."}
            />
          </div>
          {selectedStep?.kind === "tool" ? (
            <div className="pointer-events-none absolute left-3 right-14 top-3 flex flex-wrap items-center gap-2">
              <span className="label rounded-sm bg-sign px-2 py-1 text-sign-ink">
                {agentName(selectedStep.agent)} · {selectedStep.tool}
              </span>
              {pinned !== null ? (
                <button
                  type="button"
                  onClick={() => setPinned(null)}
                  className="label pointer-events-auto rounded-sm border border-line bg-panel px-2 py-1 text-ink-900 shadow-lift hover:bg-sunk"
                >
                  Follow the latest step
                </button>
              ) : null}
            </div>
          ) : null}
          <Legend overlay={overlay} />
        </section>

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
