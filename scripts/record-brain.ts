/**
 * Records the brain for when the graph database is unreachable: the directory and the answers to its suggested
 * questions (and the README's), from one fresh visitor on a deployment, answered by the standard procedure so no
 * model quota is spent. Writes data/replays/brain.json, which /api/brain serves, labeled as recorded, only when it
 * cannot reach the graph.
 *
 *   pnpm tsx scripts/record-brain.ts [https://detour-orpin.vercel.app]
 */
import { writeFileSync } from "node:fs";
import type { BrainAnswer, BrainDirectory } from "../src/lib/brain/types";
import type { BrainRecording } from "../src/lib/brain/recorded";

const ALSO = [
  "Is the elevator at Times Sq-42 St working?",
  "Which stations on the A have an elevator out of service?",
  "Who owns the Myrtle-Wyckoff elevator outage?",
  "Why do L tube bus bridges get 27% more buses?",
  "What changed in the last 7 days?",
  "Who maintains elevator EL293?",
  "What is the MTA's alternative route when elevator EL293 is out?",
];

async function main() {
  const base = (process.argv[2] ?? "https://detour-orpin.vercel.app").replace(/\/+$/, "");
  let cookie = "";
  const call = async <T>(init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}/api/brain`, {
      ...init,
      headers: { "content-type": "application/json", "x-detour-no-model": "1", ...(cookie ? { cookie } : {}), ...(init?.headers ?? {}) },
    });
    // One visitor for the whole recording: one sandbox on the deployment.
    const set = res.headers.get("set-cookie");
    if (set && !cookie) cookie = set.split(";")[0];
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok || body.error) throw new Error(`/api/brain answered ${res.status}: ${body.error ?? "no body"}`);
    return body;
  };

  const directory = await call<BrainDirectory>();
  if (directory.recorded) throw new Error("The deployment is serving its own recording: its graph database is unreachable. Try again later.");
  const questions = [...new Set([...directory.suggestions, ...ALSO])];
  const answers: BrainAnswer[] = [];
  for (const question of questions) {
    const a = await call<BrainAnswer>({ method: "POST", body: JSON.stringify({ question }) });
    if (a.mode === "recorded") throw new Error("The deployment answered from its recording: its graph database is unreachable.");
    answers.push({ ...a, question, followUp: null });
    console.log(`${a.mode.padEnd(8)} ${a.sources.length} sources  ${question}`);
  }
  const recording: BrainRecording = { recordedAt: new Date().toISOString(), directory: { ...directory, history: [], recorded: null }, answers };
  writeFileSync("data/replays/brain.json", JSON.stringify(recording, null, 1) + "\n");
  console.log(`${answers.length} answers → data/replays/brain.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
