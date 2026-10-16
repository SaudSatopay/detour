"use client";

import type { CapacityData } from "@/lib/graph/tools/capacity";
import type { ImpactData } from "@/lib/graph/tools/impact";
import type { Incident } from "@/lib/graph/tools/incident";
import { fmt, RouteTag, Stat } from "./bits";
import type { PlanCard, RiderCard } from "./run-state";

type Lookup = (id: string) => string;

function Section({ title, children, aside, marker }: { title: string; children: React.ReactNode; aside?: React.ReactNode; marker?: string }) {
  return (
    <section data-riders={marker === "riders" ? "" : undefined} className="flex scroll-mt-2 flex-col gap-3 border-b border-line px-4 py-4 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <h2 className="label text-ink-900">{title}</h2>
        {aside ? <div className="ml-auto text-xs text-ink-500">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Bar({ value, max, tone }: { value: number; max: number; tone: "crit" | "signal" | "ink" }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  const color = tone === "crit" ? "bg-crit" : tone === "signal" ? "bg-signal" : "bg-ink-500";
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-sunk" aria-hidden="true">
      <span className={`block h-full rounded-full ${color} transition-[width] duration-500 ease-out`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function WhoItHits({ impact }: { impact: ImpactData }) {
  const rows = impact.byDepth.filter((d) => d.depth <= 6);
  const max = Math.max(1, impact.totalRiders);
  const d1 = impact.byDepth.find((d) => d.depth === 1)?.riders ?? 0;
  const d4 = impact.byDepth.find((d) => d.depth === 4)?.riders ?? 0;
  return (
    <Section title="Who it hits" aside={`${fmt(impact.pairs)} trip pairs`}>
      <dl className="grid grid-cols-2 gap-3">
        <Stat label="Displaced" value={fmt(impact.totalRiders)} unit="/h" />
        <Stat label="Board ≤ 4 stops away" value={fmt(d4)} unit="/h" tone="crit" />
      </dl>
      <figure className="flex flex-col gap-1.5">
        <figcaption className="text-xs text-ink-500">
          Riders whose trips cross the closure, by how many stops before it they board. An alert at the closed stations reaches the first row.
        </figcaption>
        <ol className="flex flex-col gap-1">
          {rows.map((d) => (
            <li key={d.depth} className="grid grid-cols-[5.5rem_minmax(0,1fr)_4rem] items-center gap-2 text-xs">
              <span className={`tabular font-mono ${d.depth === 1 || d.depth === 4 ? "font-semibold text-ink-900" : "text-ink-500"}`}>
                {d.depth === 0 ? "in stretch" : `≤ ${d.depth} stop${d.depth === 1 ? "" : "s"}`}
              </span>
              <Bar value={d.riders} max={max} tone={d.depth === 1 || d.depth === 4 ? "crit" : "ink"} />
              <span className="tabular text-right font-mono text-ink-700">{fmt(d.riders)}</span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-ink-500">
          {fmt(d1)} within one stop; {fmt(d4 - d1)} more two to four stops out; {fmt(impact.beyondDepth)} further still.
        </p>
      </figure>
    </Section>
  );
}

function NetworkCan({ cap, nameOf, colorOf, incident }: { cap: CapacityData; nameOf: Lookup; colorOf: Lookup; incident: Incident | null }) {
  const over = cap.reroute.overloaded.slice(0, 4);
  const toward = (dir: string) => {
    const s = incident?.stretch ?? [];
    return dir === "forward" ? `toward ${nameOf(s[s.length - 1] ?? "")}` : `toward ${nameOf(s[0] ?? "")}`;
  };
  return (
    <Section title="What the network can take" aside={`${fmt(cap.displacedRiders)} riders to move`}>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink-900">If everyone takes their fastest open path</h3>
        {over.length ? (
          <ul className="flex flex-col gap-1.5">
            {over.map((o) => (
              <li key={`${o.kind}${o.id}`} className="grid grid-cols-[auto_minmax(0,1fr)_3.5rem] items-center gap-x-2 gap-y-1 text-sm">
                {o.kind === "RUNS" ? <RouteTag route={o.route} color={colorOf(o.route)} /> : <span className="label text-ink-700">Bus</span>}
                <span className="truncate text-ink-700">
                  {nameOf(o.from)} → {nameOf(o.to)}
                </span>
                <span className="tabular text-right font-mono font-semibold text-crit">{o.pct}%</span>
                <span className="col-span-3">
                  <Bar value={o.load} max={Math.max(o.load, o.capacity)} tone="crit" />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-700">Nothing new overflows: the lines riders switch to have room.</p>
        )}
        <dl className="grid grid-cols-2 gap-3 pt-1">
          <Stat label="Overflow" value={fmt(cap.reroute.overflow)} unit="/h" tone={cap.reroute.overflow ? "crit" : "ok"} />
          <Stat label="No open path" value={fmt(cap.reroute.stranded)} unit="/h" tone={cap.reroute.stranded ? "crit" : "ok"} />
        </dl>
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <h3 className="text-sm font-semibold text-ink-900">If riders are spread perfectly (max flow)</h3>
        <ul className="flex flex-col gap-2.5">
          {cap.directions.map((d) => (
            <li key={d.direction} className="flex flex-col gap-1 text-sm">
              <span className="flex items-baseline gap-2">
                <span className="text-ink-700">Riders {toward(d.direction)}</span>
                <span className="tabular ml-auto font-mono text-ink-900">
                  {fmt(d.absorbed)} / {fmt(d.required)}
                </span>
              </span>
              <Bar value={d.absorbed} max={d.required} tone="signal" />
              {d.unmet ? (
                <span className="text-xs text-crit">
                  {fmt(d.unmet)} an hour cannot move{d.cut.length ? `; bottleneck ${d.cut.slice(0, 2).map((c) => `${c.route ?? c.kind.toLowerCase()} ${nameOf(c.from)} → ${nameOf(c.to)}`).join(", ")}` : ""}
                  {d.strandedAt.length ? `; stuck at ${d.strandedAt.slice(0, 3).map((s) => nameOf(s.id)).join(", ")}` : ""}
                </span>
              ) : (
                <span className="text-xs text-ok">Everyone fits.</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function Delta({ label, before, after }: { label: string; before: number; after: number }) {
  const better = after < before;
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-ink-500">{label}</span>
      <span className="tabular ml-auto font-mono text-ink-700">{fmt(before)}</span>
      <span aria-hidden="true" className="text-ink-500">
        →
      </span>
      <span className={`tabular font-mono font-semibold ${better ? "text-ok" : after > before ? "text-crit" : "text-ink-900"}`}>{fmt(after)}</span>
    </div>
  );
}

function Plan({
  plan,
  recommended,
  published,
  busy,
  nameOf,
  onApprove,
}: {
  plan: PlanCard;
  recommended: boolean;
  published: boolean;
  busy: boolean;
  nameOf: Lookup;
  onApprove: () => void;
}) {
  return (
    <article className={`flex flex-col gap-2.5 rounded-md border p-3 ${recommended ? "border-signal bg-panel shadow-lift" : "border-line bg-panel"}`}>
      <header className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-display text-lg font-semibold leading-tight text-ink-900">{plan.kind === "steer" ? "Steer riders, no buses" : "Shuttle bridge"}</h3>
        <span className="font-mono text-xs text-ink-500">{plan.id}</span>
        {recommended ? <span className="label ml-auto rounded-sm bg-signal px-1.5 text-signal-ink">Recommended</span> : null}
      </header>
      {plan.legs.length ? (
        <ul className="flex flex-col gap-1 text-sm text-ink-700">
          {plan.legs.map((l) => (
            <li key={`${l.from}${l.to}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-ink-900">
                {nameOf(l.from)} ↔ {nameOf(l.to)}
              </span>
              <span className="tabular font-mono text-xs text-ink-500">
                {l.busesPerHour} buses/h · {fmt(l.capacity)} riders/h
              </span>
            </li>
          ))}
          <li className="tabular font-mono text-xs text-ink-500">{plan.vehicles} buses on the road</li>
        </ul>
      ) : (
        <p className="text-sm text-ink-700">No extra service. The rider desk sends each remembered rider the open route that fits them.</p>
      )}
      <div className="flex flex-col gap-1 border-t border-line pt-2">
        <Delta label="No open path" before={plan.before.stranded} after={plan.after.stranded} />
        <Delta label="Max-flow shortfall" before={plan.before.unmet} after={plan.after.unmet} />
        <Delta label="Fastest-path overflow" before={plan.before.overflow} after={plan.after.overflow} />
      </div>
      {plan.kind === "shuttle" && plan.after.overflow > plan.before.overflow ? (
        <p className="text-xs text-ink-500">Overflow rises because riders who had no path now travel and add load further on.</p>
      ) : null}
      {published ? (
        <p className="label flex items-center gap-2 text-ok">
          <span aria-hidden="true">✓</span> Published to riders
        </p>
      ) : (
        <button
          type="button"
          onClick={onApprove}
          disabled={busy}
          className={`rounded-md px-3 py-2 font-display text-base font-semibold tracking-wide transition-[transform,background-color] duration-150 ease-out enabled:hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50 ${
            recommended ? "bg-ink-900 text-paper" : "border border-line-strong text-ink-900 enabled:hover:bg-sunk"
          }`}
        >
          Approve and publish to riders
        </button>
      )}
    </article>
  );
}

function Riders({ riders, nameOf, colorOf, running }: { riders: RiderCard[]; nameOf: Lookup; colorOf: Lookup; running: boolean }) {
  return (
    <Section title="Rider advisories" marker="riders" aside={riders.length ? `${riders.length} remembered riders hit` : undefined}>
      {riders.length ? (
        <ul className="flex flex-col gap-2.5">
          {riders.map((r) => (
            <li key={r.profile.id} className="rise flex flex-col gap-1.5 rounded-md border border-line bg-panel p-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-display text-lg font-semibold leading-tight text-ink-900">{r.profile.name}</span>
                <span className="text-xs text-ink-500">
                  {nameOf(r.profile.from)} → {nameOf(r.profile.to)}
                </span>
                {r.profile.stepFree ? <span className="label ml-auto rounded-sm border border-line-strong px-1 text-ink-900">Step-free</span> : null}
              </div>
              {r.advisory ? (
                <p className="text-sm leading-relaxed text-ink-900">{r.advisory}</p>
              ) : (
                <p className="flex items-center gap-2 text-sm text-ink-500">
                  <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-signal" />
                  Routing on the graph…
                </p>
              )}
              {r.answer ? (
                <p className="flex flex-wrap items-center gap-1 text-xs text-ink-500">
                  {r.answer.legs.map((l, i) => (
                    <span key={i} className="inline-flex items-center gap-1">
                      {i ? <span aria-hidden="true">›</span> : null}
                      {l.kind === "RUNS" && l.route ? <RouteTag route={l.route} color={colorOf(l.route)} /> : <span className="label">{l.kind === "BUS" ? "Shuttle" : "Walk"}</span>}
                    </span>
                  ))}
                  <span className="tabular ml-auto font-mono">
                    {Math.round(r.answer.minutes)} min · usually {Math.round(r.profile.usualMinutes)}
                  </span>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-500">{running ? "Finding remembered riders whose trips cross the closure…" : "Approve a plan and the rider desk writes each affected rider an advisory."}</p>
      )}
    </Section>
  );
}

export interface ImpactProps {
  incident: Incident | null;
  impact: ImpactData | null;
  capacity: CapacityData | null;
  plans: PlanCard[];
  recommended: string | null;
  published: string | null;
  riders: RiderCard[];
  stage: "control" | "desk";
  running: boolean;
  nameOf: Lookup;
  colorOf: Lookup;
  onApprove: (planId: string) => void;
  part?: "impact" | "riders" | "all";
}

/** The numbers a dispatcher decides on: who is hit, what the network can absorb, the plans, then the riders. */
export function ImpactPanel(p: ImpactProps) {
  const part = p.part ?? "all";
  const empty = !p.incident && !p.impact && !p.capacity;
  return (
    <div className="flex flex-col">
      {part !== "riders" ? (
        <>
          {p.incident ? (
            <div className="flex flex-col gap-1 border-b border-line px-4 py-3">
              <p className="label text-crit">
                {p.incident.id} · {p.incident.routes.join("/")} closed
              </p>
              <p className="text-sm text-ink-700">
                {p.incident.stretch.map(p.nameOf).join(" → ")} · {p.incident.closedEids.length} segments
              </p>
            </div>
          ) : null}
          {empty ? (
            <div className="flex flex-col gap-2 px-4 py-6">
              <p className="font-display text-xl font-semibold text-ink-900">Nothing is closed yet.</p>
              <p className="text-sm text-ink-700">
                Pick a disruption and run the controller. Its numbers land here as each tool answers: who the closure hits, what the rest of the
                network can carry, and the plans it tested.
              </p>
            </div>
          ) : null}
          {p.impact ? <WhoItHits impact={p.impact} /> : null}
          {p.capacity ? <NetworkCan cap={p.capacity} nameOf={p.nameOf} colorOf={p.colorOf} incident={p.incident} /> : null}
          {p.plans.length ? (
            <Section title="Plans tested on forked graphs" aside={`${p.plans.length} ${p.plans.length === 1 ? "plan" : "plans"}`}>
              <div className="flex flex-col gap-3">
                {[...p.plans]
                  .sort((a, b) => Number(b.id === p.recommended) - Number(a.id === p.recommended))
                  .map((plan) => (
                    <Plan
                      key={plan.id}
                      plan={plan}
                      recommended={plan.id === p.recommended}
                      published={plan.id === p.published}
                      busy={p.running || Boolean(p.published)}
                      nameOf={p.nameOf}
                      onApprove={() => p.onApprove(plan.id)}
                    />
                  ))}
              </div>
            </Section>
          ) : null}
        </>
      ) : null}
      {part !== "impact" && (p.stage === "desk" || part === "riders") ? (
        <Riders riders={p.riders} nameOf={p.nameOf} colorOf={p.colorOf} running={p.running && p.stage === "desk"} />
      ) : null}
    </div>
  );
}
