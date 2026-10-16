import type { Network } from "./types";

/**
 * The ordered stations a closure covers, from `fromId` to `toId`, taken from the scheduled stop
 * pattern of one of the closed routes. Returns null when no pattern of those routes serves both.
 */
export function stretchBetween(network: Network, routes: string[], fromId: string, toId: string): string[] | null {
  if (fromId === toId) return null;
  let best: string[] | null = null;
  for (const routeId of routes) {
    const route = network.routes.find((r) => r.id === routeId);
    if (!route) continue;
    for (const pattern of route.patterns) {
      const a = pattern.indexOf(fromId);
      const b = pattern.indexOf(toId);
      if (a === -1 || b === -1) continue;
      const slice = a < b ? pattern.slice(a, b + 1) : pattern.slice(b, a + 1).reverse();
      if (!best || slice.length < best.length) best = slice;
    }
  }
  return best;
}
