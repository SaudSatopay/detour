import type { Outcome } from "@/lib/graph/tools/types";

export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "–" : (Math.round(n) || 0).toLocaleString("en-US"));

/** A route name with its GTFS color as a bar beside it. Not the MTA bullet: a plain tag. */
export function RouteTag({ route, color }: { route: string; color?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm border border-line bg-panel px-1 font-mono text-xs font-semibold leading-5 text-ink-900"
      title={`${route} train`}
    >
      <span aria-hidden="true" className="h-3 w-1 rounded-[1px]" style={{ background: color ? `#${color}` : "var(--ink-500)" }} />
      {route}
    </span>
  );
}

const OUTCOME: Record<Outcome, { label: string; className: string; mark: string }> = {
  answered: { label: "Answered", className: "bg-ok-wash text-ink-900", mark: "✓" },
  memory: { label: "From memory", className: "bg-signal-wash text-ink-900", mark: "◷" },
  not_in_graph: { label: "Not in graph", className: "bg-warn-wash text-ink-900", mark: "∅" },
  unknown_entity: { label: "Unknown name", className: "bg-crit-wash text-ink-900", mark: "?" },
};

/** The four answer shapes, each with its own mark so color is never the only cue. */
export function OutcomeChip({ outcome }: { outcome: Outcome }) {
  const o = OUTCOME[outcome];
  return (
    <span className={`inline-flex items-center gap-1 rounded-sm px-1.5 font-display text-xs font-semibold uppercase leading-5 tracking-[0.06em] ${o.className}`}>
      <span aria-hidden="true" className="font-mono">
        {o.mark}
      </span>
      {o.label}
    </span>
  );
}

/** A labeled number; tabular so it does not jitter while a run streams. */
export function Stat({ label, value, unit, tone = "ink" }: { label: string; value: string; unit?: string; tone?: "ink" | "crit" | "ok" | "signal" }) {
  const color = tone === "crit" ? "text-crit" : tone === "ok" ? "text-ok" : tone === "signal" ? "text-signal-strong" : "text-ink-900";
  return (
    <div className="min-w-0">
      <dt className="label text-ink-500">{label}</dt>
      <dd className={`tabular font-display text-2xl font-bold leading-tight ${color}`}>
        {value}
        {unit ? <span className="ml-1 font-sans text-sm font-normal text-ink-500">{unit}</span> : null}
      </dd>
    </div>
  );
}

/** Renders the brief's "**Label** text" lines. */
export function BriefLines({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      {text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line, i) => {
          const m = line.match(/^\*\*(.+?)\*\*\s*(.*)$/);
          return (
            <p key={i} className="text-sm leading-relaxed text-ink-700">
              {m ? (
                <>
                  <span className="label mr-1.5 text-ink-900">{m[1]}</span>
                  {m[2]}
                </>
              ) : (
                line.replace(/\*\*/g, "")
              )}
            </p>
          );
        })}
    </div>
  );
}
