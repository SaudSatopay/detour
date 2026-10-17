"use client";

import { memo, useEffect, useRef, useState } from "react";
import { CypherBlock } from "@/components/cypher-block";
import { TOOL_TITLE } from "@/lib/tool-titles";
import { BriefLines, OutcomeChip } from "./bits";
import type { Item, RunState, ToolStep } from "./run-state";


/** Station ids like "[120]" are there for the agents, which pass them to the next tool; people read names. */
const forPeople = (text: string) => text.replace(/ \[\d{1,4}\]/g, "");

export const agentName = (agent: string) =>
  agent === "controller" ? "Controller" : agent === "rider-desk" ? "Rider desk" : agent.startsWith("rider:") ? `Rider agent · ${agent.slice(6)}` : agent;

/*
 * Memoized: a new event re-renders only the steps it changed. The Cypher list renders only while its
 * disclosure is open, so a run with a few hundred queries does not keep thousands of spans in the tree.
 */
const StepCard = memo(function StepCard({
  step,
  n,
  index,
  active,
  onSelect,
  enter,
}: {
  step: ToolStep;
  n: number;
  index: number;
  active: boolean;
  onSelect: (index: number) => void;
  enter: string;
}) {
  const r = step.result;
  const [showCypher, setShowCypher] = useState(false);
  const ms = r ? Math.round(r.trace.reduce((s, t) => s + t.ms, 0)) : 0;
  const drawable = Boolean(r?.highlight);
  return (
    <article data-step={n} className={`${enter} rounded-md border bg-panel transition-colors duration-150 ${active ? "border-signal shadow-lift" : "border-line"}`}>
      <button
        type="button"
        onClick={() => onSelect(index)}
        disabled={!drawable}
        aria-pressed={drawable ? active : undefined}
        className="block w-full p-3 text-left enabled:cursor-pointer enabled:hover:bg-sunk/60"
      >
        <span className="flex items-baseline gap-2">
          <span className="tabular font-mono text-xs text-ink-500">{String(n).padStart(2, "0")}</span>
          <span className="font-display text-base font-semibold leading-tight text-ink-900">{TOOL_TITLE[step.tool] ?? step.tool}</span>
          {step.agent !== "controller" ? <span className="label text-ink-500">{agentName(step.agent)}</span> : null}
          <code className="ml-auto truncate font-mono text-xs text-ink-500">{step.tool}</code>
        </span>
        {r ? (
          <>
            <span className="mt-1.5 flex flex-wrap items-center gap-2">
              <OutcomeChip outcome={r.outcome} />
              <span className="tabular font-mono text-xs text-ink-500">
                {r.trace.length} {r.trace.length === 1 ? "query" : "queries"} · {ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}
              </span>
              {drawable ? <span className="label ml-auto text-signal-strong">{active ? "On the map" : "Show on map"}</span> : null}
            </span>
            {r.summary.includes(" | ") ? (
              // Memory recalls several facts; one per line (spans: a button may only hold phrasing content).
              <span className="mt-1.5 flex flex-col gap-1 text-sm leading-relaxed text-ink-700">
                {forPeople(r.summary).split(" | ").map((fact) => (
                  <span key={fact} className="block border-l-2 border-line pl-2">
                    {fact}
                  </span>
                ))}
              </span>
            ) : (
              <span className="mt-1.5 block text-sm leading-relaxed text-ink-700">{forPeople(r.summary)}</span>
            )}
          </>
        ) : step.error ? (
          <span className="mt-1.5 block text-sm text-crit">Failed: {step.error}</span>
        ) : (
          <span className="mt-1.5 flex items-center gap-2 text-sm text-ink-500">
            <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-signal" />
            Running on the graph…
          </span>
        )}
      </button>
      {r?.trace.length ? (
        <details className="group border-t border-line" onToggle={(e) => setShowCypher(e.currentTarget.open)}>
          <summary className="label flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-ink-500 hover:text-ink-900">
            <span aria-hidden="true" className="inline-block transition-transform duration-150 group-open:rotate-90">
              ›
            </span>
            Cypher · {r.trace.length}
          </summary>
          {showCypher ? (
          <ol className="flex flex-col gap-3 px-3 pb-3">
            {r.trace.map((t, j) => (
              <li key={j} className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
                  <span className="font-semibold text-ink-900">{t.label}</span>
                  <span className="truncate font-mono">{t.graph}</span>
                  <span className="tabular font-mono">
                    {t.ms} ms · {t.rows} {t.rows === 1 ? "row" : "rows"}
                  </span>
                </p>
                <CypherBlock code={t.cypher} className="mt-1" />
              </li>
            ))}
          </ol>
          ) : null}
        </details>
      ) : null}
    </article>
  );
});

