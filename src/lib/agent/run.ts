import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";
import { isRetryable, modelChain, type ChainedModel } from "./models";
import type { Emit } from "./catalog";

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
  const chain = modelChain();
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

/** The wait a rate-limited provider asks for (a Retry-After header, or Gemini's "retry in 41.2s"), else a backoff. */
export function retryDelayMs(error: unknown, attempt: number): number {
  const e = error as { message?: string; responseBody?: string; responseHeaders?: Record<string, string> } | null;
  const header = Number(e?.responseHeaders?.["retry-after"]);
  if (header > 0) return header * 1000;
  const text = `${e?.message ?? ""} ${e?.responseBody ?? ""}`;
  const asked = /retry in ([\d.]+)\s*s/i.exec(text) ?? /"retryDelay":\s*"([\d.]+)s"/.exec(text);
  if (asked) return Math.ceil(Number(asked[1]) * 1000);
  return 5_000 * 2 ** attempt;
}

/** A provider's daily cap (Gemini names the quota "...PerDay..."): waiting a minute will not lift it. */
export function isDailyQuota(error: unknown): boolean {
  const e = error as { message?: string; responseBody?: string } | null;
  return /per ?day|daily/i.test(`${e?.message ?? ""} ${e?.responseBody ?? ""}`);
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

class NoModelError extends Error {
  constructor() {
    super("No LLM key is configured (GOOGLE_GENERATIVE_AI_API_KEY or GROQ_API_KEY).");
    this.name = "NoModelError";
  }
}

async function stepWithFallback(
  chain: ChainedModel[],
  getCurrent: () => number,
  setCurrent: (i: number) => void,
  o: { agent: string; instructions: string; history: ModelMessage[]; tools: ToolSet; emit: Emit; abortSignal?: AbortSignal },
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
      if (!isRetryable(error)) throw error;
      const next = getCurrent() + 1;
      if (next < chain.length) {
        setCurrent(next);
        o.emit({ type: "model", agent: o.agent, model: chain[next].id, reason: "rate limited, switching provider" });
        continue;
      }
      // The last model in the chain: wait out its rate limit (a free tier allows a few calls a minute) rather
      // than end the run halfway, unless the wait it asks for would pass the cap.
      if (isDailyQuota(error)) throw error;
      const delay = retryDelayMs(error, attempt++) + 500;
      if (waited + delay > MAX_WAIT_MS) throw error;
      o.emit({ type: "model", agent: o.agent, model: m.id, reason: `rate limited, waiting ${Math.round(delay / 1000)} s` });
      await sleep(delay, o.abortSignal);
      waited += delay;
    }
  }
}
