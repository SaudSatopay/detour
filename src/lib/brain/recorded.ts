import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrainAnswer, BrainDirectory } from "./types";

/**
 * The brain's answers recorded on the deployment (scripts/record-brain.ts): the directory and the suggested questions,
 * answered by the standard procedure on a fresh visitor's graph. When the graph database is unreachable, the brain page
 * shows these instead of nothing, labeled as recorded with their date, as the control room plays its recorded runs.
 */
export interface BrainRecording {
  recordedAt: string;
  directory: BrainDirectory;
  answers: BrainAnswer[];
}

const file = () => join(/* turbopackIgnore: true */ process.cwd(), "data", "replays", "brain.json");

let loaded: Promise<BrainRecording | null> | null = null;

export function brainRecording(): Promise<BrainRecording | null> {
  loaded ??= readFile(file(), "utf8")
    .then((text) => JSON.parse(text) as BrainRecording)
    .catch(() => null);
  return loaded;
}

/** Questions compared without case, punctuation or spacing, so "Is the elevator at Times Sq-42 St working" matches. */
export const sameQuestion = (a: string, b: string) => norm(a) === norm(b);
const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The directory as recorded, for a visitor whose graph cannot be reached. */
export async function recordedDirectory(): Promise<BrainDirectory | null> {
  const r = await brainRecording();
  return r ? { ...r.directory, history: [], recorded: { at: r.recordedAt } } : null;
}

/** The recorded answer to this question, if there is one. */
export async function recordedAnswer(question: string): Promise<BrainAnswer | null> {
  const r = await brainRecording();
  const hit = r?.answers.find((a) => sameQuestion(a.question, question));
  if (!r || !hit) return null;
  const who = hit.mode === "live" && hit.model ? `${hit.model.split(":").pop()}'s answer` : "the standard procedure's answer";
  return {
    ...hit,
    mode: "recorded",
    recordedAt: r.recordedAt,
    note: `The graph database is unreachable right now, so this is ${who}, recorded on ${day(r.recordedAt)} from the same graph tools.`,
    followUp: null,
  };
}
