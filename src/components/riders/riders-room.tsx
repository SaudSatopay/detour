"use client";

import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent/catalog";
import { readNdjson } from "@/lib/client/ndjson";
import type { SandboxState } from "@/lib/graph/state";
import type { RouteAnswer } from "@/lib/graph/tools/riders";
import type { ToolResult } from "@/lib/graph/tools/types";
import { CypherBlock } from "../cypher-block";
import { BriefLines, OutcomeChip, RouteTag } from "../control/bits";
import { initialRun, reduce, type ToolStep } from "../control/run-state";
import { MapPanel } from "../map/map-panel";
import type { MapOverlay } from "../map/subway-map";
import { useMapModel } from "../map/use-map-model";
import { useSandbox } from "../use-sandbox";

type RouteResult = ToolResult<{ rider: string | null; answer: RouteAnswer | null; alternatives: number }>;
type Rider = SandboxState["riders"][number];

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
// The seeded accessibility fact the demo flips: the L platform elevator at Myrtle-Wyckoff Avs.
const ELEVATOR = { station: "630", route: "L", prefix: "Elevator to the L platform at Myrtle-Wyckoff" };

async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as T & { error?: string };
    return res.ok ? { ok: true, data: json } : { ok: false, error: json.error ?? `The server answered ${res.status}.` };
  } catch {
    return { ok: false, error: "The server did not answer. Try again." };
  }
}

function Legs({ answer, colorOf, nameOf }: { answer: RouteAnswer; colorOf: (r: string) => string; nameOf: (id: string) => string }) {
  return (
    <ol className="flex flex-col gap-1.5">
      {answer.legs.map((l, i) => (
        <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
          {l.kind === "RUNS" && l.route ? <RouteTag route={l.route} color={colorOf(l.route)} /> : <span className="label w-9 text-ink-700">{l.kind === "BUS" ? "Bus" : "Walk"}</span>}
          <span className="text-ink-900">
            {nameOf(l.from)} → {nameOf(l.to)}
          </span>
          <span className="tabular ml-auto font-mono text-xs text-ink-500">
            {l.kind === "RUNS" ? `${l.stops} stop${l.stops === 1 ? "" : "s"} · ` : ""}
            {Math.round(l.minutes)} min
          </span>
        </li>
      ))}
    </ol>
  );
}

