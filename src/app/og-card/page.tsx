import type { Metadata } from "next";
import { HeroMap } from "@/components/map/hero-map";
import { DetourMark } from "@/components/site-header";
import { FACTS, fmt } from "@/lib/facts";

/** The 1200x630 social card, screenshotted into public/og.png by scripts/og.mjs. Not linked from the site. */
export const metadata: Metadata = { title: "Social card", robots: { index: false, follow: false } };

const L = FACTS.l;

export default function OgCard() {
  return (
    <div className="flex min-h-[100dvh] items-start justify-start bg-sunk p-6">
      <div id="og" className="flex h-[630px] w-[1200px] shrink-0 flex-col overflow-hidden bg-paper text-ink-900" data-theme="light">
        <div className="sign-band flex h-16 shrink-0 items-center gap-3 px-10">
          <DetourMark className="size-8" />
          <span className="font-display text-3xl font-bold tracking-wide">Detour</span>
          <span className="label ml-auto text-sign-ink/80">Graph Hacks · FalkorDB · Tracks 1 and 2</span>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[540px_1fr]">
          <div className="flex flex-col justify-between px-10 pb-9 pt-8">
            <h1 className="font-display text-[3.4rem] font-bold leading-[0.98] tracking-tight">When a subway line breaks, measure what the city can still carry.</h1>
            <dl className="grid grid-cols-3 gap-5 border-t border-line pt-5">
              <div>
                <dt className="label text-ink-500">Displaced</dt>
                <dd className="tabular font-display text-4xl font-bold">{fmt(L.displaced)}</dd>
                <dd className="text-sm text-ink-500">riders an hour</dd>
              </div>
              <div>
                <dt className="label text-ink-500">Worst overload</dt>
                <dd className="tabular font-display text-4xl font-bold text-crit">{L.worstPct}%</dd>
                <dd className="text-sm text-ink-500">on the {L.worstRoute}</dd>
              </div>
              <div>
                <dt className="label text-ink-500">Max flow</dt>
                <dd className="tabular font-display text-4xl font-bold">{Math.round((L.absorbed / L.required) * 100)}%</dd>
                <dd className="text-sm text-ink-500">can still move</dd>
              </div>
            </dl>
          </div>
          <div className="relative min-h-0 border-l border-line">
            <HeroMap className="absolute inset-0" />
          </div>
        </div>
      </div>
    </div>
  );
}
