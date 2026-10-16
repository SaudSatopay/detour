import { connect } from "@/lib/graph/db";
import { cleanupSandboxes, ensureBase } from "@/lib/graph/tenancy";
import { friendlyError } from "@/lib/server/http";

export const maxDuration = 120;

/**
 * Daily keep-alive (the free FalkorDB tier stops after a day idle), self-healing seed (it has no
 * persistence), and removal of expired visitor sandboxes. Vercel Cron calls it with CRON_SECRET.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const started = performance.now();
    await ensureBase();
    const { removed } = await cleanupSandboxes();
    const db = await connect();
    const graphs = await db.list();
    return Response.json({ ok: true, graphs: graphs.length, removedSandboxes: removed.length, ms: Math.round(performance.now() - started) });
  } catch (error) {
    return Response.json({ ok: false, error: friendlyError(error) }, { status: 503 });
  }
}
