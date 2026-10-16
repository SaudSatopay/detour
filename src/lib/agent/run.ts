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
      const next = getCurrent() + 1;
      if (isRetryable(error) && next < chain.length) {
        setCurrent(next);
        o.emit({ type: "model", agent: o.agent, model: chain[next].id, reason: "rate limited, switching provider" });
        continue;
      }
      throw error;
    }
  }
}
