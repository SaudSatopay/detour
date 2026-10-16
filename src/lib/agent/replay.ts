import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, Emit } from "./catalog";

/**
 * Recorded runs, played back when no model key is configured or the free quota is spent.
 * A recording is a real live run captured with RECORD_REPLAYS=1; the UI labels it as a replay.
 */
const dir = () => join(process.cwd(), "data", "replays");
const fileFor = (scenarioId: string, mode: string) => join(dir(), `${scenarioId}-${mode}.ndjson`);

interface Recorded {
  t: number;
  event: AgentEvent;
}

export function recorder(scenarioId: string | undefined, mode: string, emit: Emit): { emit: Emit; save: () => Promise<void> } {
  if (process.env.RECORD_REPLAYS !== "1" || !scenarioId) return { emit, save: async () => {} };
  const started = Date.now();
  const lines: Recorded[] = [];
  return {
    emit: (event) => {
      lines.push({ t: Date.now() - started, event });
      emit(event);
    },
    save: async () => {
      await mkdir(dir(), { recursive: true });
      await writeFile(fileFor(scenarioId, mode), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    },
  };
}

export async function replayRun(scenarioId: string | undefined, mode: string, emit: Emit, signal?: AbortSignal): Promise<void> {
  const agent = mode === "control" ? "controller" : "rider-desk";
  let text: string;
  try {
    text = await readFile(fileFor(scenarioId ?? "none", mode), "utf8");
  } catch {
    emit({
      type: "error",
      agent,
      message: scenarioId
        ? "Live agents are paused (no free model quota left) and this scenario has no recording yet. Try a preset scenario or come back in a minute."
        : "Live agents are paused (no free model quota left). Pick one of the preset scenarios to watch a recorded run.",
    });
    return;
  }
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Recorded);
  let last = 0;
  for (const { t, event } of lines) {
    if (signal?.aborted) return;
    if (event.type === "run") continue;
    const wait = Math.min(1200, Math.max(0, t - last));
    last = t;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    emit(event);
  }
}