function Say({ agent, text, enter }: { agent: string; text: string; enter: string }) {
  const paras = text
    .replace(/\*\*/g, "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) return null;
  return (
    <div className={`${enter} flex flex-col gap-1.5 px-1`}>
      <span className="label text-signal-strong">{agentName(agent)}</span>
      {paras.map((p, i) => (
        <p key={i} className="whitespace-pre-line text-sm leading-relaxed text-ink-700">
          {p}
        </p>
      ))}
    </div>
  );
}

function Row({ item, index, n, selected, onSelect, enter }: { item: Item; index: number; n: number; selected: number; onSelect: (i: number) => void; enter: string }) {
  switch (item.kind) {
    case "say":
      return <Say agent={item.agent} text={item.text} enter={enter} />;
    case "tool":
      return <StepCard step={item} n={n} index={index} active={selected === index} onSelect={onSelect} enter={enter} />;
    case "handoff":
      return (
        <div className={`${enter} flex flex-col gap-1 rounded-md border border-dashed border-line-strong px-3 py-2`}>
          <span className="label text-ink-900">
            Handoff · {agentName(item.from)} → {agentName(item.to)}
          </span>
          <span className="text-sm text-ink-700">{item.note}</span>
        </div>
      );
    case "approval":
      return (
        <div className={`${enter} flex items-center gap-2 rounded-md bg-sign px-3 py-2 text-sign-ink`}>
          <span className="label">Dispatcher approved</span>
          <span className="font-mono text-sm">{item.planId}</span>
        </div>
      );
    case "error":
      return (
        <div role="alert" className="rounded-md border border-crit bg-crit-wash px-3 py-2 text-sm text-ink-900">
          <span className="label mr-2 text-crit">Stopped</span>
          {item.message}
        </div>
      );
  }
}

/**
 * The agents' work in order: what they said, every tool call with its answer shape, and the Cypher behind it.
 * `live` is false while playback shows an earlier step: no running line, no announcements, no entrances.
 */
export function Trace({
  state,
  selected,
  onSelect,
  onJumpToPlan,
  live = true,
}: {
  state: RunState;
  selected: number;
  onSelect: (i: number) => void;
  onJumpToPlan?: () => void;
  live?: boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  const count = state.items.length;
  useEffect(() => {
    const el = end.current;
    const scroller = el?.closest("[data-scroll]");
    if (!el || !scroller) return;
    const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 240;
    if (near) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [count, state.brief]);

  // Only items that arrive while the trace is on screen get the entrance; a remount (a phone tab switch) shows the rest at rest.
  const [firstCount] = useState(state.items.length);
  let n = 0;
  return (
    <div className="flex flex-col gap-3" aria-live={live ? "polite" : "off"} aria-busy={live && state.status === "running"}>
      {state.items.map((item, i) => {
        if (item.kind === "tool") n++;
        return <Row key={i} item={item} index={i} n={n} selected={selected} onSelect={onSelect} enter={i < firstCount || !live ? "" : "rise"} />;
      })}
      {live && state.status === "running" ? (
        <p className="flex items-center gap-2 px-1 text-sm text-ink-500">
          <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-signal" />
          {state.stage === "desk" ? "The rider desk is routing riders…" : "The controller is working…"}
        </p>
      ) : null}
      {state.brief ? (
        <section className="rise overflow-hidden rounded-md border border-line bg-panel">
          <h3 className="sign-band label px-3 py-1.5">Brief for the dispatcher</h3>
          <div className="flex flex-col gap-3 p-3">
            <BriefLines text={state.brief} />
            {onJumpToPlan && state.stage === "control" && state.status === "done" ? (
              <button
                type="button"
                onClick={onJumpToPlan}
                className="label w-fit rounded-sm border border-ink-900 px-2.5 py-1.5 text-ink-900 transition-colors duration-150 hover:bg-sunk"
              >
                Go to the recommended plan
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      <div ref={end} />
    </div>
  );
}
