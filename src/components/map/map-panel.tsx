"use client";

import { SubwayMap, type LabelExclusion, type MapOverlay } from "./subway-map";
import { useMapModel } from "./use-map-model";

interface Props {
  overlay?: MapOverlay;
  focus?: string[];
  label: string;
  className?: string;
  interactive?: boolean;
  selected?: string | null;
  onSelect?: (id: string) => void;
  exclude?: LabelExclusion[];
}

/** Loads the network once and shows a quiet skeleton until it arrives. */
export function MapPanel({ overlay, focus, label, className = "", interactive, selected, onSelect, exclude }: Props) {
  const { model, error } = useMapModel();
  if (error) {
    return (
      <div className={`grid place-items-center bg-sunk text-sm text-ink-500 ${className}`} role="alert">
        The map could not load ({error}). Reload the page to try again.
      </div>
    );
  }
  if (!model) {
    return (
      <div className={`relative overflow-hidden bg-sunk ${className}`} aria-busy="true" aria-label="Loading the subway map">
        <div className="absolute inset-0 animate-pulse bg-[linear-gradient(90deg,transparent,var(--line),transparent)] opacity-40" />
      </div>
    );
  }
  return <SubwayMap model={model} overlay={overlay} focus={focus} label={label} className={className} interactive={interactive} selected={selected} onSelect={onSelect} exclude={exclude} />;
}
