import results from "../../../data/eval/memory.json";

/*
 * The proof page's memory check: Detour with memory against Detour without it, from data/eval/memory.json
 * (scripts/eval/memory-eval.ts). A server component; it renders whatever parts the last run wrote.
 */

type Interval = [number, number];
type Arm = "none" | "placebo" | "timeAware";

interface MemoryEval {
  runAt: string;
  elevators?: {
    question: string;
    method: string[];
    n: { decisions: number; stations: number; months: number; units: number };
    arms: Record<Arm, { accuracy: number; ci: Interval }>;
    differences: { timeAwareVsNone: { value: number; ci: Interval }; timeAwareVsPlacebo: { value: number; ci: Interval } };
    byType: Record<string, { n: number } & Record<Arm, number>>;
    sensitivity: { windowMonths: number; accuracy: number }[];
    failureProne: { question: string; units: number; worst: number; k: number; precision: Record<Arm | "baseRate", number> };
    failures: { wrong: number; share: number; note: string; examples: { month: string; station: string; type: string; units: string[]; remembered: (number | null)[]; actual: number[] }[] };
  };
  stepFree?: {
    question: string;
    method: string[];
    n: { platforms: number; trips: number; affected: number };
    through: { memoryOff: number; memoryOn: number };
    outcomes: { rerouted: number; noStepFreeRoute: number; throughBrokenElevator: number };
    medianExtraMinutes: number | null;
  };
  buses?: {
    question: string;
    method: string[];
    n: number;
    mae: { withoutMemory: number; withMemory: number; online: number };
    improvement: { value: number; ci: Interval };
    withinFivePercent: { withoutMemory: number; withMemory: number; online: number };
    byCorridor: { routes: string; n: number; withoutMemory: number; withMemory: number }[];
  };
  sessions?: { question: string; method: string[]; n: number; changed: number; changedWithMemoryOff: number; aisha: { before: string; after: string }; examples: string[] };
  race?: { question: string; method: string[]; runs: { writers: number; sameReport: number; mixedReports: number; written: number }[]; ok: boolean };
}

