import { heldOut } from "@/lib/proof";
import { n, SectionHead, SourceLink } from "./section-head";

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Agreement on random closures nobody tuned for, and the controller's plan choice against a brute-force oracle. */
export function HeldOutSection() {
  const h = heldOut();
  const core = h.metrics.filter((m) => m.key !== "overflow");
  const allCore = core.every((m) => m.agree === m.total);
  const p = h.policy;
  return (
    <section className="deferred flex flex-col gap-6" aria-labelledby="held-out">
      <SectionHead
        id="held-out"
        kicker="Check 3"
        title={allCore ? `${h.count} closures nobody tuned for: the two programs still agree.` : `${h.count} held-out closures: some numbers disagree.`}
      >
        <p>
          The three demo closures could have been fitted by hand. These were not: {h.count} stretches of {h.segments.min} to {h.segments.max} segments on {h.lines} lines,
          drawn with a fixed seed ({h.seed}), each closed on FalkorDB through the controller&apos;s own procedure and recomputed by the NetworkX verifier.
        </p>
      </SectionHead>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="font-display text-xl font-semibold">FalkorDB against NetworkX</h3>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Share of held-out closures on which FalkorDB and NetworkX agree, by measure</caption>
            <thead className="text-left">
              <tr className="border-b border-line">
                <th scope="col" className="label py-1.5 text-ink-700">Measure</th>
                <th scope="col" className="label px-3 py-1.5 text-right text-ink-700">Agree</th>
                <th scope="col" className="label py-1.5 pl-3 text-right text-ink-700">Rate</th>
              </tr>
            </thead>
            <tbody>
              {h.metrics.map((m) => (
                <tr key={m.key} className="border-b border-line/60">
                  <td className="py-1.5 text-ink-700">{m.label}</td>
                  <td className="tabular px-3 py-1.5 text-right font-mono">
                    {m.agree} of {m.total}
                  </td>
                  <td className={`tabular py-1.5 pl-3 text-right font-mono font-semibold ${m.agree === m.total ? "text-ok" : "text-warn"}`}>{pct(m.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-ink-500">
            Rider counts within 1.5 an hour; closed segments and cut-off stations identical; headroom within 0.1%. Overflow: the same value on{" "}
            {h.overflow.sameAsNetworkx} closures. On {h.overflow.tieSensitive} the fastest path is not unique, two routes take the same minutes, and which one each program
            picks moves the overflow
            {h.worstOverflow[0] ? ` (by up to ${n(h.worstOverflow[0].diff)} riders an hour on ${h.worstOverflow[0].title})` : ""}; there it is checked against the range
            NetworkX finds across 8 random tie-breaks, and lies inside it on {h.overflow.withinTieRange - h.overflow.sameAsNetworkx} more.
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="font-display text-xl font-semibold">The controller&apos;s plan against an oracle</h3>
          <p className="text-sm text-ink-700">
            {p.needingBuses} of the {h.count} closures leave riders with no path or a max-flow shortfall, so the controller tests shuttles. For each, an oracle simulated every
            candidate leg the controller saw on its own fork and kept the best gain per bus (riders with no path plus shortfall cleared, per bus on the road).
          </p>
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line">
            {[
              ["Best choice", `${p.optimal} of ${p.needingBuses}`],
              ["Mean gap", pct(p.meanGap)],
              ["Worst gap", pct(p.maxGap)],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 bg-panel p-3">
                <dt className="label text-ink-500">{label}</dt>
                <dd className="tabular font-display text-2xl font-bold">{value}</dd>
              </div>
            ))}
          </dl>
          {p.worst.length ? (
            <ul className="flex flex-col gap-1.5 text-sm text-ink-700">
              {p.worst.map((w) => (
                <li key={w.id}>
                  <span className="text-ink-900">{w.title}</span>: the controller cleared {n(w.chosen?.perBus ?? 0)} riders per bus with {w.chosen?.vehicles ?? 0} buses; the best
                  single leg clears {n(w.oracle?.perBus ?? 0)} with {w.oracle?.vehicles ?? 0}.
                </li>
              ))}
              <li className="text-ink-500">The controller simulates only the first candidate for riders with no line and the first for relief; the oracle tries them all.</li>
            </ul>
          ) : null}
          <p className="text-xs text-ink-500">
            <SourceLink path="scripts/eval/closures-eval.ts" /> · <SourceLink path="data/eval/closures.json" /> · {h.engine}
          </p>
        </div>
      </div>
    </section>
  );
}
