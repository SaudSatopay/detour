import summaryJson from "../../../data/eval/summary.json";
import type { EvalSummary, Interval } from "@/lib/eval/analyze";

/**
 * The proof page's agent eval: the LLM with Detour's graph tools against the same model with no tools, and against
 * a rules-only router with no model, on questions split into dev and held-out before the run. Renders
 * data/eval/summary.json (scripts/eval/analyze.ts), including where the graph agent lost.
 */
const S = summaryJson as unknown as EvalSummary;
const REPO = "https://github.com/SaudSatopay/detour/blob/main";
const LOST_SHOWN = 12;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const ci = (i: Interval) => (i.n ? `${pct(i.lo)}–${pct(i.hi)}` : "");
const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(Math.round(x * 100))}`;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;

const ARM_LABEL = { graph: "LLM with the graph", baseline: "Same model, no graph", rules: "Rules only, no model" } as const;
const CATEGORY_LABEL: Record<string, string> = {
  impact: "Riders a closure hits",
  capacity: "Max flow",
  bottleneck: "Min cut",
  route: "Fastest trip",
  step_free: "Step-free trips",
  lines: "Lines at a station",
  cut_off: "Cut off by a closure",
  memory: "Memory, with dates",
  not_in_graph: "Not in the graph",
  unknown_entity: "Unknown names",
};

function Bar({ value, tone }: { value: Interval; tone: "signal" | "muted" }) {
  if (!value.n) return <span className="block h-2.5 rounded-full bg-sunk" aria-hidden="true" />;
  return (
    <span className="relative block h-2.5 rounded-full bg-sunk" aria-hidden="true">
      <span className={`absolute inset-y-0 left-0 rounded-full ${tone === "signal" ? "bg-signal" : "bg-ink-500"}`} style={{ width: `${value.rate * 100}%` }} />
      {/* The 95% interval as a whisker over the bar. */}
      <span className="absolute top-1/2 h-px -translate-y-1/2 bg-ink-900" style={{ left: `${value.lo * 100}%`, width: `${Math.max(0.5, (value.hi - value.lo) * 100)}%` }} />
    </span>
  );
}

function Cell({ value }: { value: Interval }) {
  return value.n ? (
    <>
      <span className="font-semibold text-ink-900">{pct(value.rate)}</span>{" "}
      <span className="text-ink-500">
        {value.correct}/{value.n}
      </span>
    </>
  ) : (
    <span className="text-ink-500">–</span>
  );
}

export function AgentEvalSection() {
  const { arms, questions, run } = S;
  const ran = S.status !== "not-run";
  const llm = arms.graph.heldout.n > 0 && arms.baseline.heldout.n > 0;
  const models = [...new Set([...Object.keys(arms.graph.models), ...Object.keys(arms.baseline.models)])].map((m) => m.split(":").slice(1).join(":") || m);
  const date = when(run.startedAt);
  const partial = S.status === "partial";
  const title = llm
    ? `With the graph, the agent answers ${pct(arms.graph.heldout.rate)} of ${partial ? `the ${arms.graph.heldout.n} held-out questions run so far` : "held-out questions"}. The same model without it: ${pct(arms.baseline.heldout.rate)}.`
    : "A held-out test of the agent against the same model without the graph.";
  const tg = S.toolChoice.graph;
  const gg = S.grounding.graph;

  return (
    <section className="deferred flex flex-col gap-6" aria-labelledby="agent-eval">
      <header className="flex max-w-prose flex-col gap-2">
        <p className="sign-band sign-rule label w-fit rounded-sm px-3 pb-1.5 pt-3.5">Check 4</p>
        <h2 id="agent-eval" className="scroll-mt-20 font-display text-3xl font-bold leading-tight tracking-tight">
          {title}
        </h2>
        <div className="flex flex-col gap-2 text-ink-700">
          <p>
            {questions.total} questions with answers computed without FalkorDB: plain TypeScript over the MTA data for closures, trips and
            step-free access, the NetworkX verifier for max flow and min cut, and the seeded memory for dates. {questions.heldout} are held out and{" "}
            {questions.dev} were for development; the split was fixed with seed {questions.seed} and committed before any run, and questions about
            one closure or trip never straddle it. About one in five should be declined: a name or a relation that is not in the graph.
          </p>
          <p>
            {llm ? (
              <>
                {partial ? "Running since" : "Ran on"} {date ? `${date} ` : ""}on the deployment, on a sandbox graph of its own, with {models.length === 1 ? "the free model" : "the free models"}{" "}
                {models.map((m, i) => (
                  <span key={m}>
                    {i ? (i === models.length - 1 ? " and " : ", ") : ""}
                    <code className="font-mono text-sm">{m}</code>
                  </span>
                ))}
                . The baseline gets the model the graph arm ended on, the same question, and no tools.
                {partial ? (
                  <>
                    {" "}
                    The run is partial: {S.graphVsBaseline.n} of {questions.heldout} held-out questions have run on both model arms. The rest wait for
                    the free models&rsquo; daily quotas, which the eval shares with visitors and never takes the last of
                    {S.leftOut ? `; ${S.leftOut} arms that met a spent quota never ran and are left out, not counted wrong` : ""}.
                  </>
                ) : null}
                {run.id?.includes("+") ? (
                  <>
                    {" "}
                    It ran in two parts: the free database restarted empty in between, so the second run skipped the questions the first had
                    answered on every arm, and each question&rsquo;s model arms come from one run.
                  </>
                ) : null}
              </>
            ) : (
              <>
                The two model arms run on the deployment, where the model keys are, through{" "}
                <code className="font-mono text-sm">/api/eval</code>; they have not run yet, so only the question set
                {ran ? " and the rules-only arm are" : " is"} shown.
              </>
            )}{" "}
            <a className="underline decoration-line-strong underline-offset-4" href={`${REPO}/scripts/eval`}>
              scripts/eval
            </a>
          </p>
        </div>
      </header>

      <dl className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3">
        {(["graph", "baseline", "rules"] as const).map((arm) => (
          <div key={arm} className="flex flex-col gap-2 bg-panel p-4">
            <dt className="label text-ink-500">{ARM_LABEL[arm]}</dt>
            <dd className="tabular font-display text-3xl font-bold">{arms[arm].heldout.n ? pct(arms[arm].heldout.rate) : "–"}</dd>
            <dd>
              <Bar value={arms[arm].heldout} tone={arm === "graph" ? "signal" : "muted"} />
            </dd>
            <dd className="text-xs text-ink-500">
              {arms[arm].heldout.n
                ? `${arms[arm].heldout.correct} of ${arms[arm].heldout.n} held out · 95% CI ${ci(arms[arm].heldout)} · dev ${arms[arm].dev.n ? pct(arms[arm].dev.rate) : "–"}${
                    arms[arm].errors ? ` · ${arms[arm].errors} ended in an error, counted wrong` : ""
                  }`
                : "not run yet"}
            </dd>
          </div>
        ))}
      </dl>
      {llm ? (
        <p className="text-sm text-ink-700">
          Paired on the same {S.graphVsBaseline.n} held-out questions: with the graph minus without it,{" "}
          <span className="tabular font-semibold text-ink-900">{signed(S.graphVsBaseline.diff)} points</span> (95% CI {signed(S.graphVsBaseline.lo)} to{" "}
          {signed(S.graphVsBaseline.hi)}); with the graph minus rules alone, <span className="tabular font-semibold text-ink-900">{signed(S.graphVsRules.diff)} points</span>{" "}
          ({signed(S.graphVsRules.lo)} to {signed(S.graphVsRules.hi)}). Seeded bootstrap, 2,000 resamples.
        </p>
      ) : null}

      <div tabIndex={0} role="region" aria-label="Held-out accuracy by kind of question" className="scroll-x-cue overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">Held-out accuracy by kind of question: the share right, then right of those run</caption>
          <thead className="bg-sunk text-left">
            <tr>
              <th scope="col" className="label px-3 py-2 text-ink-700">Held-out questions</th>
              <th scope="col" className="label px-3 py-2 text-right text-ink-700">n</th>
              {(["graph", "baseline", "rules"] as const).map((arm) => (
                <th key={arm} scope="col" className="label px-3 py-2 text-right text-ink-700">
                  {ARM_LABEL[arm]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {S.byCategory.map((c) => (
              <tr key={c.category} className="border-t border-line">
                <td className="px-3 py-2 text-ink-900">{CATEGORY_LABEL[c.category] ?? c.category}</td>
                <td className="tabular px-3 py-2 text-right font-mono text-ink-500">{c.n}</td>
                {(["graph", "baseline", "rules"] as const).map((arm) => (
                  <td key={arm} className="tabular whitespace-nowrap px-3 py-2 text-right font-mono">
                    <Cell value={c[arm]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
          {[
            ["Declines what is not in the graph (graph · baseline)", llm && S.abstention.graph.shouldDecline.n ? `${pct(S.abstention.graph.shouldDecline.rate)} · ${pct(S.abstention.baseline.shouldDecline.rate)}` : "–"],
            ["Wrongly declines an answerable question", llm ? `${pct(S.abstention.graph.falseDecline.rate)} · ${pct(S.abstention.baseline.falseDecline.rate)}` : "–"],
            [
              "Riders within 1 stop of a closure, then 4 (graph)",
              S.depth.graph.depth1.n ? `${pct(S.depth.graph.depth1.rate)} · ${pct(S.depth.graph.depth4.rate)}` : "–",
            ],
            ["The same pairs without the graph", S.depth.baseline.depth1.n ? `${pct(S.depth.baseline.depth1.rate)} · ${pct(S.depth.baseline.depth4.rate)}` : "–"],
            ["Called the tools a question needs, in a valid order", tg.n ? `${pct(tg.both / tg.n)} (${tg.both} of ${tg.n})` : "–"],
            ["Answers whose every figure a tool returned", gg.withFigures ? `${pct(gg.allGrounded / gg.withFigures)} (${gg.allGrounded} of ${gg.withFigures})` : "–"],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-700">{k}</dt>
              <dd className="tabular text-right font-mono text-ink-900">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-ink-700">
          A valid order means names were resolved before their ids were used and a line was closed before anything was measured on it. The
          rules-only arm is a router written against these question templates, which dev and held-out share, so it is an optimistic floor: what
          plain code on the same graph tools gets when it knows exactly how questions are worded. The model never writes Cypher in any arm; every
          tool call is recorded with its arguments, query time and rows.
        </p>
      </div>

      {llm ? (
        <div className="flex flex-col gap-3">
          <h3 className="font-display text-xl font-semibold">Where we lost</h3>
          {S.lost.length ? (
            <>
              <p className="text-sm text-ink-700">
                {S.lost.length} held-out question{S.lost.length === 1 ? "" : "s"} the model got right without the graph and wrong with it
                {S.lost.length > LOST_SHOWN ? `; the first ${LOST_SHOWN} are below, all of them in data/eval/summary.json` : ""}.
              </p>
              <ul className="flex flex-col gap-2">
                {S.lost.slice(0, LOST_SHOWN).map((l) => (
                  <li key={l.qid} className="rounded-md border border-line bg-panel px-4 py-3 text-sm">
                    <p className="text-ink-900">{l.question}</p>
                    <p className="mt-1 text-xs text-ink-500">
                      <span className="font-semibold text-ink-700">Expected</span> {l.gold} · <span className="font-semibold text-crit">with the graph</span> {l.graph} ·{" "}
                      <span className="font-semibold text-ok">without</span> {l.baseline} · {l.why}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-ink-700">No held-out question went right without the graph and wrong with it.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
