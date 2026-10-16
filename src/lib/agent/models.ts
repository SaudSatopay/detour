import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

/**
 * Free-tier model chain, tried in order: Gemini first, Groq when Gemini is rate limited.
 * Override with AGENT_MODEL_PRIMARY / AGENT_MODEL_FALLBACK as "provider:model".
 */
export interface ChainedModel {
  id: string;
  model: LanguageModel;
}

const DEFAULTS = ["google:gemini-flash-latest", "groq:openai/gpt-oss-120b"];

function build(spec: string): ChainedModel | null {
  const [provider, ...rest] = spec.split(":");
  const name = rest.join(":");
  if (!name) return null;
  if (provider === "google" && process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return { id: spec, model: createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY })(name) };
  }
  if (provider === "groq" && process.env.GROQ_API_KEY) {
    return { id: spec, model: createGroq({ apiKey: process.env.GROQ_API_KEY })(name) };
  }
  return null;
}

export function modelChain(): ChainedModel[] {
  const specs = [process.env.AGENT_MODEL_PRIMARY ?? DEFAULTS[0], process.env.AGENT_MODEL_FALLBACK ?? DEFAULTS[1]];
  return specs.map(build).filter((m): m is ChainedModel => m !== null);
}

export function hasLiveModel(): boolean {
  return modelChain().length > 0;
}

/** True for errors worth retrying on the next model: rate limits, quota, overload, timeouts. */
export function isRetryable(error: unknown): boolean {
  const e = error as { statusCode?: number; status?: number; message?: string; cause?: unknown } | null;
  const status = e?.statusCode ?? e?.status;
  if (status === 429 || status === 408 || (status !== undefined && status >= 500)) return true;
  const text = `${e?.message ?? ""} ${String(e?.cause ?? "")}`.toLowerCase();
  return /rate|quota|exhaust|overload|unavailable|timeout|timed out|too many|capacity|429/.test(text);
}
