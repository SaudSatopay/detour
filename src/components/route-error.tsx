"use client";

import Link from "next/link";

/** The designed failure state for pages that depend on the graph database or a model. */
export function RouteError({ where, retry }: { where: string; retry: () => void }) {
  return (
    <div className="mx-auto flex min-h-[60dvh] w-full max-w-prose flex-col justify-center gap-4 px-4 py-16">
      <p className="label text-crit">Something broke in the {where}</p>
      <h1 className="font-display text-4xl font-bold leading-tight">The page stopped before it finished.</h1>
      <p className="text-ink-700">
        Usually the free graph database is waking up or a free model hit its limit. Try again in a few seconds; your sandbox keeps everything that
        was already done.
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={retry} className="rounded-md bg-ink-900 px-4 py-2 font-display text-lg font-semibold tracking-wide text-paper">
          Try again
        </button>
        <Link href="/proof" className="rounded-md border border-line-strong px-4 py-2 font-display text-lg font-semibold tracking-wide text-ink-900">
          See the proof instead
        </Link>
      </div>
    </div>
  );
}