function RouteCard({ title, result, colorOf, nameOf, tone }: { title: string; result: RouteResult; colorOf: (r: string) => string; nameOf: (id: string) => string; tone: "now" | "before" }) {
  const a = result.data?.answer;
  return (
    <article className={`flex flex-col gap-2 rounded-md border p-3 ${tone === "now" ? "border-ink-900 bg-panel" : "border-line bg-sunk/50"}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="label text-ink-900">{title}</h3>
        <OutcomeChip outcome={result.outcome} />
        {a ? (
          <span className="tabular ml-auto font-mono text-sm text-ink-900">
            {Math.round(a.minutes)} min · {a.transfers} transfer{a.transfers === 1 ? "" : "s"}
          </span>
        ) : null}
      </header>
      {a ? <Legs answer={a} colorOf={colorOf} nameOf={nameOf} /> : <p className="text-sm text-ink-700">{result.summary}</p>}
      {a && /memory says/.test(result.summary) ? <p className="rounded-sm bg-signal-wash px-2 py-1.5 text-xs text-ink-900">{result.summary.slice(result.summary.indexOf("Skipped"))}</p> : null}
      {tone === "now" && result.trace.length ? (
        <details className="group">
          <summary className="label cursor-pointer list-none text-ink-500 hover:text-ink-900">
            <span aria-hidden="true" className="mr-1 inline-block transition-transform duration-150 group-open:rotate-90">
              ›
            </span>
            Cypher · {result.trace.length}
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {result.trace.map((t, i) => (
              <div key={i} className="min-w-0">
                <p className="text-xs text-ink-500">
                  <span className="font-semibold text-ink-900">{t.label}</span> · {t.ms} ms · {t.rows} rows
                </p>
                <CypherBlock code={t.cypher} className="mt-1" />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

export function RidersRoom({ initialRider }: { initialRider: string | null }) {
  const { state, error, loading, reload } = useSandbox();
  const { model } = useMapModel();
  const nameOf = useCallback((id: string) => model?.stations.get(id)?.name ?? id, [model]);
  const colorOf = useCallback((r: string) => model?.routes.get(r)?.color ?? "", [model]);
  const [selected, setSelected] = useState(initialRider ?? "aisha");
  const [routes, setRoutes] = useState<Record<string, { now: RouteResult; before?: RouteResult }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [memoryWrite, setMemoryWrite] = useState<ToolResult | null>(null);
  const [question, setQuestion] = useState("");
  const [ask, dispatch] = useReducer(reduce, initialRun);
  const askAbort = useRef<AbortController | null>(null);

  const recorded = Boolean(state?.recorded);
  const riders = state?.riders ?? [];
  const rider: Rider | undefined = riders.find((r) => r.id === selected) ?? riders[0];
  const closed = useMemo(() => new Set(state?.incident?.closedEids ?? []), [state?.incident?.closedEids]);
  const published = state?.plans.find((p) => p.status === "published") ?? null;
  const elevatorFact = state?.findings.find((f) => (f.validToMs === null || f.validToMs === undefined) && f.text.startsWith(ELEVATOR.prefix)) ?? null;
  const elevatorOut = elevatorFact?.kind === "accessibility";

  const routeNow = useCallback(
    async (id: string, keepPrevious: boolean) => {
      setBusy(`route:${id}`);
      setProblem(null);
      const res = await postJson<RouteResult>("/api/rider/route", { riderId: id });
      setBusy(null);
      if (!res.ok) return setProblem(res.error);
      setRoutes((all) => ({ ...all, [id]: { now: res.data, before: keepPrevious ? all[id]?.now : undefined } }));
    },
    [],
  );

  const flipElevator = useCallback(async () => {
    setBusy("elevator");
    setProblem(null);
    const res = await postJson<ToolResult>("/api/memory", { action: "elevator", station: ELEVATOR.station, route: ELEVATOR.route, working: elevatorOut });
    setBusy(null);
    if (!res.ok) return setProblem(res.error);
    setMemoryWrite(res.data);
    reload();
    if (rider) await routeNow(rider.id, true);
  }, [elevatorOut, reload, rider, routeNow]);

  const askDesk = useCallback(async () => {
    const q = question.trim();
    if (q.length < 2) return;
    askAbort.current?.abort();
    const ctrl = new AbortController();
    askAbort.current = ctrl;
    dispatch({ type: "start", stage: "control" });
    const context = rider ? ` (Asked about remembered rider ${rider.name}, rider_id "${rider.id}".)` : "";
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "ask", message: `${q}${context}`.slice(0, 600) }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return dispatch({ type: "fail", message: body.error ?? `The server answered ${res.status}.` });
      }
      await readNdjson<AgentEvent>(res, (event) => dispatch({ type: "event", event }));
      dispatch({ type: "settle" });
    } catch {
      if (!ctrl.signal.aborted) dispatch({ type: "fail", message: "The connection dropped. Ask again." });
    }
  }, [question, rider]);

  const current = rider ? routes[rider.id] : undefined;
  const askPath = [...ask.items].reverse().find((i): i is ToolStep => i.kind === "tool" && Boolean(i.result?.highlight?.path));
  const overlay: MapOverlay = useMemo(() => {
    const h = askPath?.result?.highlight ?? current?.now.highlight;
    return {
      closedEids: state?.incident?.closedEids,
      shuttles: published?.legs.map((l) => ({ from: l.from, to: l.to, busesPerHour: l.busesPerHour, capacity: l.capacity })),
      path: h?.path,
      pathEids: h?.pathEids,
      stations: h?.stations ?? (rider ? [rider.from, rider.to] : undefined),
    };
  }, [askPath, current, published, rider, state?.incident?.closedEids]);
  const focus = overlay.path?.length ? overlay.path : rider ? [rider.from, rider.to, ...(rider.usualStations ?? [])] : undefined;

  if (loading) return <div className="h-[calc(100dvh-3rem)] animate-pulse bg-sunk" aria-busy="true" aria-label="Loading riders" />;
  if (!state) {
    return (
      <div className="mx-auto flex max-w-[60ch] flex-col gap-3 px-4 py-16">
        <h1 className="font-display text-3xl font-bold">Riders could not load.</h1>
        <p className="text-ink-700">{error}</p>
        <button type="button" onClick={reload} className="w-fit rounded-md bg-ink-900 px-4 py-2 font-display text-lg font-semibold text-paper">
          Try again
        </button>
      </div>
    );
  }

  const hit = (r: Rider) => r.usualEids?.some((e) => closed.has(e));

  return (
    // A different element from the loading placeholder, so React mounts it fresh (no layout shift).
    <article className="flex flex-col lg:h-[calc(100dvh-3rem)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2">
        <h1 className="font-display text-xl font-bold tracking-wide">Riders</h1>
        <p className="min-w-0 flex-1 text-xs text-ink-500">
          {recorded
            ? "The graph database is unreachable, so this is the state recorded after the L closure run; routing and memory writes are paused."
            : state.incident
              ? `${state.incident.id} is open in your sandbox (${state.incident.routes.join("/")} closed)${published ? `; ${published.id} is published` : ""}. Routes below account for it.`
              : "No closure is open in your sandbox, so these are everyday routes. Break a line in the control room to see them change."}
        </p>
      </div>
      <div className="grid flex-1 lg:min-h-0 lg:grid-cols-[minmax(260px,300px)_minmax(0,1fr)_minmax(340px,420px)]">
        <nav aria-label="Remembered riders" className="min-w-0 border-b border-line lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <ul className="flex gap-2 overflow-x-auto p-3 lg:flex-col lg:overflow-x-visible">
            {riders.map((r) => {
              const active = r.id === rider?.id;
              return (
                <li key={r.id} className="shrink-0 lg:shrink">
                  <button
                    type="button"
                    onClick={() => setSelected(r.id)}
                    aria-current={active ? "true" : undefined}
                    className={`flex w-56 flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors duration-150 lg:w-full ${
                      active ? "border-ink-900 bg-panel" : "border-line hover:border-line-strong"
                    }`}
                  >
                    <span className="flex w-full items-baseline gap-2">
                      <span className="font-display text-lg font-semibold leading-tight">{r.name}</span>
                      {hit(r) ? <span className="label ml-auto text-crit">Hit</span> : null}
                      {r.advisory ? <span className="label text-signal-strong">Advised</span> : null}
                    </span>
                    <span className="text-xs text-ink-500">{r.persona}</span>
                    <span className="truncate text-xs text-ink-700">
                      {nameOf(r.from)} → {nameOf(r.to)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <section aria-label="Route map" className="relative h-[46vh] min-w-0 border-b border-line lg:h-auto lg:border-b-0">
          <div className="absolute inset-0">
            <MapPanel overlay={overlay} focus={focus} className="h-full w-full" label={rider ? `${rider.name}'s trip from ${nameOf(rider.from)} to ${nameOf(rider.to)}.` : "Subway map"} />
          </div>
        </section>

        {rider ? (
          <aside className="flex min-w-0 flex-col gap-5 p-4 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-line">
            <header className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-display text-3xl font-bold leading-none">{rider.name}</h2>
                <span className="text-sm text-ink-500">{rider.persona}</span>
                {rider.stepFree ? <span className="label rounded-sm border border-line-strong px-1.5 text-ink-900">Step-free</span> : null}
              </div>
              <p className="text-sm text-ink-700">
                Usually {nameOf(rider.from)} → {nameOf(rider.to)}, leaves {rider.departs}, about {Math.round(rider.usualMinutes)} min.
              </p>
              {rider.preferences.length ? (
                <ul className="flex flex-wrap gap-1.5 pt-1">
                  {rider.preferences.map((p) => (
                    <li key={`${p.key}${p.value}`} className="rounded-sm bg-sunk px-2 py-0.5 text-xs text-ink-700">
                      {p.key} {p.value} <span className="text-ink-500">· since {day(p.sinceMs)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </header>

            {rider.advisory ? (
              <section className="flex flex-col gap-1.5 rounded-md border border-line bg-panel p-3">
                <h3 className="label text-ink-500">Latest advisory from the rider desk</h3>
                <p className="text-sm text-ink-900">{rider.advisory.text}</p>
                <p className="text-xs text-ink-500">{new Date(rider.advisory.atMs).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</p>
              </section>
            ) : null}

            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void routeNow(rider.id, false)}
                  disabled={recorded || busy !== null}
                  className="shrink-0 whitespace-nowrap rounded-md bg-ink-900 px-4 py-2 font-display text-lg font-semibold tracking-wide text-paper transition-transform duration-150 ease-out enabled:hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === `route:${rider.id}` ? "Routing…" : `Route ${rider.name} now`}
                </button>
                <span className="text-xs text-ink-500">Shortest path on the platform graph, with any closure, shuttle and remembered outage.</span>
              </div>
              {current ? (
                <div className="flex flex-col gap-2">
                  <RouteCard title="Now" result={current.now} colorOf={colorOf} nameOf={nameOf} tone="now" />
                  {current.before ? <RouteCard title="Before the memory changed" result={current.before} colorOf={colorOf} nameOf={nameOf} tone="before" /> : null}
                </div>
              ) : null}
            </section>

            {rider.id === "aisha" && elevatorFact ? (
              <section className="flex flex-col gap-2 rounded-md border border-line p-3">
                <h3 className="label text-ink-900">What memory says about her station</h3>
                <p className="text-sm text-ink-700">
                  {elevatorFact.text} <span className="text-ink-500">Known since {day(elevatorFact.validFromMs)}.</span>
                </p>
                <p className="text-xs text-ink-500">
                  Report a change and the rider desk supersedes the fact: the old one gets an end date and stays in the graph, and the next route reads
                  only facts that are still true.
                </p>
                <button
                  type="button"
                  onClick={() => void flipElevator()}
                  disabled={recorded || busy !== null}
                  className="w-fit rounded-md border border-ink-900 px-3 py-1.5 font-display text-base font-semibold text-ink-900 transition-colors duration-150 enabled:hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === "elevator" ? "Writing to memory…" : elevatorOut ? "Report the L elevator fixed" : "Report it out of service again"}
                </button>
                {memoryWrite ? <p className="text-xs text-ink-700">{memoryWrite.summary}</p> : null}
              </section>
            ) : null}

            {problem ? (
              <p role="alert" className="rounded-md border border-crit bg-crit-wash px-3 py-2 text-sm text-ink-900">
                {problem}
              </p>
            ) : null}

            <section className="flex flex-col gap-2 border-t border-line pt-4">
              <h3 className="label text-ink-900">Ask the rider desk</h3>
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void askDesk();
                }}
              >
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder={`How does ${rider.name} get to work today?`}
                  className="resize-none rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:border-signal"
                />
                <button
                  type="submit"
                  disabled={ask.status === "running" || question.trim().length < 2}
                  className="w-fit rounded-md border border-line-strong px-3 py-1.5 font-display text-base font-semibold text-ink-900 transition-colors duration-150 enabled:hover:bg-sunk disabled:opacity-50"
                >
                  {ask.status === "running" ? "Asking…" : "Ask"}
                </button>
              </form>
              <div className="flex flex-col gap-2" aria-live="polite">
                {ask.items.map((it, i) =>
                  it.kind === "say" ? (
                    <div key={i} className="text-sm text-ink-900">
                      <BriefLines text={it.text} />
                    </div>
                  ) : it.kind === "tool" ? (
                    <p key={i} className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                      <code className="font-mono">{it.tool}</code>
                      {it.result ? <OutcomeChip outcome={it.result.outcome} /> : <span>running…</span>}
                      {it.result ? <span className="w-full text-ink-700">{it.result.summary}</span> : null}
                    </p>
                  ) : it.kind === "error" ? (
                    <p key={i} role="alert" className="rounded-md bg-warn-wash px-3 py-2 text-sm text-ink-900">
                      {it.message}
                    </p>
                  ) : null,
                )}
              </div>
            </section>
          </aside>
        ) : null}
      </div>
    </article>
  );
}
