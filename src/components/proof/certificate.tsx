import { certificates } from "@/lib/proof";
import { n, SectionHead, SourceLink } from "./section-head";

/** Riders an hour to one decimal: flow and cut agree to float noise, and whole-rider rounding can split them. */
const one = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Every max flow carries a max-flow/min-cut certificate; FalkorDB's answer is replaced when it fails one. */
export function CertificateSection() {
  const { rows, repro, totals, heldOut } = certificates();
  const c = repro.chokepoint;
  const allChecked = rows.every((r) => r.checked) && totals.allChecked;
  return (
    <section className="deferred flex flex-col gap-6" aria-labelledby="certificate">
      <SectionHead
        id="certificate"
        kicker="Check 2"
        title={allChecked ? "Every max flow is certified before anyone reads it." : "A max flow failed its certificate."}
      >
        <p>
          FalkorDB&apos;s <code className="font-mono text-sm">algo.maxFlow</code> is fast but not always right, so its answer is never taken on its word. After each call the
          tool reads back the flows and checks three things: every edge within capacity and flow conserved at every station; no augmenting path left in the residual
          graph; and the value equal to the capacity of the cut it leaves. If any check fails, Detour&apos;s own Dinic solver recomputes the flow on the same edges and the
          tool says so in its result. Code in <SourceLink path="src/lib/graph/flow.ts" />.
        </p>
      </SectionHead>

      <div tabIndex={0} role="region" aria-label="Max-flow certificates on the three closures" className="scroll-x-cue overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <caption className="sr-only">Max flow, cut capacity, solver, headroom and cut-off stations for each closure and direction</caption>
          <thead className="bg-sunk text-left">
            <tr>
              <th scope="col" className="label px-3 py-2 text-ink-700">Closure</th>
              <th scope="col" className="label px-3 py-2 text-ink-700">Direction</th>
              <th scope="col" className="label px-3 py-2 text-right text-ink-700">Max flow</th>
              <th scope="col" className="label px-3 py-2 text-right text-ink-700">Cut capacity</th>
              <th scope="col" className="label px-3 py-2 text-ink-700">Answer from</th>
              <th scope="col" className="label px-3 py-2 text-right text-ink-700">Headroom</th>
              <th scope="col" className="label px-3 py-2 text-ink-700">What limits it</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.scenario}${r.direction}`} className="border-t border-line align-top">
                <td className="px-3 py-2 text-ink-900">{r.title}</td>
                <td className="px-3 py-2 text-ink-700">{r.direction}</td>
                <td className="tabular px-3 py-2 text-right font-mono">{one(r.value)}</td>
                <td className="tabular px-3 py-2 text-right font-mono text-ink-500">{one(r.cutCapacity)}</td>
                <td className={`px-3 py-2 font-semibold ${r.checked ? "text-ok" : "text-crit"}`}>
                  {r.checked ? "✓ " : "✗ "}
                  {r.solver === "falkordb" ? "FalkorDB, certified" : `Dinic (FalkorDB said ${n(r.falkordbValue)})`}
                </td>
                <td className="tabular px-3 py-2 text-right font-mono">{r.headroom === null ? "> 20×" : `${r.headroom.toFixed(2)}×`}</td>
                <td className="px-3 py-2 text-ink-700">
                  {r.openSegments > 0
                    ? `${r.openSegments} open segment${r.openSegments === 1 ? "" : "s"} in the min cut`
                    : r.cutOff
                      ? `No open segment; only cut-off stations: ${r.cutOff}`
                      : r.headroom === null
                        ? "Nothing within 20× today's demand"
                        : `Nothing today; first to fill: ${r.firstToFill}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="font-display text-xl font-semibold">Why the check is there</h3>
          <p className="text-sm text-ink-700">
            Another Graph Hacks team, Chokepoint, found <code className="font-mono">algo.maxFlow</code> returning wrong answers on node-split networks and published an
            11-edge reproduction. On {repro.engine}, the engine Detour runs on, it returns{" "}
            <span className="font-semibold text-ink-900">{n(c.falkordb)}</span> where the maximum is <span className="font-semibold text-ink-900">{n(c.exact)}</span>, with
            flows that are not even conserved. The certificate rejects it. On {repro.random.networks} random node-split networks FalkorDB returned a value below the
            maximum or a flow that breaks conservation {repro.random.wrong} times; the certificate caught {repro.random.caughtByCertificate} and let{" "}
            {repro.random.missedByCertificate === 0 ? "none" : repro.random.missedByCertificate} through.
          </p>
          <p className="text-xs text-ink-500">
            <SourceLink path="scripts/judge/maxflow-repro.ts" /> · <code className="font-mono">pnpm judge:maxflow</code>
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="font-display text-xl font-semibold">On Detour&apos;s own networks</h3>
          <p className="text-sm text-ink-700">
            The defect has not fired on the subway: {totals.falkordbPassed} of {totals.maxFlowRuns} max flows on {heldOut} held-out closures and all{" "}
            {totals.headroomSolves} headroom solves passed the certificate as FalkorDB returned them ({totals.recomputedByDinic + totals.headroomRecomputed} needed Dinic).
            Headroom is how far displaced demand can grow before an open segment saturates: an exact parametric max flow, a few certified solves on the fork per direction.
          </p>
          <p className="text-xs text-ink-500">
            <SourceLink path="docs/model.md">docs/model.md</SourceLink>, &ldquo;Checking max flow&rdquo; and &ldquo;Headroom&rdquo;
          </p>
        </div>
      </div>
    </section>
  );
}
