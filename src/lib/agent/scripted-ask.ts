import { Tracer } from "../graph/trace";
import { resolvePlaces } from "../graph/tools/places";
import { routeRider } from "../graph/tools/riders";
import type { ToolContext, ToolResult } from "../graph/tools/types";
import { forClient, recordEpisode, type Emit } from "./catalog";

/**
 * The rider desk without a model: reads a trip question with plain rules, then uses the same tools on the visitor's
 * graph (resolve_places, route_rider) and answers from their results. A follow-up such as "and step-free?" reuses the
 * trip from the conversation the graph remembers.
 */
const RIDERS: Record<string, string> = { maya: "maya", dev: "dev", aisha: "aisha", tomás: "tomas", tomas: "tomas", grace: "grace", sam: "sam", lena: "lena", kwame: "kwame" };
const STEP_FREE = /step[- ]?free|wheelchair|accessib|elevator|lift|stroller|pram|no stairs/i;
const STOP = /\s+(?:step[- ]?free|by|avoiding|avoid|without|with|at|on|via|using|please|for|tomorrow|today|now)\b|[?.!,;]|$/i;

export interface TripQuestion {
  riderId?: string;
  from?: string;
  to?: string;
  stepFree: boolean;
  avoid: string[];
}

function before(text: string): string {
  const m = STOP.exec(text);
  return (m ? text.slice(0, m.index) : text).trim().replace(/^the\s+/i, "");
}

/** Reads a trip question: who, from where, to where, step-free or not, and lines to avoid. */
export function readTrip(question: string): TripQuestion {
  const q = question.trim();
  const rider = Object.keys(RIDERS).find((n) => new RegExp(`\\b${n}\\b`, "i").test(q));
  const avoid = [...q.matchAll(/\bavoid(?:ing)?\s+(?:the\s+)?([a-z0-9])(?:\s*(?:train|line))?\b/gi)].map((m) => m[1].toUpperCase());
  let from: string | undefined;
  let to: string | undefined;
  const between = /\bbetween\s+(.+?)\s+and\s+(.+)/i.exec(q);
  const fromTo = /\bfrom\s+(.+?)\s+to\s+(.+)/i.exec(q);
  // The last "to" before "from": in "I need to get to Jay St from Fulton St" the first one belongs to "need to".
  const toFrom = /\bto\s+((?:(?!\bto\s).)+?)\s+from\s+(.+)/i.exec(q);
  const bare = /^(?:how (?:do i|can i|to) get )?(.+?)\s+to\s+(.+)/i.exec(q);
  if (between) [from, to] = [before(between[1]), before(between[2])];
  else if (fromTo) [from, to] = [before(fromTo[1]), before(fromTo[2])];
  else if (toFrom) [to, from] = [before(toFrom[1]), before(toFrom[2])];
  else if (bare && !rider) [from, to] = [before(bare[1]), before(bare[2])];
  return { riderId: rider ? RIDERS[rider] : undefined, from: from || undefined, to: to || undefined, stepFree: STEP_FREE.test(q), avoid };
}

export async function scriptedAsk(
  base: Omit<ToolContext, "tracer">,
  question: string,
  emit: Emit,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<{ text: string; steps: number }> {
  const agent = "rider-desk";
  let seq = 0;
  const say = (text: string) => emit({ type: "text", agent, delta: `${text}\n\n` });
  const step = async <T>(tool: string, input: unknown, why: string, fn: (ctx: ToolContext) => Promise<ToolResult<T>>) => {
    const id = `${tool}-${++seq}`;
    emit({ type: "tool-call", agent, id, tool, input });
    const ctx: ToolContext = { ...base, tracer: new Tracer() };
    const r = await fn(ctx);
    emit({ type: "tool-result", agent, id, result: forClient(r) });
    void recordEpisode(ctx, r, { why, input, model: "standard procedure" });
    return r;
  };

  // A follow-up ("and step-free?") keeps the last trip asked about in this conversation.
  let trip = readTrip(question);
  if (!trip.riderId && !(trip.from && trip.to)) {
    const lastAsked = [...history].reverse().find((m) => m.role === "user");
    const earlier = lastAsked ? readTrip(lastAsked.content) : null;
    if (earlier && (earlier.riderId || (earlier.from && earlier.to))) {
      trip = { ...earlier, stepFree: trip.stepFree || earlier.stepFree, avoid: trip.avoid.length ? trip.avoid : earlier.avoid };
      say("Taking the trip from your last question.");
    }
  }

  if (!trip.riderId && !(trip.from && trip.to)) {
    const text =
      "Without a live model the rider desk answers trip questions. Name a remembered rider (Aisha, Dev, Maya, Tomás, Grace, Sam, Lena or Kwame), or ask “from <station> to <station>”, and add “step-free” if you need elevators.";
    say(text);
    return { text, steps: 0 };
  }

  let from: string | undefined;
  let to: string | undefined;
  if (!trip.riderId) {
    const why = `Resolving “${trip.from}” and “${trip.to}” against the graph before routing.`;
    say(why);
    const places = await step("resolve_places", { names: [trip.from, trip.to] }, why, (ctx) => resolvePlaces(ctx, { names: [trip.from!, trip.to!] }));
    const [a, b] = places.data.matches;
    if (a?.kind !== "station" || b?.kind !== "station") {
      const text = places.summary;
      say(text);
      return { text, steps: seq };
    }
    from = a.stations![0].id;
    to = b.stations![0].id;
    const unsure = places.data.matches.filter((m) => m.ambiguous).map((m) => `“${m.query}” could be ${m.stations!.map((s) => s.label).join(" or ")}; I used ${m.stations![0].label}`);
    if (unsure.length) say(`${unsure.join(". ")}. Name the line to pick another.`);
  }

  const why = trip.riderId
    ? `Routing ${trip.riderId[0].toUpperCase()}${trip.riderId.slice(1)}'s usual trip on the graph as it stands now${trip.stepFree ? ", step-free" : ""}.`
    : `Finding the fastest open route${trip.stepFree ? " with step-free stations" : ""}${trip.avoid.length ? ` that avoids the ${trip.avoid.join(" and ")}` : ""}.`;
  say(why);
  const routed = await step(
    "route_rider",
    { rider_id: trip.riderId, from_station_id: from, to_station_id: to, step_free: trip.stepFree || undefined, avoid_routes: trip.avoid.length ? trip.avoid : undefined },
    why,
    (ctx) => routeRider(ctx, { riderId: trip.riderId, from, to, stepFree: trip.stepFree || undefined, avoidRoutes: trip.avoid.length ? trip.avoid : undefined }),
  );
  const text = routed.summary;
  say(text);
  return { text, steps: seq };
}
