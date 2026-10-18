import { verifierCoverage } from "@/lib/proof";
import { SectionHead, SourceLink } from "./section-head";

/** What the independent verifier recomputes for the L closure, and what no second program can. */
export function VerifierCoverageSection() {
  const rows = verifierCoverage();
  const checked = rows.filter((r) => r.match !== null);
  return (
    <section className="deferred flex flex-col gap-6" aria-labelledby="coverage">
      <SectionHead id="coverage" kicker="Check 4" title="What the verifier recomputes, and what it cannot.">
        <p>
          Beyond max flow, the NetworkX program rebuilds the platform layer with the same costs (3 minutes and half the headway to board, the ride, a free exit, walks)
          and sends every displaced rider down their fastest open path, so the overloaded G, the riders with no path and the shuttle&apos;s effect are recomputed too.{" "}
          {checked.filter((r) => r.match).length} of {checked.length} L-closure numbers below match. The last rows have no second implementation, and say so.
        </p>
      </SectionHead>
      <div tabIndex={0} role="region" aria-label="Verifier coverage on the L closure" className="scroll-x-cue overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">Numbers for the L closure from FalkorDB and from the NetworkX verifier</caption>
          <thead className="bg-sunk text-left">
            <tr>
              <th scope="col" className="label px-3 py-2 text-ink-700">L closure</th>
              <th scope="col" className="label px-3 py-2 text-right text-ink-700">FalkorDB</th>
              <th scope="col" className="label px-3 py-2 text-right text-ink-700">NetworkX</th>
              <th scope="col" className="label px-3 py-2 text-ink-700">Agree</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.what} className="border-t border-line">
                <td className="px-3 py-2 text-ink-900">{r.what}</td>
                <td className="tabular px-3 py-2 text-right font-mono">{r.falkordb}</td>
                <td className="tabular px-3 py-2 text-right font-mono text-ink-500">{r.networkx ?? "not recomputed"}</td>
                <td className={`px-3 py-2 font-semibold ${r.match === null ? "text-ink-500" : r.match ? "text-ok" : "text-crit"}`}>
                  {r.match === null ? "n/a" : r.match ? "✓ yes" : "✗ no"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-500">
        Every README number, with the script and test behind it: <SourceLink path="CLAIMS.md" />. One command re-measures them all on a FalkorDB and fails on any
        difference: <code className="font-mono">pnpm judge</code>.
      </p>
    </section>
  );
}
