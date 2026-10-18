import { createHmac, timingSafeEqual } from "node:crypto";
import { isVisitorId, newVisitorId } from "@/lib/graph/names";

/**
 * An MCP session ties a caller to a sandbox graph of its own: the token carries a visitor id, who the caller is and
 * an expiry, signed with a key derived from the deployment's CRON_SECRET, so a caller can only ever reach the
 * sandbox it was given. The control room's agents get one for the visitor's own sandbox; an outside agent gets a
 * fresh one from open_session.
 */
export type SessionRole = "controller" | "rider-desk" | "mcp";

export interface Session {
  visitorId: string;
  role: SessionRole;
}

const DAY = 86_400_000;
const ROLES: SessionRole[] = ["controller", "rider-desk", "mcp"];

function signingKey(): string {
  return createHmac("sha256", process.env.CRON_SECRET || "detour-local-development").update("detour mcp session").digest("hex");
}

function mac(body: string): string {
  return createHmac("sha256", signingKey()).update(body).digest("base64url").slice(0, 32);
}

export function signSession(visitorId: string, role: SessionRole, ttlMs = 3 * DAY, now = Date.now()): string {
  if (!isVisitorId(visitorId)) throw new Error("Invalid visitor id");
  const body = `${visitorId}.${role}.${(now + ttlMs).toString(36)}`;
  return `${body}.${mac(body)}`;
}

/** Who a token was issued to, or null when it is malformed, forged or expired. */
export function verifySession(token: string | null | undefined, now = Date.now()): Session | null {
  const [visitorId, role, expires, signature] = token?.split(".") ?? [];
  if (!visitorId || !role || !expires || !signature || !isVisitorId(visitorId) || !ROLES.includes(role as SessionRole)) return null;
  if (parseInt(expires, 36) < now) return null;
  const expected = Buffer.from(mac(`${visitorId}.${role}.${expires}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { visitorId, role: role as SessionRole };
}

/** A visitor id for an outside MCP client, marked so its sandbox reads as an MCP session in the registry. */
export function newMcpVisitor(): string {
  return `mcp${newVisitorId()}`.slice(0, 32);
}
