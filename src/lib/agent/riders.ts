import { generateText } from "ai";
import { loadNetwork } from "../network/data";
import { Tracer } from "../graph/trace";
import { describeCrowded, ridersAffected, routeRider, type RiderProfile, type RouteAnswer } from "../graph/tools/riders";
import { writeAdvisory } from "../graph/tools/plan";
import type { ToolContext } from "../graph/tools/types";
import { recordEpisode, type Emit } from "./catalog";
import { benchModel, classify, liveChain } from "./models";
import { RIDER_ADVISORY_INSTRUCTIONS } from "./prompts";

interface Advisory {
  riderId: string;
  name: string;
  text: string;
  minutes: number | null;
  stations: string[];
  stepFree: boolean;
  model: string | null;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function templateAdvisory(rider: RiderProfile, answer: RouteAnswer | null, names: Map<string, string>): string {
  if (!answer) return `No open route reaches ${names.get(rider.to)} right now${rider.stepFree ? " step-free" : ""}; the control desk is adding shuttle buses.`;
  const legs = answer.legs
    .map((l) => (l.kind === "WALK" ? `walk to ${names.get(l.to)}` : l.kind === "BUS" ? `take the shuttle bus to ${names.get(l.to)}` : `take the ${l.route} to ${names.get(l.to)}`))
    .join(", then ");
  return `${legs[0].toUpperCase()}${legs.slice(1)}. About ${Math.round(answer.minutes)} minutes${rider.stepFree ? ", step-free" : ""}.${avoidance(answer, names)}`;
}

/** The crowded rides a route keeps the rider off: " It avoids the G between Nassau Av and Court Sq-23 St, running at 244% of capacity." */
function avoidance(answer: RouteAnswer, names: Map<string, string>): string {
  if (!answer.avoids?.length) return "";
  return ` It avoids ${describeCrowded(answer.avoids, (id) => names.get(id) ?? id)}.`;
}

/**
 * The rider desk after a handoff: one agent per affected rider, run concurrently. Each routes its
 * rider on the current graph (closure, published shuttles, remembered elevator outages), then the
 * model phrases a two-sentence advisory, which is written back to the graph.
 */
export async function runRiderDesk(base: Omit<ToolContext, "tracer" | "agentId">, emit: Emit): Promise<Advisory[]> {
  const network = await loadNetwork();
  const names = new Map(network.stations.map((s) => [s.id, s.name]));
  const deskCtx: ToolContext = { ...base, agentId: "rider-desk", tracer: new Tracer() };
  emit({ type: "tool-call", agent: "rider-desk", id: "riders-affected", tool: "riders_affected", input: {} });
  const affected = await ridersAffected(deskCtx);
  emit({ type: "tool-result", agent: "rider-desk", id: "riders-affected", result: affected });
  const riders = affected.data.affected;
  const chain = await liveChain();

  return pool(riders, 3, async (rider) => {
    const agent = `rider:${rider.id}`;
    const ctx: ToolContext = { ...base, agentId: "rider-desk", tracer: new Tracer() };
    emit({ type: "tool-call", agent, id: `route-${rider.id}`, tool: "route_rider", input: { rider_id: rider.id, step_free: rider.stepFree } });
    const routed = await routeRider(ctx, { riderId: rider.id, stepFree: rider.stepFree });
    void recordEpisode(ctx, routed);
    emit({ type: "tool-result", agent, id: `route-${rider.id}`, result: routed });
    const answer = routed.data.answer;

    const facts = [
      `Rider: ${rider.name}, ${rider.persona}. Usual trip ${names.get(rider.from)} → ${names.get(rider.to)}, leaves ${rider.departs}, normally ${Math.round(rider.usualMinutes)} min.`,
      rider.stepFree ? "Needs step-free stations." : "",
      rider.preferences.length ? `Preferences: ${rider.preferences.map((p) => `${p.key} ${p.value}`).join("; ")}.` : "",
      `Route now: ${routed.summary}`,
      answer?.avoids?.length ? `Say why this route:${avoidance(answer, names)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let text = "";
    let model: string | null = null;
    for (const m of chain) {
      try {
        const res = await generateText({ model: m.model, instructions: RIDER_ADVISORY_INSTRUCTIONS, prompt: facts, maxRetries: 1 });
        text = res.text.trim();
        model = m.id;
        break;
      } catch (error) {
        const failure = classify(error);
        if (failure === "other") break;
        await benchModel(m.id, failure).catch(() => undefined);
      }
    }
    if (!text) text = templateAdvisory(rider, answer, names);
    // The rider is told why the route skips a faster line, whatever the model wrote.
    else if (answer?.avoids?.length && !/capacity|crowd/i.test(text)) text += avoidance(answer, names);

    await writeAdvisory(ctx, { riderId: rider.id, text, minutes: answer?.minutes ?? null, stations: answer?.stations ?? [], stepFree: rider.stepFree });
    emit({ type: "text", agent, delta: text });
    emit({ type: "done", agent, text, steps: 1, model });
    return { riderId: rider.id, name: rider.name, text, minutes: answer?.minutes ?? null, stations: answer?.stations ?? [], stepFree: rider.stepFree, model };
  });
}
