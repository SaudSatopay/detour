import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not in the graph", robots: { index: false } };

/** The fourth answer shape, for a page: the name exists nowhere in the graph. */
export default function NotFound() {
  return (
    <section className="night flex flex-1 items-center border-b border-line">
      <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 py-20 sm:px-6 lg:py-28">
        <p className="label text-crit">Not in the graph</p>
        <h1 className="lift max-w-[14ch] font-display text-5xl font-bold leading-[0.95] tracking-[-0.012em] sm:text-6xl lg:text-7xl">
          No stop by that name on this line.
        </h1>
        {/* A line that runs out: the track ends in a buffer stop. */}
        <svg viewBox="0 0 320 24" className="w-full max-w-md" aria-hidden="true">
          <path d="M4 12H236" stroke="var(--line-strong)" strokeWidth="6" strokeLinecap="round" />
          <path d="M236 12H276" stroke="var(--crit)" strokeWidth="6" strokeDasharray="8 6" />
          <path d="M284 2V22M284 12H296" stroke="var(--crit)" strokeWidth="4" strokeLinecap="round" />
          {[4, 60, 116, 172, 228].map((x) => (
            <circle key={x} cx={x} cy="12" r="5.5" fill="var(--paper)" stroke="var(--ink-700)" strokeWidth="2.5" />
          ))}
        </svg>
        <p className="max-w-prose text-lg text-ink-700">
          The agents answer the same way when a name is not in the graph: they say so instead of guessing. The pages that exist are one stop
          away.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/" className="rounded-md bg-signal px-5 py-3 font-display text-lg font-semibold tracking-wide text-signal-ink transition-transform duration-150 ease-out hover:-translate-y-px">
            Back to the start
          </Link>
          <Link href="/control" className="rounded-md border border-line-strong px-5 py-3 font-display text-lg font-semibold tracking-wide transition-colors duration-150 hover:bg-panel">
            Open the control room
          </Link>
        </div>
      </div>
    </section>
  );
}
