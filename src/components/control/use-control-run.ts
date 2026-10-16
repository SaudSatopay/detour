"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AgentEvent } from "@/lib/agent/catalog";
import { readNdjson } from "@/lib/client/ndjson";
import { initialRun, reduce } from "./run-state";

/** Starts controller runs and approvals, and folds their event streams into one timeline. */
export function useControlRun() {
  const [state, dispatch] = useReducer(reduce, initialRun);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const stream = useCallback(async (url: string, body: unknown, scenarioId?: string) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const message = await res
          .json()
          .then((j: { error?: string }) => j.error)
          .catch(() => null);
        dispatch({ type: "fail", message: message ?? `The server answered ${res.status}. Try again in a moment.` });
        return;
      }
      await readNdjson<AgentEvent>(res, (event) => dispatch({ type: "event", event, scenarioId }));
      dispatch({ type: "settle" });
    } catch {
      if (ctrl.signal.aborted) return;
      dispatch({ type: "fail", message: "The connection dropped before the run finished. Run it again; your sandbox keeps what was already done." });
    }
  }, []);

  const run = useCallback(
    (input: { message: string; scenarioId?: string; replay?: boolean }) => {
      dispatch({ type: "start", stage: "control" });
      return stream("/api/agent", { mode: "control", message: input.message, scenarioId: input.scenarioId, replay: input.replay }, input.scenarioId);
    },
    [stream],
  );

  const approve = useCallback(
    (planId: string, recorded: string | null) => {
      dispatch({ type: "start", stage: "desk", planId });
      return stream("/api/plan/publish", { planId, recorded: recorded ?? undefined });
    },
    [stream],
  );

  const clear = useCallback(() => {
    abort.current?.abort();
    dispatch({ type: "reset" });
  }, []);

  return { state, run, approve, clear };
}
