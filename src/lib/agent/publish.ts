import { Tracer } from "../graph/trace";
import { publishPlan } from "../graph/tools/plan";
import type { ToolContext } from "../graph/tools/types";
import { recordEpisode, type Emit } from "./catalog";
import { runRiderDesk } from "./riders";

/** Human approval: publishes the plan into the graph, hands off to the rider desk, runs one agent per affected rider. */
export async function publishAndAdvise(base: Omit<ToolContext, "tracer" | "agentId">, planId: string, emit: Emit): Promise<void> {
  const ctx = { ...base, agentId: "controller", tracer: new Tracer() };
  const published = await publishPlan(ctx, { planId, approvedBy: "dispatcher" });
  void recordEpisode(ctx, published);
  emit({ type: "tool-result", agent: "controller", id: "publish", result: published });
  if (published.outcome !== "answered") {
    emit({ type: "error", agent: "controller", message: published.summary });
    return;
  }
  emit({ type: "handoff", from: "controller", to: "rider-desk", note: "Plan published. Tell every remembered rider whose trip crosses the closure what to take instead." });
  const advisories = await runRiderDesk(base, emit);
  emit({ type: "done", agent: "rider-desk", text: `${advisories.length} advisories written.`, steps: advisories.length, model: null });
}
