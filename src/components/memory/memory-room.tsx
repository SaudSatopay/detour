"use client";

import Link from "next/link";
import type { FindingRow } from "@/lib/graph/state";
import { TOOL_TITLE } from "@/lib/tool-titles";
import { CypherBlock } from "../cypher-block";
import { OutcomeChip } from "../control/bits";
import { agentName } from "../control/trace";
import { useSandbox } from "../use-sandbox";
import type { Outcome } from "@/lib/graph/tools/types";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const time = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const current = (f: FindingRow) => f.validToMs === null || f.validToMs === undefined;

const KIND: Record<string, string> = {
  accessibility: "Accessibility",
  capacity: "Capacity",
  crowding: "Crowding",
  observation: "Observation",
  plan: "Plan",
};

const MODEL: { from: string; rel: string; to: string; note: string }[] = [
  { from: "Agent", rel: "WROTE", to: "Finding", note: "Who learned it. Findings carry validFromMs, validToMs and a confidence." },
  { from: "Finding", rel: "ABOUT", to: "Station | Route", note: "Memory hangs off the same nodes the subway is made of, so recall is a graph match." },
  { from: "Finding", rel: "SUPERSEDES", to: "Finding", note: "A changed fact gets an end date and a successor; nothing is deleted." },
  { from: "Finding", rel: "FROM", to: "Incident", note: "Provenance: the incident a finding was learned in." },
  { from: "Agent", rel: "ACTED", to: "Episode", note: "Every tool call, with its answer shape, query count and time." },
  { from: "Episode", rel: "IN", to: "Incident", note: "Episodes group into the incident they served." },
  { from: "Shuttle", rel: "FOR", to: "Incident", note: "Planned against observed riders an hour: what plans really delivered." },
  { from: "Agent", rel: "HANDED_OFF", to: "Agent", note: "Shared state between the control desk and the rider desk, with a note." },
  { from: "Rider", rel: "PREFERS", to: "Preference", note: "Per-rider memory with its own validity window." },
  { from: "Advisory", rel: "FOR", to: "Rider", note: "What the rider desk told each rider, and when." },
  { from: "Playbook", rel: "FOR", to: "Route", note: "Procedure that worked before, with how often it was used." },
];

function Node({ label }: { label: string }) {
  return <span className="rounded-sm border border-ink-900 bg-panel px-1.5 py-0.5 font-mono text-xs text-ink-900">({label})</span>;
}

