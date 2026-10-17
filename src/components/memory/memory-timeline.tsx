"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { factName, formatDay, layoutTimeline, TIMELINE, type TimelineFact, type TimelineIncident, type TimelineRow } from "@/lib/memory-timeline";

export const KIND: Record<string, string> = {
  accessibility: "Accessibility",
  capacity: "Capacity",
  crowding: "Crowding",
  observation: "Observation",
  plan: "Plan",
};

const T = TIMELINE;

// Bars draw in once: under 600 ms in all, stroke-dashoffset and opacity only. Reduced motion skips the delay
// (globals.css already shortens the animation itself), so the final state shows at once.
const drawIn = (len: number, i: number) =>
  ({ "--len": Math.max(1, len), "--d": `${Math.min(i * 24, 150)}ms`, animationDuration: "420ms" }) as CSSProperties;
const fadeLate = { "--d": "300ms" } as CSSProperties;
const DELAY = "motion-safe:[animation-delay:var(--d)]";

function ExampleTag() {
  return <span className="label rounded-sm bg-sunk px-1.5 text-ink-500">Example</span>;
}

function Legend({ episodes, example }: { episodes: boolean; example: boolean }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-700" aria-label="Legend">
      <li className="flex items-center gap-2">
        <svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
          <circle cx="5" cy="7" r="3.5" className="fill-panel stroke-signal" strokeWidth="2" />
          <line x1="8.5" y1="7" x2="25" y2="7" className="stroke-signal" strokeWidth="6" />
          <path d="M24 1 L31 7 L24 13" className="stroke-signal" strokeWidth="2.5" fill="none" />
        </svg>
        Current fact, runs to today
      </li>
      <li className="flex items-center gap-2">
        <svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
          <circle cx="5" cy="7" r="3" className="fill-panel stroke-ink-500" strokeWidth="1.5" />
          <line x1="8" y1="7" x2="28" y2="7" className="stroke-ink-500" strokeWidth="4" />
          <line x1="29" y1="1" x2="29" y2="13" className="stroke-ink-700" strokeWidth="2.5" />
        </svg>
        Closed fact, ends at its stop date
      </li>
      <li className="flex items-center gap-2">
        <svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
          <path d="M2 2 C18 2 16 12 32 12" className="stroke-ink-700" strokeWidth="1.5" strokeDasharray="4 3" fill="none" />
        </svg>
        Supersedes link, old fact to its replacement
      </li>
      <li className="flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="4" y="0.5" width="6" height="6" transform="rotate(45 7 3.5)" className="fill-crit" />
          <line x1="7" y1="7" x2="7" y2="14" className="stroke-crit" strokeWidth="1.5" strokeDasharray="2 2" />
        </svg>
        Incident
      </li>
      {episodes ? (
        <li className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <line x1="5" y1="2" x2="5" y2="12" className="stroke-ink-500" strokeWidth="1" />
            <line x1="9" y1="2" x2="9" y2="12" className="stroke-ink-500" strokeWidth="1" />
          </svg>
          Agent step
        </li>
      ) : null}
      {example ? (
        <li className="flex items-center gap-2">
          <ExampleTag />
          Seeded example history
        </li>
      ) : null}
    </ul>
  );
}

function Bar({ row: r, i, active }: { row: TimelineRow; i: number; active: boolean }) {
  const end = r.open ? r.x2 - 7 : r.x2;
  const len = end - r.x1;
  return (
    <g>
      {active ? <rect x={0} y={r.y + 2} width="100%" height={T.rowH - 4} className="fill-sunk" /> : null}
      {len > 0 ? (
        <line
          x1={r.x1}
          y1={r.cy}
          x2={end}
          y2={r.cy}
          strokeWidth={r.open ? 6 : 4}
          className={`draw-in ${DELAY} ${r.open ? "stroke-signal" : "stroke-ink-500"}`}
          style={drawIn(len, i)}
        />
      ) : null}
      <g className={`fade-in ${DELAY}`} style={fadeLate}>
        {r.open ? (
          <path d={`M${r.x2 - 8} ${r.cy - 6.5} L${r.x2} ${r.cy} L${r.x2 - 8} ${r.cy + 6.5}`} className="stroke-signal" strokeWidth="2.5" fill="none" />
        ) : (
          <>
            <line x1={r.x2} y1={r.cy - 7} x2={r.x2} y2={r.cy + 7} className="stroke-ink-700" strokeWidth="2.5" />
            {/* Above the cap, right-aligned, so a supersedes link or the Today line never runs through it. */}
            <text x={r.x2} y={r.cy - 10} textAnchor="end" className="label fill-ink-500">
              closed
            </text>
          </>
        )}
      </g>
      <circle cx={r.x1} cy={r.cy} r={r.open ? 4 : 3} strokeWidth={r.open ? 2 : 1.5} className={`fill-panel ${r.open ? "stroke-signal" : "stroke-ink-500"}`} />
    </g>
  );
}

