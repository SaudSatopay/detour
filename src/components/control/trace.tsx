"use client";

import { useEffect, useRef } from "react";
import { CypherBlock } from "@/components/cypher-block";
import { TOOL_TITLE } from "@/lib/tool-titles";
import { BriefLines, OutcomeChip } from "./bits";
import type { Item, RunState, ToolStep } from "./run-state";


export const agentName = (agent: string) =>
  agent === "controller" ? "Controller" : agent === "rider-desk" ? "Rider desk" : agent.startsWith("rider:") ? `Rider agent · ${agent.slice(6)}` : agent;

function StepCard({ step, n, active, onSelect }: { step: ToolStep; n: number; active: boolean; onSelect: () => void }) {
  const r = step.result;
  const ms = r ? Math.round(r.trace.reduce((s, t) => s + t.ms, 0)) : 0;
  const drawable = Boolean(r?.highlight);
  return (
    <article className={`rise rounded-md border bg-panel transition-colors duration-150 ${active ? "border-signal shadow-lift" : "border-line"}`}>
      <button
        type="button"
        onClick={onSelect}
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
            <span className="mt-1.5 block text-sm leading-relaxed text-ink-700">{r.summary}</span>
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
        <details className="group border-t border-line">
          <summary className="label flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-ink-500 hover:text-ink-900">
            <span aria-hidden="true" className="inline-block transition-transform duration-150 group-open:rotate-90">
              ›
            </span>
            Cypher · {r.trace.length}
          </summary>
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
        </details>
      ) : null}
    </article>
  );
}

function Say({ agent, text }: { agent: string; text: string }) {
  const paras = text
    .replace(/\*\*/g, "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) return null;
  return (
    <div className="rise flex flex-col gap-1.5 px-1">
      <span className="label text-signal-strong">{agentName(agent)}</span>
      {paras.map((p, i) => (
        <p key={i} className="whitespace-pre-line text-sm leading-relaxed text-ink-700">
          {p}
        </p>
      ))}
    </div>
  );
}

function Row({ item, index, n, selected, onSelect }: { item: Item; index: number; n: number; selected: number; onSelect: (i: number) => void }) {
  switch (item.kind) {
    case "say":
      return <Say agent={item.agent} text={item.text} />;
    case "tool":
      return <StepCard step={item} n={n} active={selected === index} onSelect={() => onSelect(index)} />;
    case "handoff":
      return (
        <div className="rise flex flex-col gap-1 rounded-md border border-dashed border-line-strong px-3 py-2">
          <span className="label text-ink-900">
            Handoff · {agentName(item.from)} → {agentName(item.to)}
          </span>
          <span className="text-sm text-ink-700">{item.note}</span>
        </div>
      );
    case "approval":
      return (
        <div className="rise flex items-center gap-2 rounded-md bg-sign px-3 py-2 text-sign-ink">
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

/** The agents' work in order: what they said, every tool call with its answer shape, and the Cypher behind it. */
export function Trace({ state, selected, onSelect }: { state: RunState; selected: number; onSelect: (i: number) => void }) {
  const end = useRef<HTMLDivElement>(null);
  const count = state.items.length;
  useEffect(() => {
    const el = end.current;
    const scroller = el?.closest("[data-scroll]");
    if (!el || !scroller) return;
    const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 240;
    if (near) el.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [count, state.brief]);

  let n = 0;
  return (
    <div className="flex flex-col gap-3" aria-live="polite" aria-busy={state.status === "running"}>
      {state.items.map((item, i) => {
        if (item.kind === "tool") n++;
        return <Row key={i} item={item} index={i} n={n} selected={selected} onSelect={onSelect} />;
      })}
      {state.status === "running" ? (
        <p className="flex items-center gap-2 px-1 text-sm text-ink-500">
          <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-signal" />
          {state.stage === "desk" ? "The rider desk is routing riders…" : "The controller is working…"}
        </p>
      ) : null}
      {state.brief ? (
        <section className="rise overflow-hidden rounded-md border border-line bg-panel">
          <h3 className="sign-band label px-3 py-1.5">Brief for the dispatcher</h3>
          <div className="p-3">
            <BriefLines text={state.brief} />
          </div>
        </section>
      ) : null}
      <div ref={end} />
    </div>
  );
}
