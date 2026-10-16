"use client";

import { useEffect, useMemo, useState } from "react";
import type { FlowHighlight } from "@/lib/graph/tools/types";
import { SubwayMap, type MapOverlay, type Overloaded } from "./subway-map";
import { useMapModel } from "./use-map-model";

interface Hero {
  closedEids: number[];
  flows: FlowHighlight[];
  overloaded: Overloaded[];
  displaced: number;
  stranded: number;
  peak: { required: number; absorbed: number; unmet: number };
}

const FOCUS = ["120", "119", "118", "602", "601", "618", "629", "283", "282", "606", "612", "625", "101", "630", "621"];

type Stage = 0 | 1 | 2;

/** The landing page's signature moment: the L tube closes and the displaced riders' flow finds the lines that can take it. */
export function HeroMap({ className = "" }: { className?: string }) {
  const { model, error } = useMapModel();
  const [hero, setHero] = useState<Hero | null>(null);
  const [stage, setStage] = useState<Stage>(0);

  useEffect(() => {
    let live = true;
    fetch("/map/hero-l-canarsie.json")
      .then((r) => (r.ok ? (r.json() as Promise<Hero>) : null))
      .then((h) => live && setHero(h))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!hero || !model) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers = reduce ? [setTimeout(() => setStage(2), 0)] : [setTimeout(() => setStage(1), 500), setTimeout(() => setStage(2), 1300)];
    return () => timers.forEach(clearTimeout);
  }, [hero, model]);

  const overlay: MapOverlay = useMemo(() => {
    if (!hero || stage === 0) return {};
    if (stage === 1) return { closedEids: hero.closedEids };
    return { closedEids: hero.closedEids, flows: hero.flows, overloaded: hero.overloaded };
  }, [hero, stage]);

  const worst = hero?.overloaded.reduce((a, b) => (b.pct > a.pct ? b : a), hero.overloaded[0]);
  const worstSeg = worst && model ? model.segments.get(worst.id) : undefined;
  const worstName = worstSeg && model ? `${worstSeg.route} ${model.stations.get(worstSeg.from)?.name} → ${model.stations.get(worstSeg.to)?.name}` : null;

  if (error) {
    return <div className={`grid place-items-center bg-sunk text-sm text-ink-500 ${className}`}>The map could not load. Reload to try again.</div>;
  }
  return (
    <figure className={`relative overflow-hidden ${className}`}>
      {model ? (
        <SubwayMap
          model={model}
          overlay={overlay}
          focus={FOCUS}
          className="h-full w-full"
          label="The L train closed between Bedford Av and 8 Av. Displaced riders' fastest alternatives overload the G train between Metropolitan Av and Court Sq."
          showLabels="major"
        />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-sunk" aria-busy="true" />
      )}
      <figcaption className="pointer-events-none absolute bottom-3 left-3 max-w-[min(22rem,calc(100%-4.5rem))] rounded-md border border-line bg-panel/95 p-3 shadow-lift sm:bottom-auto sm:top-3">
        <p className="label text-crit">L closed · Bedford Av to 8 Av · 8 a.m.</p>
        {hero ? (
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-500">Displaced</dt>
            <dd className="tabular font-mono text-ink-900">{hero.displaced.toLocaleString("en-US")}/h</dd>
            <dt className="text-ink-500">No rail path</dt>
            <dd className="tabular font-mono text-ink-900">{hero.stranded.toLocaleString("en-US")}/h</dd>
            {worst && worstName ? (
              <>
                <dt className="text-ink-500">Worst overload</dt>
                <dd className="tabular font-mono text-crit">{worst.pct}%</dd>
                <dd className="col-span-2 text-xs text-ink-500">{worstName}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </figcaption>
    </figure>
  );
}
