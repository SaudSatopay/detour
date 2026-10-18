"use client";

import { useId, useState } from "react";
import type { CapacityData } from "@/lib/graph/tools/capacity";
import type { ImpactData } from "@/lib/graph/tools/impact";
import type { Incident } from "@/lib/graph/tools/incident";
import type { ResolveData } from "@/lib/graph/tools/plan";
import { fmt, RouteTag, Stat } from "./bits";
import type { PlanCard, RiderCard } from "./run-state";

type Lookup = (id: string) => string;

type Closing = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string } | { kind: "done"; data: ResolveData; message: string };

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

/**
 * Ends the incident from the published plan. The dispatcher enters what each shuttle actually carried;
 * procedural memory keeps it, and the panel says what the next plan will do with it.
 */
function CloseIncident({ plan, nameOf }: { plan: PlanCard; nameOf: Lookup }) {
  const id = useId();
  const [counts, setCounts] = useState<string[]>(() => plan.legs.map(() => ""));
  const [closing, setClosing] = useState<Closing>({ kind: "idle" });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const observed: { from: string; to: string; riders: number }[] = [];
    for (const [i, leg] of plan.legs.entries()) {
      const raw = counts[i]?.replace(/[,\s]/g, "") ?? "";
      if (!raw) continue;
      const riders = Number(raw);
      if (!Number.isInteger(riders) || riders < 1 || riders > 20_000) {
        setClosing({ kind: "error", message: `Enter the riders an hour the ${nameOf(leg.from)} ↔ ${nameOf(leg.to)} shuttle carried as a whole number, like 1650, or leave it blank.` });
        return;
      }
      observed.push({ from: leg.from, to: leg.to, riders });
    }
    setClosing({ kind: "busy" });
    try {
      const res = await fetch("/api/sandbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resolve", observed }) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string; learned?: ResolveData };
      if (!res.ok || !body.ok || !body.learned) {
        setClosing({ kind: "error", message: body.error ?? body.message ?? `The server answered ${res.status}. Try again.` });
        return;
      }
      setClosing({ kind: "done", data: body.learned, message: body.message ?? "" });
    } catch {
      setClosing({ kind: "error", message: "The server did not answer. Check your connection and try again." });
    }
  };

  if (closing.kind === "done") {
    const { learned, playbooks, next, incident } = closing.data;
    return (
      <div role="status" className="flex flex-col gap-2 border-t border-line pt-2.5">
        <p className="label flex items-center gap-2 text-ok">
          <span aria-hidden="true">✓</span> Incident closed · lines reopened
        </p>
        {learned.length ? (
          <ul className="flex flex-col gap-1 text-sm text-ink-700">
            {learned.map((l) => (
              <li key={`${l.from}${l.to}`}>
                {nameOf(l.from)} ↔ {nameOf(l.to)} carried <span className="tabular font-mono text-ink-900">{fmt(l.observed)}</span> of {fmt(l.planned)} planned riders
                an hour ({pct(l.ratio)}).
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-700">{plan.legs.length ? "No shuttle counts were entered, so nothing new about buses was learned." : "This plan ran no buses, so there was nothing to learn about them."}</p>
        )}
        {next ? (
          <p className="text-sm font-semibold text-ink-900">
            The next plan will size buses at {pct(next.ratio)} of plan
            <span className="font-normal text-ink-700">
              {next.incident === incident ? ", from this shuttle." : `: a shuttle in ${next.incident} carried less, and the plan sizes for the lowest share on record.`}
            </span>
          </p>
        ) : learned.length ? (
          <p className="text-sm text-ink-700">The shuttles carried what was planned, so the next plan sizes buses at their nominal capacity.</p>
        ) : null}
        {playbooks.map((p) => (
          <p key={p.id} className="text-xs text-ink-500">
            <span className="font-mono">{p.id}</span> {p.created ? "written from this incident" : `is now revision ${p.revision}; the old steps are kept, superseded`}.
          </p>
        ))}
      </div>
    );
  }

  const busy = closing.kind === "busy";
  return (
    <form onSubmit={submit} aria-labelledby={`${id}-title`} className="flex flex-col gap-2.5 border-t border-line pt-2.5">
      <div className="flex flex-col gap-0.5">
        <h4 id={`${id}-title`} className="text-sm font-semibold text-ink-900">
          Close the incident
        </h4>
        <p className="text-xs text-ink-500">
          {plan.legs.length
            ? "Reopens the line. Enter what each shuttle carried and memory sizes the next plan from it; leave a count blank if nobody counted."
            : "Reopens the line and counts the playbook as used."}
        </p>
      </div>
      {plan.legs.map((l, i) => (
        <label key={`${l.from}${l.to}`} className="flex flex-col gap-1">
          <span className="text-sm text-ink-900">
            Riders the shuttle carried
            <span className="text-ink-500">
              {" "}
              · {nameOf(l.from)} ↔ {nameOf(l.to)}
            </span>
          </span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={counts[i] ?? ""}
            onChange={(e) => setCounts((c) => c.map((v, j) => (j === i ? e.target.value : v)))}
            disabled={busy}
            placeholder={`${fmt(l.capacity)} planned`}
            aria-describedby={`${id}-unit-${i}`}
            className="tabular w-full rounded-md border border-line bg-panel px-3 py-2 font-mono text-base text-ink-900 placeholder:text-ink-500 focus:border-signal disabled:opacity-50 sm:text-sm"
          />
          <span id={`${id}-unit-${i}`} className="text-xs text-ink-500">
            Riders an hour; {fmt(l.capacity)} planned at {l.busesPerHour} buses an hour.
          </span>
        </label>
      ))}
      {closing.kind === "error" ? (
        <p role="alert" className="text-sm text-crit">
          {closing.message}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="self-start rounded-md border border-line-strong px-3 py-2 font-display text-base font-semibold tracking-wide text-ink-900 transition-[transform,background-color] duration-150 ease-out enabled:hover:-translate-y-px enabled:hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-50 max-sm:w-full"
      >
        {busy ? "Closing…" : "Close the incident"}
      </button>
    </form>
  );
}

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

function Delta({ label, before, after, neutral = false }: { label: string; before: number; after: number; neutral?: boolean }) {
  const better = after < before;
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-ink-500">{label}</span>
      <span className="tabular ml-auto font-mono text-ink-700">{fmt(before)}</span>
      <span aria-hidden="true" className="text-ink-500">
        →
      </span>
      <span className={`tabular font-mono font-semibold ${neutral ? "text-ink-900" : better ? "text-ok" : after > before ? "text-crit" : "text-ink-900"}`}>{fmt(after)}</span>
    </div>
  );
}

/** Two plans whose riders-with-no-path and max-flow shortfall land within 1% of each other count as the same result. */
function sameResult(a: PlanCard, b: PlanCard): boolean {
  const close = (x: number, y: number, scale: number) => Math.abs(x - y) <= Math.max(5, 0.01 * scale);
  return close(a.after.stranded, b.after.stranded, a.before.stranded) && close(a.after.unmet, b.after.unmet, a.before.unmet);
}

/** Why the recommended plan wins, or what a rejected plan would cost on top of it. */
function compare(plan: PlanCard, plans: PlanCard[], recommended: string | null): string | null {
  const rec = plans.find((x) => x.id === recommended);
  if (!rec) return null;
  if (plan.id === rec.id) {
    const costlier = plans.filter((x) => x.id !== rec.id && sameResult(x, rec) && x.vehicles > rec.vehicles);
    if (!costlier.length) return null;
    const most = costlier.reduce((a, b) => (b.vehicles > a.vehicles ? b : a));
    return `Why this one: the ${most.legs.length}-leg plan reaches the same result with ${most.vehicles - rec.vehicles} more buses.`;
  }
  if (sameResult(plan, rec) && plan.vehicles > rec.vehicles) return `The same result as the recommended plan, with ${plan.vehicles - rec.vehicles} more buses.`;
  return null;
}

function Plan({
  plan,
  recommended,
  published,
  busy,
  nameOf,
  onApprove,
  comparison,
  closable,
}: {
  plan: PlanCard;
  recommended: boolean;
  published: boolean;
  busy: boolean;
  /** The published plan of the live run (not a step played back) can close the incident. */
  closable: boolean;
  nameOf: Lookup;
  onApprove: () => void;
  comparison: string | null;
}) {
  // Riders who had no path now travel; their fastest paths add load further on. That is the cost of serving them.
  const nowTravel = plan.before.stranded - plan.after.stranded;
  const overflowFromNewRiders = plan.kind === "shuttle" && plan.after.overflow > plan.before.overflow && nowTravel > 0;
  return (
    <article data-recommended={recommended ? "" : undefined} className={`flex flex-col gap-2.5 rounded-md border p-3 ${recommended ? "border-signal bg-panel shadow-lift" : "border-line bg-panel"}`}>
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="label w-full text-ink-500">
          {plan.kind === "steer" ? "Steer riders" : `Shuttle bridge${plan.legs.length > 1 ? `, ${plan.legs.length} legs` : ""}`} · <span className="font-mono normal-case tracking-normal">{plan.id}</span>
        </span>
        {/* Named by its bridges, so two plans never share a heading. */}
        <h3 className="font-display text-lg font-semibold leading-tight text-ink-900">
          {plan.kind === "steer" ? "No extra buses" : plan.legs.map((l) => `${nameOf(l.from)} ↔ ${nameOf(l.to)}`).join(" + ")}
        </h3>
        {recommended ? <span className="label ml-auto rounded-sm bg-signal-strong px-1.5 text-signal-ink">Recommended</span> : null}
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
        <Delta label="Fastest-path overflow" before={plan.before.overflow} after={plan.after.overflow} neutral={overflowFromNewRiders} />
      </div>
      {overflowFromNewRiders ? (
        <p className="text-xs text-ink-500">
          Overflow rises because {fmt(nowTravel)} riders who had no path can now travel. Once published, the rider desk routes riders around the
          segments still over capacity wherever a reasonable alternative exists.
        </p>
      ) : null}
      {comparison ? <p className="text-sm font-semibold text-ink-900">{comparison}</p> : null}
      {published ? (
        <>
          <p className="label flex items-center gap-2 text-ok">
            <span aria-hidden="true">✓</span> Published to riders
          </p>
          {closable ? <CloseIncident plan={plan} nameOf={nameOf} /> : null}
        </>
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

interface ImpactProps {
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
                      comparison={compare(plan, p.plans, p.recommended)}
                      closable={!p.running}
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
