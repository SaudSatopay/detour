/**
 * Graph names. One FalkorDB instance holds them all:
 *   detour:demand          shared, read-only origin-destination flows with their baseline paths
 *   detour:template        the subway network plus seeded memory; never mutated by visitors
 *   detour:sbx:<visitor>   one isolated sandbox per visitor, copied from the template (GRAPH.COPY)
 *   detour:fork:<sbx>:<n>  short-lived what-if forks of a sandbox (closure applied, plans tested)
 *   detour:meta            bookkeeping: the sandbox registry, the seed lock, rate counters
 */
export const DEMAND_GRAPH = "detour:demand";
export const TEMPLATE_GRAPH = "detour:template";
export const SANDBOX_PREFIX = "detour:sbx:";
export const FORK_PREFIX = "detour:fork:";
export const META_GRAPH = "detour:meta";

const VISITOR_ID = /^[a-z0-9]{8,32}$/;

/** The anonymous visitor cookie: one sandbox graph per visitor, kept for a week. */
export const VISITOR_COOKIE = "detour_vid";
export const VISITOR_MAX_AGE = 7 * 24 * 3600;

export function newVisitorId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("") + Date.now().toString(36).slice(-4);
}

export function isVisitorId(id: string): boolean {
  return VISITOR_ID.test(id);
}

export function sandboxGraph(visitorId: string): string {
  if (!isVisitorId(visitorId)) throw new Error("Invalid visitor id");
  return `${SANDBOX_PREFIX}${visitorId}`;
}

export function forkGraph(visitorId: string, label: string): string {
  if (!isVisitorId(visitorId)) throw new Error("Invalid visitor id");
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error("Invalid fork label");
  return `${FORK_PREFIX}${visitorId}:${label}`;
}
