import report from "../../../data/eval/brain.json";
import { ARM_LABEL, type Arm, type BrainEvalReport } from "@/lib/graph/agency-eval";

/**
 * The agency brain's held-out evaluation for the proof page: its graph tools against keyword retrieval and against
 * a brain that keeps only the newest feed state, on questions whose answers were computed from the raw MTA records.
 * Reads data/eval/brain.json (scripts/eval/brain-eval.ts).
 */

const R = report as unknown as BrainEvalReport;
const REPO = "https://github.com/SaudSatopay/detour/blob/main";
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const whole = (x: number) => `${Math.round(x * 100)}`;
const n = (x: number) => x.toLocaleString("en-US");
const when = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
const clip = (text: string, max = 140) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const shown = (a: string[] | null) => (a === null ? "refused" : a.length ? clip(a.join(", ")) : "none");

export function BrainEvalSection() {
  const arms = R.arms as Arm[];
  const g = R.overall.graph;
  const k = R.overall.keyword;
  const captures = R.snapshot.outageCaptures;
  const examples = R.byType.map((t) => ({ ...t, items: R.heldout.filter((q) => q.type === t.type).slice(0, 3) }));

  return (
    <section className="deferred flex flex-col gap-6" aria-labelledby="brain-eval">
      <header className="flex max-w-prose flex-col gap-2">
        <p className="sign-band sign-rule label w-fit rounded-sm px-3 pb-1.5 pt-3.5">Check 7</p>
        <h2 id="brain-eval" className="scroll-mt-20 font-display text-3xl font-bold leading-tight tracking-tight">
          {`The brain's graph tools answer ${pct(g.em.mean)} of ${n(g.em.n)} held-out questions; keyword retrieval ${pct(k.em.mean)}.`}
        </h2>
        <div className="flex flex-col gap-3 text-ink-700">
          <p>
            {n(R.questions.total)} questions are generated from the committed snapshot of the MTA&apos;s records, and their answers are computed in plain
            code from the raw feed JSON, never through FalkorDB. {n(R.questions.unanswerable)} of them have no answer in the records (units, alerts,
            events and projects that do not exist, units with no outage or no published alternative, quarters the complaint data does not cover),
            so refusing is scored too. Whole stations, alerts, events and projects are held out by a fixed seed ({R.seed}); the brain was tuned
            on the {n(R.questions.dev)} dev questions, with one exception noted below.
          </p>
          <p>
            Each question goes to three arms with no model in the loop: the brain&apos;s standard procedure (it picks a graph tool from the
            question&apos;s words and answers from the tool&apos;s facts), a CONTAINS search over every record&apos;s text with the answer extracted
            from the top hits, and the same graph tools holding only the newest feed state. Scores are exact match and set F1 with 95% bootstrap
            intervals.
          </p>
        </div>
      </header>

      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3">
        {arms.map((arm) => {
          const s = R.overall[arm];
          return (
            <div key={arm} className="flex flex-col gap-1 bg-panel p-4">
              <dt className="label text-ink-500">{ARM_LABEL[arm]}</dt>
              <dd className="tabular font-display text-3xl font-bold">{pct(s.em.mean)}</dd>
              <dd className="tabular text-xs text-ink-500">
                exact match, 95% CI {pct(s.em.lo)} to {pct(s.em.hi)} · F1 {pct(s.f1.mean)}
              </dd>
              <dd className="tabular text-xs text-ink-500">
                refused {pct(s.refusals.mean)} of {n(s.refusals.n)} unanswerable · wrongly refused {pct(s.falseRefusals.mean)} of {n(s.falseRefusals.n)}
              </dd>
            </div>
          );
        })}
      </dl>

      <div tabIndex={0} role="region" aria-label="Exact match by question type, held-out split" className="scroll-x-cue overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <caption className="sr-only">Held-out exact match by question type for each arm</caption>
          <thead className="bg-sunk text-left">
            <tr>
              <th scope="col" className="label px-3 py-2 text-ink-700">Question type</th>
              <th scope="col" className="label px-3 py-2 text-right text-ink-700">Held out</th>
              {arms.map((arm) => (
                <th key={arm} scope="col" className="label px-3 py-2 text-right text-ink-700">
                  {ARM_LABEL[arm]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {R.byType
              .filter((t) => t.n > 0)
              .map((t) => (
                <tr key={t.type} className="border-t border-line">
                  <td className="px-3 py-2 text-ink-900">{t.label}</td>
                  <td className="tabular px-3 py-2 text-right font-mono text-ink-500">
                    {t.n}
                    {t.unanswerable ? <span className="text-xs"> ({t.unanswerable} no answer)</span> : null}
                  </td>
                  {arms.map((arm) => (
                    <td key={arm} className={`tabular px-3 py-2 text-right font-mono ${arm === "graph" ? "font-semibold text-ink-900" : "text-ink-700"}`}>
                      {whole(t.arms[arm].em)}%
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="font-display text-xl font-semibold">What the baselines miss</h3>
          <ul className="flex flex-col gap-2 text-sm text-ink-700">
            <li>
              <span className="font-semibold text-ink-900">Joins.</span> Which stations an alert names, which of them have a unit out, which stations on a
              line have outages: the answer is spread over several records linked by edges, not written in any one of them.
            </li>
            <li>
              <span className="font-semibold text-ink-900">Time.</span> Outages that began or left the feed since a moment, an alert event&apos;s chain of
              updates, complaints per quarter: a brain that keeps only the newest feed cannot answer them, and refuses.
            </li>
            <li>
              <span className="font-semibold text-ink-900">Where keyword search is enough.</span> One-record facts named by an id (a unit&apos;s status,
              maintainer or alternative route, a project&apos;s stage) are found by CONTAINS too, so those rows tie.
            </li>
          </ul>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="font-display text-xl font-semibold">Read it with care</h3>
          <ul className="flex flex-col gap-2 text-sm text-ink-700">
            <li>The questions are templates in several wordings over the same records the tools read, so a high score says the tools answer these forms, not open questions.</li>
            <li>The keyword arm is given the question&apos;s identifiers and parameters and an extraction rule per record format; a plainer retriever would score lower.</li>
            <li>
              Fixes made while building it: the planner&apos;s wordings for stations along a line came from dev misses; reading full station names before
              partial ones was fixed after a held-out run, which scored 99.4% before it.
            </li>
          </ul>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="font-display text-xl font-semibold">Held-out questions, with every arm&apos;s answer</h3>
        {examples
          .filter((t) => t.items.length)
          .map((t) => (
            <details key={t.type} className="group rounded-md border border-line bg-panel">
              <summary className="flex cursor-pointer list-none items-baseline gap-3 px-4 py-3 hover:bg-sunk/60">
                <span aria-hidden="true" className="inline-block text-ink-500 transition-transform duration-150 group-open:rotate-90">
                  ›
                </span>
                <span className="font-display text-lg font-semibold">{t.label}</span>
                <span className="tabular ml-auto font-mono text-xs text-ink-500">{t.n}</span>
              </summary>
              <ol className="flex flex-col gap-4 border-t border-line px-4 py-4">
                {t.items.map((q) => (
                  <li key={q.id} className="flex min-w-0 flex-col gap-1.5 text-sm">
                    <p className="break-words font-semibold text-ink-900">{q.question}</p>
                    <p className="break-words text-ink-700">
                      <span className="label mr-2 text-ink-500">Answer</span>
                      {q.gold === null ? "no answer in the records" : shown(q.gold)}
                    </p>
                    <ul className="flex flex-col gap-0.5">
                      {arms.map((arm) => (
                        <li key={arm} className="break-words text-xs text-ink-700">
                          <span className={`mr-1 font-semibold ${q.em[arm] ? "text-ok" : "text-crit"}`}>{q.em[arm] ? "✓" : "✗"}</span>
                          <span className="text-ink-500">{ARM_LABEL[arm]}:</span> {shown(q.answers[arm])}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </details>
          ))}
      </div>

      <p className="text-xs text-ink-500">
        Snapshot: outage feed read {captures.length} time{captures.length === 1 ? "" : "s"}, last {captures.length ? when(captures[captures.length - 1]) : "never"}; run {when(R.generatedMs)}.{" "}
        Every held-out question, its answer and each arm&apos;s answer are in{" "}
        <a className="underline decoration-line-strong underline-offset-4" href={`${REPO}/data/eval/brain.json`}>
          data/eval/brain.json
        </a>
        ;{" "}
        <a className="underline decoration-line-strong underline-offset-4" href={`${REPO}/scripts/eval/brain-eval.ts`}>
          scripts/eval/brain-eval.ts
        </a>{" "}
        reproduces it on any FalkorDB.
      </p>
    </section>
  );
}
