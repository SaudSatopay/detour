import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";
import { benchModel, causes, classify, errorText, liveChain, type ChainedModel, type ModelFailure } from "./models";
import type { Emit } from "./catalog";

export { isDailyQuota } from "./models";

interface RunOptions {
  agent: string;
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  emit: Emit;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}

interface RunResult {
  text: string;
  steps: number;
  model: string | null;
}

/**
 * The agent loop, one model call per step so a rate-limited provider can be swapped for the next
 * one mid-run without losing the conversation. Tools execute inside each step (they emit their own
 * events); the model's narration streams out as text events.
 */
export async function runAgent({ agent, instructions, messages, tools, emit, maxSteps = 12, abortSignal }: RunOptions): Promise<RunResult> {
  const chain = await liveChain();
  if (!chain.length) throw new NoModelError();
  let current = 0;
  const history: ModelMessage[] = [...messages];
  let finalText = "";
  emit({ type: "model", agent, model: chain[current].id });

  for (let step = 1; step <= maxSteps; step++) {
    const stepOut = await stepWithFallback(chain, () => current, (i) => (current = i), {
      agent,
      instructions,
      history,
      tools,
      emit,
      abortSignal,
      maxWaitMs: step === 1 ? FIRST_STEP_WAIT_MS : MAX_WAIT_MS,
    });
    history.push(...stepOut.messages);
    if (stepOut.text.trim()) finalText = stepOut.text;
    if (stepOut.finishReason !== "tool-calls") {
      return { text: finalText, steps: step, model: chain[current].id };
    }
  }
  return { text: finalText, steps: maxSteps, model: chain[current].id };
}

/** Longest one step waits out the last model's rate limit before the run gives up. */
const MAX_WAIT_MS = 60_000;
/**
 * The first step waits only for a short, explicit retry delay: with no progress yet, a visitor would rather see
 * the standard procedure start at once than watch an empty room while a quota recovers.
 */
const FIRST_STEP_WAIT_MS = 8_000;

/** The wait a rate-limited provider asks for (a Retry-After header, or Gemini's "retry in 41.2s"), else a backoff. */
export function retryDelayMs(error: unknown, attempt: number): number {
  for (const e of causes(error)) {
    const header = Number(e.responseHeaders?.["retry-after"]);
    if (header > 0) return header * 1000;
  }
  const text = errorText(error);
  const asked = /retry in ([\d.]+)\s*s/i.exec(text) ?? /"retryDelay":\s*"([\d.]+)s"/.exec(text);
  if (asked) return Math.ceil(Number(asked[1]) * 1000);
  return 5_000 * 2 ** attempt;
}

/** Whether the provider said how long to wait (a short wait is worth it even on the first step). */
function asksForDelay(error: unknown): boolean {
  return causes(error).some((e) => Number(e.responseHeaders?.["retry-after"]) > 0) || /retry in [\d.]+\s*s|"retryDelay"/i.test(errorText(error));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class NoModelError extends Error {
  constructor() {
    super("No free model can answer right now: none is configured, or every one has spent its daily quota.");
    this.name = "NoModelError";
  }
}

/** What a visitor reads when the run moves to the next model. */
const SWITCH_REASON: Record<Exclude<ModelFailure, "other">, string> = {
  daily: "its daily free quota is spent",
  missing: "the provider no longer serves it",
  rate: "it is rate limited",
};

async function stepWithFallback(
  chain: ChainedModel[],
  getCurrent: () => number,
  setCurrent: (i: number) => void,
  o: { agent: string; instructions: string; history: ModelMessage[]; tools: ToolSet; emit: Emit; abortSignal?: AbortSignal; maxWaitMs: number },
): Promise<{ messages: ModelMessage[]; finishReason: string; text: string }> {
  let waited = 0;
  let attempt = 0;
  for (;;) {
    const m = chain[getCurrent()];
    try {
      const result = streamText({
        model: m.model,
        instructions: o.instructions,
        messages: o.history,
        tools: o.tools,
        stopWhen: isStepCount(1),
        maxRetries: 1,
        abortSignal: o.abortSignal,
      });
      let text = "";
      for await (const part of result.stream) {
        if (part.type === "text-delta") {
          text += part.text;
          o.emit({ type: "text", agent: o.agent, delta: part.text });
        } else if (part.type === "error") {
          throw part.error;
        }
      }
      const messages = await result.responseMessages;
      const finishReason = await result.finishReason;
      if (text) o.emit({ type: "text", agent: o.agent, delta: "\n" });
      return { messages, finishReason, text };
    } catch (error) {
      const failure = classify(error);
      if (failure === "other") throw error;
      await benchModel(m.id, failure).catch(() => undefined);
      const next = getCurrent() + 1;
      if (next < chain.length) {
        setCurrent(next);
        o.emit({ type: "model", agent: o.agent, model: chain[next].id, reason: `${m.id.split(":").pop()}: ${SWITCH_REASON[failure]}` });
        continue;
      }
      // The last model in the chain: wait out a per-minute rate limit (a free tier allows a few calls a minute)
      // rather than end the run halfway, unless the wait it asks for would pass the cap. A spent daily quota or a
      // retired model will not come back within the run.
      if (failure !== "rate") throw error;
      if (o.maxWaitMs < MAX_WAIT_MS && !asksForDelay(error)) throw error;
      const delay = retryDelayMs(error, attempt++) + 500;
      if (waited + delay > o.maxWaitMs) throw error;
      o.emit({ type: "model", agent: o.agent, model: m.id, reason: `rate limited, waiting ${Math.round(delay / 1000)} s` });
      await sleep(delay, o.abortSignal);
      waited += delay;
    }
  }
}
