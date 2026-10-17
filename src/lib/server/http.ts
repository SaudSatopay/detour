import { cookies } from "next/headers";
import { bump } from "../graph/meta";
import { isVisitorId, newVisitorId, VISITOR_COOKIE, VISITOR_MAX_AGE } from "../graph/names";

/**
 * Anonymous visitor id (one sandbox graph each), kept in an httpOnly cookie for a week. The proxy
 * sets it on the first request, so parallel API calls from a new visitor share one sandbox.
 */
export async function visitorId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(VISITOR_COOKIE)?.value;
  if (existing && isVisitorId(existing)) return existing;
  const id = newVisitorId();
  store.set(VISITOR_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: VISITOR_MAX_AGE, path: "/" });
  return id;
}

/** Streams newline-delimited JSON events; errors become a final error event instead of a broken stream. */
export function ndjson<E>(run: (emit: (event: E) => void) => Promise<void>, onError: (message: string) => E): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: E) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        await run(emit);
      } catch (error) {
        emit(onError(friendlyError(error)));
      } finally {
        open = false;
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/FALKORDB_URL/.test(message)) return message;
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Socket closed|connect/i.test(message)) {
    return "Can't reach the graph database right now. If the free FalkorDB instance went to sleep, it wakes on the next try; retry in a few seconds.";
  }
  if (/rate|quota|429/i.test(message)) return "Every free model is rate limited at the moment. Retry in a minute, or play a recorded run.";
  return message;
}

/**
 * A fixed-window limiter kept in the graph database's bookkeeping graph: keeps one visitor from spending the
 * shared free model quota.
 */
export async function allow(visitorId: string, bucket: string, perHour: number): Promise<boolean> {
  const n = await bump(`rl:${bucket}:${visitorId}:${Math.floor(Date.now() / 3_600_000)}`, 3_700_000);
  return n <= perHour;
}