function Finding({ f, successor }: { f: FindingRow; successor?: FindingRow }) {
  const live = current(f);
  return (
    <li className={`flex flex-col gap-1.5 rounded-md border p-3 ${live ? "border-line bg-panel" : "border-line/70 bg-sunk/50"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label text-ink-500">{KIND[f.kind] ?? f.kind}</span>
        <span className="font-mono text-xs text-ink-500">{f.id}</span>
        {f.example ? <span className="label rounded-sm bg-sunk px-1.5 text-ink-500">Example</span> : null}
        <span className="tabular ml-auto font-mono text-xs text-ink-700">
          {live ? `since ${day(f.validFromMs)}` : `${day(f.validFromMs)} → ${day(f.validToMs!)}`}
        </span>
      </div>
      <p className={`text-sm ${live ? "text-ink-900" : "text-ink-700"}`}>{f.text}</p>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-500">
        {f.about.length ? <span>About {f.about.join(", ")}</span> : null}
        {f.agent ? <span>Written by {f.agent}</span> : null}
        {f.supersedes ? <span>Replaces {f.supersedes}</span> : null}
        {successor ? <span>Replaced by {successor.id}</span> : null}
      </p>
    </li>
  );
}

export function MemoryRoom({ recallQueries }: { recallQueries: { label: string; cypher: string }[] }) {
  const { state, error, loading, reload, refreshing } = useSandbox();

  if (loading) return <div className="mx-auto h-[70vh] w-full max-w-[1180px] animate-pulse bg-sunk" aria-busy="true" aria-label="Loading memory" />;
  if (!state) {
    return (
      <div className="mx-auto flex max-w-[60ch] flex-col gap-3 px-4 py-16">
        <h1 className="font-display text-3xl font-bold">Memory could not load.</h1>
        <p className="text-ink-700">{error}</p>
        <button type="button" onClick={reload} className="w-fit rounded-md bg-ink-900 px-4 py-2 font-display text-lg font-semibold text-paper">
          Try again
        </button>
      </div>
    );
  }

  const known = state.findings.filter(current);
  const closed = state.findings.filter((f) => !current(f));
  const successorOf = new Map(state.findings.filter((f) => f.supersedes).map((f) => [f.supersedes!, f]));
  const pastIncidents = state.pastIncidents ?? [];
  const playbooks = state.playbooks ?? [];
  const handoffs = state.handoffs ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-14 px-4 pb-24 pt-10 sm:px-6">
      <header className="flex max-w-[70ch] flex-col gap-4">
        <p className="label text-ink-500">Memory</p>
        <h1 className="font-display text-4xl font-bold leading-[0.98] tracking-tight sm:text-5xl">Memory is part of the graph, not a log beside it.</h1>
        <p className="text-lg text-ink-700">
          Agents read what earlier runs learned before they act, write what they find with a date and its source, and close facts that stop being
          true instead of deleting them. Everything on this page lives in your own sandbox graph{state.recorded ? "" : `, ${state.visitor.sandbox}`}.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {state.recorded ? (
            <span className="rounded-sm border border-line-strong bg-sunk px-2 py-1 text-ink-700">
              The graph database is unreachable, so this is the memory recorded after a run of the L closure.
            </span>
          ) : (
            <>
              <span className="tabular font-mono text-ink-700">
                {known.length} current facts · {closed.length} closed · {state.episodes.length} recent episodes
              </span>
              <button type="button" onClick={reload} className="label rounded-sm border border-line px-2 py-1 text-ink-700 hover:border-line-strong hover:text-ink-900">
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </>
          )}
        </div>
      </header>

      <section className="grid gap-8 lg:grid-cols-2" aria-label="Findings">
        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="font-display text-2xl font-bold">Known now</h2>
          <p className="text-sm text-ink-700">Facts with no end date. The controller recalls these for the routes it touches; rider routing skips any platform with a current outage.</p>
          <ul className="flex flex-col gap-2">
            {known.map((f) => (
              <Finding key={f.id} f={f} />
            ))}
          </ul>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="font-display text-2xl font-bold">No longer true</h2>
          <p className="text-sm text-ink-700">
            Closed facts keep their window, so an agent can answer &ldquo;was it out last week?&rdquo; as well as &ldquo;is it out now?&rdquo;. Try it on{" "}
            <Link href="/riders?rider=aisha" className="underline decoration-line-strong underline-offset-4">
              Aisha&apos;s page
            </Link>
            .
          </p>
          <ul className="flex flex-col gap-2">
            {closed.length ? closed.map((f) => <Finding key={f.id} f={f} successor={successorOf.get(f.id)} />) : <li className="text-sm text-ink-500">Nothing has been superseded yet.</li>}
          </ul>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-label="Episodes">
        <div className="flex max-w-[68ch] flex-col gap-2">
          <h2 className="font-display text-2xl font-bold">What the agents did</h2>
          <p className="text-sm text-ink-700">
            Every tool call is written back as an episode: who acted, the answer shape, how many queries it took. This is the history a later run
            or a person can audit.
          </p>
        </div>
        {state.episodes.length ? (
          <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
            {state.episodes.map((e, i) => (
              <li key={`${e.atMs}${i}`} className="grid gap-x-4 gap-y-1 px-3 py-2.5 text-sm sm:grid-cols-[9rem_10rem_minmax(0,1fr)_7rem]">
                <span className="tabular font-mono text-xs text-ink-500">{time(e.atMs)}</span>
                <span className="text-ink-900">
                  {TOOL_TITLE[e.tool] ?? e.tool}
                  <span className="block text-xs text-ink-500">{agentName(e.agent)}</span>
                </span>
                <span className="min-w-0">
                  <OutcomeChip outcome={e.outcome as Outcome} />
                  <span className="mt-1 line-clamp-2 block text-xs text-ink-700">{e.summary}</span>
                </span>
                <span className="tabular font-mono text-xs text-ink-500 sm:text-right">
                  {e.queries}q · {e.ms} ms
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-md border border-dashed border-line-strong px-4 py-6 text-sm text-ink-700">
            No episodes yet. <Link href="/control?scenario=l-canarsie&run=1" className="underline decoration-line-strong underline-offset-4">Run the controller</Link> and every step lands here.
          </p>
        )}
      </section>

      <section className="grid gap-8 lg:grid-cols-2" aria-label="Incidents, playbooks and handoffs">
        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="font-display text-2xl font-bold">What past plans delivered</h2>
          <p className="text-sm text-ink-700">Planned against observed shuttle riders. The controller sizes new bus plans by the worst ratio it remembers for the routes.</p>
          {!pastIncidents.length ? <p className="text-sm text-ink-500">No past incidents in this graph yet.</p> : null}
          <ul className="flex flex-col gap-2">
            {pastIncidents.map((i) => (
              <li key={i.id} className="flex flex-col gap-1.5 rounded-md border border-line bg-panel p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs text-ink-500">{i.id}</span>
                  <span className="text-sm font-semibold text-ink-900">{i.title}</span>
                  <span className="tabular ml-auto font-mono text-xs text-ink-500">{day(i.openedMs)}</span>
                </div>
                {i.shuttles.map((s) => {
                  const pct = s.planned ? Math.round((s.observed / s.planned) * 100) : 0;
                  return (
                    <div key={`${s.from}${s.to}`} className="flex flex-col gap-1 text-xs text-ink-700">
                      <span>
                        {s.from} ↔ {s.to}: planned {s.planned.toLocaleString("en-US")}, carried {s.observed.toLocaleString("en-US")} riders an hour
                        <span className={`ml-1 font-semibold ${pct < 90 ? "text-crit" : "text-ok"}`}>({pct}%)</span>
                      </span>
                      <span className="block h-1.5 overflow-hidden rounded-full bg-sunk" aria-hidden="true">
                        <span className="block h-full rounded-full bg-signal" style={{ width: `${Math.min(100, pct)}%` }} />
                      </span>
                    </div>
                  );
                })}
                {!i.shuttles.length ? <p className="text-xs text-ink-500">No shuttles recorded.</p> : null}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h2 className="font-display text-2xl font-bold">Playbooks</h2>
            {!playbooks.length ? <p className="text-sm text-ink-500">No playbooks in this graph yet.</p> : null}
            <ul className="flex flex-col gap-2">
              {playbooks.map((p) => (
                <li key={p.id} className="flex flex-col gap-1.5 rounded-md border border-line bg-panel p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-semibold text-ink-900">{p.title}</span>
                    <span className="tabular ml-auto font-mono text-xs text-ink-500">
                      used {p.uses}× · last {day(p.lastUsedMs)}
                    </span>
                  </div>
                  <ol className="list-decimal pl-5 text-xs text-ink-700">
                    {p.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-3">
            <h2 className="font-display text-2xl font-bold">Handoffs</h2>
            {handoffs.length ? (
              <ul className="flex flex-col gap-2">
                {handoffs.map((h, i) => (
                  <li key={`${h.atMs}${i}`} className="rounded-md border border-dashed border-line-strong px-3 py-2 text-sm">
                    <span className="label text-ink-900">
                      {agentName(h.from)} → {agentName(h.to)}
                    </span>
                    <span className="tabular ml-2 font-mono text-xs text-ink-500">{time(h.atMs)}</span>
                    <p className="text-ink-700">{h.note}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-500">None yet. Approving a plan in the control room hands off to the rider desk.</p>
            )}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-label="How memory is stored">
        <div className="flex max-w-[68ch] flex-col gap-2">
          <h2 className="font-display text-2xl font-bold">How memory is stored</h2>
          <p className="text-sm text-ink-700">Eleven relationship types in the same graph as the network. Recall is a match from the stations and routes an agent is about to touch.</p>
        </div>
        <ul className="flex flex-col gap-2">
          {MODEL.map((m) => (
            <li key={`${m.from}${m.rel}${m.to}`} className="grid items-center gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
              <span className="flex flex-wrap items-center gap-1.5">
                <Node label={m.from} />
                <span className="font-mono text-xs text-ink-700">-[:{m.rel}]-&gt;</span>
                <Node label={m.to} />
              </span>
              <span className="text-ink-700">{m.note}</span>
            </li>
          ))}
        </ul>
        {recallQueries.length ? (
          <details className="group rounded-md border border-line bg-panel">
            <summary className="flex cursor-pointer list-none items-baseline gap-2 px-4 py-3 hover:bg-sunk/60">
              <span aria-hidden="true" className="inline-block text-ink-500 transition-transform duration-150 group-open:rotate-90">
                ›
              </span>
              <span className="font-display text-lg font-semibold">The recall queries</span>
            </summary>
            <div className="flex flex-col gap-3 border-t border-line px-4 py-4">
              {recallQueries.map((q) => (
                <div key={q.cypher} className="min-w-0">
                  <p className="text-xs font-semibold text-ink-900">{q.label}</p>
                  <CypherBlock code={q.cypher} className="mt-1" />
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}