const DATA = results as unknown as MemoryEval;
const REPO = "https://github.com/SaudSatopay/detour/blob/main";
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const points = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}`;
const n = (x: number) => Math.round(x).toLocaleString("en-US");

const ARM_LABEL: Record<Arm, string> = { none: "No memory", placebo: "Placebo memory", timeAware: "Detour's memory" };
const ARM_NOTE: Record<Arm, string> = {
  none: "a coin picks",
  placebo: "every record kept forever, no validity windows",
  timeAware: "records valid for a year, superseded after an overhaul",
};

function Method({ steps }: { steps: string[] }) {
  return (
    <details className="group rounded-md border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 px-4 py-2.5 text-sm text-ink-700 hover:bg-sunk/60">
        <span aria-hidden="true" className="inline-block text-ink-500 transition-transform duration-150 group-open:rotate-90">
          ›
        </span>
        How it was measured
      </summary>
      <ol className="flex list-decimal flex-col gap-1.5 border-t border-line py-3 pl-9 pr-4 text-sm text-ink-700">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </details>
  );
}

function Elevators({ e }: { e: NonNullable<MemoryEval["elevators"]> }) {
  const arms: Arm[] = ["none", "placebo", "timeAware"];
  const fp = e.failureProne;
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-ink-700">{e.question}</p>
      <ol className="flex flex-col gap-3" aria-label="Share of decisions memory got right">
        {arms.map((arm) => {
          const a = e.arms[arm];
          return (
            <li key={arm} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[16rem_minmax(0,1fr)_6rem]">
              <span className="min-w-0">
                <span className={`block text-sm ${arm === "timeAware" ? "font-semibold text-ink-900" : "text-ink-700"}`}>{ARM_LABEL[arm]}</span>
                <span className="block text-xs text-ink-500">
                  {ARM_NOTE[arm]} · 95% interval {pct1(a.ci[0])} to {pct1(a.ci[1])}
                </span>
              </span>
              <span className="tabular text-right font-display text-2xl font-bold sm:order-3">{pct1(a.accuracy)}</span>
              <span className="relative col-span-2 block h-2 overflow-hidden rounded-full bg-sunk sm:order-2 sm:col-span-1" aria-hidden="true">
                <span className={`absolute inset-y-0 left-0 rounded-full ${arm === "timeAware" ? "bg-signal" : "bg-ink-500"}`} style={{ width: `${a.accuracy * 100}%` }} />
                {/* The 95% interval, drawn over the bar. */}
                <span className="absolute inset-y-0 border-x-2 border-ink-900/60" style={{ left: `${a.ci[0] * 100}%`, width: `${Math.max(0.5, (a.ci[1] - a.ci[0]) * 100)}%` }} />
              </span>
            </li>
          );
        })}
      </ol>
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3">
        {[
          ["Decisions", n(e.n.decisions), `${e.n.stations} station complexes, ${e.n.months} months held out`],
          ["Over no memory", `${points(e.differences.timeAwareVsNone.value)} pts`, `95% interval ${points(e.differences.timeAwareVsNone.ci[0])} to ${points(e.differences.timeAwareVsNone.ci[1])}`],
          ["Over the placebo", `${points(e.differences.timeAwareVsPlacebo.value)} pts`, `95% interval ${points(e.differences.timeAwareVsPlacebo.ci[0])} to ${points(e.differences.timeAwareVsPlacebo.ci[1])}`],
        ].map(([label, value, note]) => (
          <div key={label} className="flex flex-col gap-1 bg-panel p-4">
            <dt className="label text-ink-500">{label}</dt>
            <dd className="tabular font-display text-3xl font-bold">{value}</dd>
            <dd className="text-xs text-ink-500">{note}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="font-display text-lg font-semibold">Where memory falls short</h3>
          <ul className="flex flex-col gap-2 text-sm text-ink-700">
            <li>
              It still picks the wrong unit in {pct(e.failures.share)} of decisions ({n(e.failures.wrong)}). {e.failures.note}
            </li>
            <li>
              Listing the {fp.k} units that will break down most often in the months held out: {pct(fp.precision.timeAware)} of Detour&apos;s list was right,
              against {pct(fp.precision.baseRate)} by chance, but the placebo&apos;s all-time record did better, {pct(fp.precision.placebo)}. For chronic
              failures a long memory helps, and the one-year window throws that away.
            </li>
            <li>
              Elevators alone: {pct1(e.byType.Elevator?.timeAware ?? 0)} with memory, {pct1(e.byType.Elevator?.none ?? 0)} without ({n(e.byType.Elevator?.n ?? 0)} decisions); escalators:{" "}
              {pct1(e.byType.Escalator?.timeAware ?? 0)}.
            </li>
          </ul>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="font-display text-lg font-semibold">The validity window, varied</h3>
          <p className="text-sm text-ink-700">Detour keeps a unit&apos;s monthly record for twelve months. Windows from three months to two years land within a point of it, so the result does not hang on that choice.</p>
          <table className="w-full border-collapse text-sm">
            <thead className="text-left">
              <tr className="border-b border-line">
                <th scope="col" className="label py-1.5 text-ink-700">
                  Window
                </th>
                <th scope="col" className="label py-1.5 text-right text-ink-700">
                  Right
                </th>
              </tr>
            </thead>
            <tbody>
              {e.sensitivity.map((s) => (
                <tr key={s.windowMonths} className="border-b border-line/60">
                  <td className={`py-1.5 ${s.windowMonths === 12 ? "font-semibold text-ink-900" : "text-ink-700"}`}>{s.windowMonths} months</td>
                  <td className="tabular py-1.5 text-right font-mono">{pct1(s.accuracy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Method steps={e.method} />
    </div>
  );
}

function GraphChecks({ d }: { d: MemoryEval }) {
  const rows: { key: string; title: string; question: string; without: string; withMemory: string; note: string; method: string[] }[] = [];
  if (d.stepFree) {
    const s = d.stepFree;
    rows.push({
      key: "stepfree",
      title: "Step-free routes past a broken elevator",
      question: s.question,
      without: `${pct(s.through.memoryOff)} through it`,
      withMemory: `${pct(s.through.memoryOn)} through it`,
      note: `${n(s.n.affected)} trips at ${s.n.platforms} platforms. With memory, ${pct(s.outcomes.rerouted)} found another step-free route${s.medianExtraMinutes !== null ? ` (median ${s.medianExtraMinutes} more minutes)` : ""} and ${pct(s.outcomes.noStepFreeRoute)} were told there is none.`,
      method: s.method,
    });
  }
  if (d.buses) {
    const b = d.buses;
    const worse = b.byCorridor.filter((c) => c.withMemory > c.withoutMemory);
    rows.push({
      key: "buses",
      title: "Bus bridges sized from what past shuttles carried",
      question: b.question,
      without: `off by ${n(b.mae.withoutMemory)} riders/h`,
      withMemory: `off by ${n(b.mae.withMemory)} riders/h`,
      note: `Mean error over ${b.n} past incidents, left out one at a time; 95% interval for the gain ${n(b.improvement.ci[0])} to ${n(b.improvement.ci[1])}. Bridges within 5% of plan: ${pct(b.withinFivePercent.withoutMemory)} without, ${pct(b.withinFivePercent.withMemory)} with. Fed only earlier incidents: off by ${n(b.mae.online)}.${
        worse.length
          ? ` Worse with memory on ${worse.map((c) => `the ${c.routes} (${n(c.withoutMemory)} → ${n(c.withMemory)})`).join(" and ")}: buses there run close to plan, and sizing for the lowest share on record adds buses after one weak run.`
          : ""
      }`,
      method: b.method,
    });
  }
  if (d.sessions) {
    const s = d.sessions;
    rows.push({
      key: "sessions",
      title: "A fact from one session, used in the next",
      question: s.question,
      without: `${s.changedWithMemoryOff} of ${s.n} change`,
      withMemory: `${s.changed} of ${s.n} change`,
      note: `Aisha before: “${s.aisha.before}” After: “${s.aisha.after}”`,
      method: s.method,
    });
  }
  if (d.race) {
    const r = d.race;
    rows.push({
      key: "race",
      title: "Reports that arrive at the same moment",
      question: r.question,
      without: "–",
      withMemory: r.ok ? "1 open fact, every time" : "more than 1 open fact",
      note: r.runs.map((x) => `${x.writers} writers: ${x.sameReport} open after the same report, ${x.mixedReports} after mixed reports`).join("; "),
      method: r.method,
    });
  }
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-display text-xl font-semibold">On the graph, with memory switched off and on</h3>
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-col gap-2 rounded-md border border-line bg-panel p-4">
            <div className="flex flex-col gap-0.5">
              <h4 className="font-display text-lg font-semibold leading-tight">{r.title}</h4>
              <p className="text-sm text-ink-700">{r.question}</p>
            </div>
            <dl className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <dt className="label text-ink-500">Memory off</dt>
                <dd className="tabular font-display text-xl font-bold text-ink-700">{r.without}</dd>
              </div>
              <div className="min-w-0">
                <dt className="label text-ink-500">Memory on</dt>
                <dd className="tabular font-display text-xl font-bold text-ink-900">{r.withMemory}</dd>
              </div>
            </dl>
            <p className="text-xs leading-relaxed text-ink-500">{r.note}</p>
            <Method steps={r.method} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Drop-in section for /proof: `<MemoryEvalSection />`, with `id="memory"` for the page's contents. */
export function MemoryEvalSection() {
  const e = DATA.elevators;
  const title = e
    ? `With memory, a step-free rider gets the working elevator ${pct(e.arms.timeAware.accuracy)} of the time. Without it, ${pct(e.arms.none.accuracy)}.`
    : "Detour with memory, against Detour without it.";
  return (
    <section className="deferred flex flex-col gap-6" aria-labelledby="memory">
      <header className="flex max-w-prose flex-col gap-2">
        <p className="sign-band sign-rule label w-fit rounded-sm px-3 pb-1.5 pt-3.5">Check 5</p>
        <h2 id="memory" className="scroll-mt-20 font-display text-3xl font-bold leading-tight tracking-tight">
          {title}
        </h2>
        <div className="text-ink-700">
          <p>
            Every check below runs twice, and only memory changes between the two runs. The first replays real MTA elevator and escalator records
            month by month, so memory never sees a record from after the decision it informs; a placebo memory that keeps every record forever shows
            what Detour&apos;s validity windows and SUPERSEDES add. The rest run on FalkorDB with Detour&apos;s own tools.
          </p>
        </div>
      </header>
      {e ? <Elevators e={e} /> : null}
      <GraphChecks d={DATA} />
      <p className="text-xs text-ink-500">
        Run {new Date(DATA.runAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}, seeded, so a rerun gives the same numbers.{" "}
        <a className="underline decoration-line-strong underline-offset-4" href={`${REPO}/scripts/eval/memory-eval.ts`}>
          scripts/eval/memory-eval.ts
        </a>
      </p>
    </section>
  );
}
