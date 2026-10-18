import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { blockModel, blockedModels } from "@/lib/graph/meta";

/**
 * Free-tier models, tried in order. On the free tiers each model has a quota of its own, so a chain of several
 * outlasts any one of them: the Gemini models first, then Groq's when GROQ_API_KEY is set. A model whose daily quota
 * is spent, or that the provider no longer serves, is skipped by every run until it can answer again.
 *
 * Override the list with AGENT_MODELS ("provider:model,provider:model"), or put one model first with
 * AGENT_MODEL_PRIMARY (and one last with AGENT_MODEL_FALLBACK).
 */
export interface ChainedModel {
  id: string;
  model: LanguageModel;
}

const DEFAULTS = [
  "google:gemini-flash-latest",
  "google:gemini-flash-lite-latest",
  "google:gemini-2.5-flash",
  "google:gemini-2.5-flash-lite",
  "groq:openai/gpt-oss-120b",
  "groq:moonshotai/kimi-k2-instruct-0905",
  "groq:llama-3.3-70b-versatile",
];

/** The model specs to try, in order, without repeats. */
export function chainSpecs(env: Record<string, string | undefined> = process.env): string[] {
  const listed = env.AGENT_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
  const specs = listed?.length
    ? listed
    : [...(env.AGENT_MODEL_PRIMARY ? [env.AGENT_MODEL_PRIMARY] : []), ...DEFAULTS, ...(env.AGENT_MODEL_FALLBACK ? [env.AGENT_MODEL_FALLBACK] : [])];
  return [...new Set(specs)];
}

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

/** Every configured model, whether or not its quota is spent. */
export function modelChain(): ChainedModel[] {
  return chainSpecs()
    .map(build)
    .filter((m): m is ChainedModel => m !== null);
}

export function hasLiveModel(): boolean {
  return modelChain().length > 0;
}

/** Models cooling off after a per-minute rate limit, on this server instance only (a minute is not worth a write). */
const cooling = new Map<string, number>();

/** The configured models that can answer now: not past a daily quota, not retired, not cooling off. */
export async function liveChain(now = Date.now()): Promise<ChainedModel[]> {
  const chain = modelChain();
  if (!chain.length) return chain;
  const blocked = await blockedModels(now).catch(() => new Map<string, number>());
  return chain.filter((m) => !blocked.has(m.id) && !((cooling.get(m.id) ?? 0) > now));
}

/**
 * How long until a model that is only cooling off after a per-minute limit can answer again, or null when every
 * unavailable model is out for longer (a spent daily quota, a retired model) or none is configured.
 */
export async function soonestModelMs(now = Date.now()): Promise<number | null> {
  const blocked = await blockedModels(now).catch(() => new Map<string, number>());
  const waits = modelChain()
    .filter((m) => !blocked.has(m.id))
    .map((m) => (cooling.get(m.id) ?? 0) - now)
    .filter((w) => w > 0);
  return waits.length ? Math.min(...waits) : null;
}

/** Whether any model can answer now: false sends a run straight to the standard procedure. */
export async function liveModelAvailable(): Promise<boolean> {
  return (await liveChain()).length > 0;
}

/**
 * Takes a failed model out of the chain for as long as its failure lasts: until the provider's daily reset, a day
 * for a model the provider does not serve, a minute for a per-minute rate limit.
 */
export async function benchModel(id: string, failure: ModelFailure, now = Date.now()): Promise<void> {
  if (failure === "rate") {
    cooling.set(id, now + 60_000);
    return;
  }
  if (failure === "daily") await blockModel(id, id.startsWith("google:") ? nextPacificMidnight(now) : now + 3_600_000, "daily quota spent");
  else if (failure === "missing") await blockModel(id, now + 86_400_000, "not served by the provider");
}

type ProviderError = {
  message?: string;
  statusCode?: number;
  status?: number;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  lastError?: unknown;
  errors?: unknown[];
  cause?: unknown;
};

/** The error and the provider errors it wraps (the AI SDK's retry error keeps them in lastError and errors). */
export function causes(error: unknown, depth = 0): ProviderError[] {
  if (!error || typeof error !== "object" || depth > 3) return [];
  const e = error as ProviderError;
  return [e, ...causes(e.lastError, depth + 1), ...(e.errors ?? []).flatMap((x) => causes(x, depth + 1)), ...causes(e.cause, depth + 1)];
}

export const errorText = (error: unknown) => {
  const found = causes(error);
  return (found.length ? found.map((e) => `${e.message ?? ""} ${e.responseBody ?? ""}`) : [String(error)]).join(" ");
};

/** A provider's daily cap (Gemini names the quota "...PerDay..."): waiting a minute will not lift it. */
export function isDailyQuota(error: unknown): boolean {
  return /per ?day|daily|tokens per day|requests per day|\bTPD\b|\bRPD\b/i.test(errorText(error));
}

/**
 * Why a model failed:
 *   daily    its daily quota is spent
 *   missing  the provider does not serve it (retired, renamed, or no tool calling)
 *   rate     a per-minute limit, an overload or a timeout: worth trying again soon
 *   other    a real error, not the model's availability
 */
export type ModelFailure = "daily" | "missing" | "rate" | "other";

export function classify(error: unknown): ModelFailure {
  const all = causes(error);
  const statuses = all.map((e) => e.statusCode ?? e.status).filter((s): s is number => typeof s === "number");
  const text = errorText(error).toLowerCase();
  if (
    statuses.includes(404) ||
    /model[^.]{0,40}(not found|does not exist|is not supported|decommissioned|deprecated|retired)|model_not_found|unsupported model|(function calling|tool use|tools?) (is )?not (enabled|supported)|does not support (tools|function)/.test(text)
  ) {
    return "missing";
  }
  if (isDailyQuota(error) && (statuses.includes(429) || /quota|exhaust|limit/.test(text))) return "daily";
  if (statuses.some((s) => s === 429 || s === 408 || s >= 500)) return "rate";
  if (/rate|quota|exhaust|overload|unavailable|timeout|timed out|too many|capacity|429/.test(text)) return "rate";
  return "other";
}

/** True for errors worth trying on the next model: anything about the model's availability rather than the request. */
export function isRetryable(error: unknown): boolean {
  return classify(error) !== "other";
}

/** When Gemini's free daily quotas reset: midnight in Los Angeles, plus a minute's margin. */
export function nextPacificMidnight(now = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const intoDay = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + (now % 1000);
  return now - intoDay + 86_400_000 + 60_000;
}