function Details({ row: r, id, rows, style }: { row: TimelineRow; id: string; rows: TimelineRow[]; style: CSSProperties }) {
  const f = r.fact;
  const replaced = rows.find((x) => x.fact.supersedes === f.id);
  const replaces = f.supersedes ? rows.find((x) => x.id === f.supersedes) : undefined;
  return (
    <div id={id} role="tooltip" style={style} className="pointer-events-none absolute z-10 flex w-80 max-w-full flex-col gap-2 rounded-md border border-line-strong bg-panel p-3 shadow-lift">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label text-ink-500">{KIND[f.kind] ?? f.kind}</span>
        {f.example ? <ExampleTag /> : null}
        <span className={`label ml-auto ${r.open ? "text-signal-strong" : "text-ink-500"}`}>{r.open ? "Still true" : "Closed"}</span>
      </div>
      <p className={`text-sm ${r.open ? "text-ink-900" : "text-ink-700"}`}>{f.text}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-500">Valid</dt>
        <dd className="tabular font-mono text-ink-900">
          {formatDay(f.validFromMs)} → {f.validToMs === null ? "today" : formatDay(f.validToMs)}
        </dd>
        <dt className="text-ink-500">Written by</dt>
        <dd className="text-ink-700">{f.agent ?? "An agent that is no longer in the graph"}</dd>
        <dt className="text-ink-500">Incident</dt>
        <dd className="text-ink-700">{r.incident ? `${r.incident.title}, ${formatDay(r.incident.openedMs)}` : "None; reported outside an incident"}</dd>
        {replaces ? (
          <>
            <dt className="text-ink-500">Replaces</dt>
            <dd className="text-ink-700">{replaces.fact.text}</dd>
          </>
        ) : null}
        {replaced ? (
          <>
            <dt className="text-ink-500">Replaced by</dt>
            <dd className="text-ink-700">{replaced.fact.text}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** "Memory over time": every finding as a bar over its validity window, with incidents and supersedes links. */
export function MemoryTimeline({ findings, incidents, episodes }: { findings: TimelineFact[]; incidents: TimelineIncident[]; episodes: { atMs: number }[] }) {
  const [now] = useState(() => Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 960, offset: 0 });
  const [scrollLeft, setScrollLeft] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const cardId = useId();

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ width: el.clientWidth, offset: el.offsetLeft }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!active) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [active]);

  const l = useMemo(
    () => layoutTimeline({ findings, incidents, episodes, nowMs: Math.max(now, ...findings.map((f) => f.validFromMs)), width: box.width }),
    [findings, incidents, episodes, now, box.width],
  );

  if (!findings.length) {
    return <p className="rounded-md border border-dashed border-line-strong px-4 py-6 text-sm text-ink-700">No facts in this graph yet, so there is nothing to draw over time.</p>;
  }

  const activeRow = l.rows.find((r) => r.id === active) ?? null;
  const cardStyle = (r: TimelineRow): CSSProperties => {
    const outer = box.offset + box.width;
    const cardW = Math.min(320, outer);
    const left = Math.min(Math.max(0, box.offset + r.x1 - scrollLeft - 24), outer - cardW);
    return r.cy > l.height / 2 ? { left, top: r.y + 2, transform: "translateY(-100%)" } : { left, top: r.y + T.rowH - 2 };
  };
  const leave = (id: string) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && document.activeElement !== e.currentTarget) setActive((cur) => (cur === id ? null : cur));
  };
  const linked = (from: string, to: string) => active === from || active === to;

  return (
    <div className="flex flex-col gap-4">
      <Legend episodes={l.episodes.length > 0} example={findings.some((f) => f.example)} />
      <div className="relative grid grid-cols-[9.5rem_minmax(0,1fr)] rounded-md border border-line bg-panel sm:grid-cols-[13rem_minmax(0,1fr)]">
        {/* Row labels stay put while the plot scrolls sideways on a phone. */}
        <div className="relative border-r border-line" style={{ height: l.height }} aria-hidden="true">
          {l.groups.map((g) => (
            <p key={g.key} className="label absolute inset-x-0 flex items-end px-3 pb-1 text-ink-900" style={{ top: g.y, height: T.groupH }}>
              {g.label}
            </p>
          ))}
          {l.rows.map((r) => (
            <div key={r.id} className="absolute inset-x-0 flex flex-col justify-center px-3" style={{ top: r.y, height: T.rowH }}>
              <span title={r.label} className={`truncate text-xs ${r.open ? "text-ink-900" : "text-ink-500"}`}>
                {r.label || "Whole route"}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-ink-500">
                {KIND[r.fact.kind] ?? r.fact.kind}
                {r.fact.example ? <ExampleTag /> : null}
              </span>
            </div>
          ))}
          {l.episodeLane ? (
            <p className="absolute inset-x-0 flex items-center px-3 text-xs text-ink-500" style={{ top: l.episodeLane.y, height: l.episodeLane.h }}>
              Agent steps, latest {l.episodes.length}
            </p>
          ) : null}
        </div>

        <div
          ref={scroller}
          className="scroll-x-cue relative min-w-0 overflow-x-auto overflow-y-hidden"
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          data-testid="memory-timeline"
        >
          <div className="relative" style={{ width: l.width, height: l.height }}>
            <svg width={l.width} height={l.height} viewBox={`0 0 ${l.width} ${l.height}`} className="absolute inset-0 block" aria-hidden="true">
              {l.ticks.map((t) => (
                <g key={t.ms}>
                  <line x1={t.x} y1={l.top - 4} x2={t.x} y2={l.axisY + 6} className="stroke-line" strokeWidth="1" />
                  {t.label ? (
                    <text x={t.x + 4} y={l.axisY + 20} className="tabular fill-ink-500 text-xs">
                      {t.label}
                    </text>
                  ) : null}
                </g>
              ))}
              {l.groups.map((g) => (
                <line key={g.key} x1={0} y1={g.y} x2={l.width} y2={g.y} className="stroke-line" strokeWidth="1" />
              ))}
              <line x1={0} y1={l.axisY} x2={l.width} y2={l.axisY} className="stroke-line-strong" strokeWidth="1" />

              {l.incidents.map((m) => (
                <g key={m.incident.id} className="fade-in">
                  <rect x={m.x - 3} y={m.labelY - 7} width="6" height="6" transform={`rotate(45 ${m.x} ${m.labelY - 4})`} className="fill-crit" />
                  <line x1={m.x} y1={m.labelY + 2} x2={m.x} y2={l.bodyBottom} className="stroke-crit" strokeWidth="1.5" strokeDasharray="3 3" strokeOpacity="0.7" />
                  <text x={m.anchor === "start" ? m.x + 8 : m.x - 8} y={m.labelY} textAnchor={m.anchor} className="fill-ink-700 text-xs">
                    {m.label}
                  </text>
                </g>
              ))}

              {l.rows.map((r, i) => (
                <Bar key={r.id} row={r} i={i} active={active === r.id} />
              ))}

              {l.links.map((k) => (
                <g key={`${k.from}-${k.to}`} className={`fade-in ${DELAY}`} style={fadeLate}>
                  <path d={k.d} fill="none" strokeDasharray="4 3" strokeWidth={linked(k.from, k.to) ? 2 : 1.5} className={linked(k.from, k.to) ? "stroke-ink-900" : "stroke-ink-700"} />
                  <circle cx={k.x2} cy={k.y2} r="2.5" className="fill-ink-700" />
                  {/* Near Today there is no room to the right of the curve, so the label sits to its left. */}
                  <text
                    x={k.labelX + 90 > l.width ? Math.min(k.x1, k.x2) - 8 : k.labelX + 6}
                    y={k.labelY + 4}
                    textAnchor={k.labelX + 90 > l.width ? "end" : "start"}
                    className={`label ${linked(k.from, k.to) ? "fill-ink-900" : "fill-ink-500"}`}
                  >
                    supersedes
                  </text>
                </g>
              ))}

              {l.episodeLane
                ? l.episodes.map((e, i) => (
                    <line key={i} x1={e.x} y1={l.episodeLane!.y + 8} x2={e.x} y2={l.episodeLane!.y + l.episodeLane!.h - 8} className="stroke-ink-500" strokeWidth="1" strokeOpacity="0.6" />
                  ))
                : null}

              <line x1={l.today.x} y1={l.top - 4} x2={l.today.x} y2={l.axisY + 6} className="stroke-ink-900" strokeWidth="1.5" />
              <text x={l.today.x} y={l.axisY + 20} textAnchor="middle" className="tabular fill-ink-900 text-xs font-semibold">
                {l.today.label}
              </text>
            </svg>

            <ul aria-label="Facts on the timeline">
              {l.rows.map((r) => (
                <li key={r.id} className="absolute" style={{ left: r.hit.x, top: r.y, width: r.hit.w, height: T.rowH }}>
                  <button
                    type="button"
                    aria-label={factName(r.fact)}
                    aria-describedby={active === r.id ? cardId : undefined}
                    className="block h-full w-full rounded-sm"
                    onFocus={() => setActive(r.id)}
                    onBlur={() => setActive((cur) => (cur === r.id ? null : cur))}
                    onPointerEnter={() => setActive(r.id)}
                    onPointerLeave={leave(r.id)}
                    onClick={() => setActive(r.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>

        {activeRow ? <Details row={activeRow} id={cardId} rows={l.rows} style={cardStyle(activeRow)} /> : null}
      </div>
    </div>
  );
}
