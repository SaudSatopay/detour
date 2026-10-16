"use client";

import { useCallback, useEffect, useState } from "react";
import type { SandboxState } from "@/lib/graph/state";

type Loaded = { state: SandboxState; error: null } | { state: null; error: string };

async function load(fallback: string): Promise<Loaded> {
  try {
    const res = await fetch(`/api/sandbox?recorded=${fallback}`, { cache: "no-store" });
    const body = (await res.json()) as SandboxState & { error?: string };
    if (!res.ok) return { state: null, error: body.error ?? `The server answered ${res.status}.` };
    return { state: body, error: null };
  } catch {
    return { state: null, error: "The server did not answer. Check your connection and reload." };
  }
}

/**
 * The visitor's sandbox graph as the riders and memory pages read it. When the database is unreachable
 * the server sends the state recorded with a preset run, marked with `recorded`.
 */
export function useSandbox(fallback = "l-canarsie") {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let live = true;
    load(fallback).then((res) => {
      if (!live) return;
      setLoaded(res);
      setRefreshing(false);
    });
    return () => {
      live = false;
    };
  }, [fallback, nonce]);

  const reload = useCallback(() => {
    setRefreshing(true);
    setNonce((n) => n + 1);
  }, []);

  return { state: loaded?.state ?? null, error: loaded?.error ?? null, loading: loaded === null, refreshing, reload };
}
