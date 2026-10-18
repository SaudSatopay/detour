import { redact } from "../graph/db";
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

/**
 * Streams newline-delimited JSON events; errors become a final error event instead of a broken stream. `after` runs
 * once the run ends, before the stream closes (a request releasing what it held).
 */
export function ndjson<E>(run: (emit: (event: E) => void) => Promise<void>, onError: (message: string) => E, after?: () => Promise<unknown>): Response {
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
        await after?.().catch(() => undefined);
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
    // The visitor gets the plain sentence; the log keeps the cause (without credentials) for whoever runs the site.
    console.warn(`[graph] unreachable: ${redact(error)}`);
    return "Can't reach the graph database right now. If the free FalkorDB instance went to sleep, it wakes on the next try; retry in a few seconds.";
  }
  if (/rate|quota|429/i.test(message)) return "Every free model is rate limited at the moment. Retry in a minute, or play a recorded run.";
  return message;
}

/**
 * Whether the caller asked for the standard procedure rather than a live model (header `x-detour-no-model: 1`).
 * The end-to-end tests send it, so checking a deployment never spends the free model quota a visitor's live run needs.
 */
export function wantsNoModel(request: Request): boolean {
  return request.headers.get("x-detour-no-model") === "1";
}

/**
 * A fixed-window limiter kept in the graph database's bookkeeping graph: keeps one visitor from spending the
 * shared free model quota.
 */
export async function allow(visitorId: string, bucket: string, perHour: number): Promise<boolean> {
  const n = await bump(`rl:${bucket}:${visitorId}:${Math.floor(Date.now() / 3_600_000)}`, 3_700_000);
  return n <= perHour;
}

/**
 * A daily budget shared by every visitor (UTC days): past it, runs use the scripted procedure instead of
 * starting live and running out of the free model quota halfway.
 */
export async function allowToday(bucket: string, perDay: number): Promise<boolean> {
  const n = await bump(`day:${bucket}:${new Date().toISOString().slice(0, 10)}`, 26 * 3_600_000);
  return n <= perDay;
}
