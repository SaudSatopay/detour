"use client";

import { useEffect, useState } from "react";
import { buildMapModel, type MapData, type MapModel } from "@/lib/network/map";

let cached: Promise<MapModel> | null = null;

function load(): Promise<MapModel> {
  cached ??= fetch("/map/nyc.json")
    .then((r) => {
      if (!r.ok) throw new Error(`Map data failed to load (${r.status})`);
      return r.json() as Promise<MapData>;
    })
    .then((data) => buildMapModel(data))
    .catch((error) => {
      cached = null;
      throw error;
    });
  return cached;
}

export function useMapModel(): { model: MapModel | null; error: string | null } {
  const [model, setModel] = useState<MapModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (m) => live && setModel(m),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, []);
  return { model, error };
}
