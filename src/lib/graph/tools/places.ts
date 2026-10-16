import { loadNetwork } from "../../network/data";
import { result, type ToolContext, type ToolResult } from "./types";

export interface StationMatch {
  id: string;
  name: string;
  label: string;
  routes: string[];
  ada: number;
  score: number;
}

export interface PlaceMatch {
  query: string;
  kind: "station" | "route" | "unknown";
  stations?: StationMatch[];
  route?: { id: string; short: string; longName: string };
  ambiguous?: boolean;
}

const ROUTE_WORDS = /^(?:the\s+)?([a-z0-9]{1,2})(?:\s*(?:train|trains|line|service))?$/i;

/** RediSearch query text: words only, every term required, short numbers kept. */
export function fulltextQuery(name: string, fuzzy = false): string {
  const terms = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return "";
  return terms.map((t) => (fuzzy && t.length >= 4 ? `%${t}%` : t)).join(" ");
}

/**
 * Resolves station and route names against the graph before any traversal runs. Unknown names
 * come back as unknown_entity; several stations with one name come back as ambiguous candidates.
 */
export async function resolvePlaces(
  ctx: ToolContext,
  input: { names: string[]; routeHint?: string },
): Promise<ToolResult<{ matches: PlaceMatch[] }>> {
  const network = await loadNetwork();
  const matches: PlaceMatch[] = [];

  for (const raw of input.names.slice(0, 8)) {
    const name = raw.trim();
    const routeWord = name.match(ROUTE_WORDS)?.[1]?.toUpperCase();
    const route = routeWord ? network.routes.find((r) => r.id === routeWord || (r.short === routeWord && r.id.length <= 2)) : undefined;
    if (route && !/\d{2,}/.test(name)) {
      matches.push({ query: name, kind: "route", route: { id: route.id, short: route.short, longName: route.longName } });
      continue;
    }

    let stations: StationMatch[] = [];
    for (const fuzzy of [false, true]) {
      const q = fulltextQuery(name, fuzzy);
      if (!q) break;
      const res = await ctx.tracer.run<StationMatch>(
        `resolve "${name}"`,
        ctx.sandbox,
        `CALL db.idx.fulltext.queryNodes('Station', $q) YIELD node, score
         RETURN node.id AS id, node.name AS name, node.label AS label, node.routes AS routes, node.ada AS ada, score
         ORDER BY score DESC LIMIT 6`,
        { q },
        { readOnly: true },
      );
      stations = res.rows;
      if (stations.length) break;
    }

    if (input.routeHint) {
      const hint = input.routeHint.toUpperCase();
      const withHint = stations.filter((s) => s.routes.includes(hint));
      if (withHint.length) stations = withHint;
    }
    if (!stations.length) {
      matches.push({ query: name, kind: "unknown" });
      continue;
    }
    const top = stations[0];
    const sameName = stations.filter((s) => s.name.toLowerCase() === top.name.toLowerCase());
    matches.push({
      query: name,
      kind: "station",
      stations: sameName.length > 1 ? sameName : [top],
      ambiguous: sameName.length > 1,
    });
  }

  const unknown = matches.filter((m) => m.kind === "unknown");
  const ambiguous = matches.filter((m) => m.ambiguous);
  const resolved = matches
    .filter((m) => m.kind !== "unknown")
    .map((m) => (m.kind === "route" ? `${m.query} → route ${m.route!.id}` : `${m.query} → ${m.stations!.map((s) => `${s.label} [${s.id}]`).join(" or ")}`));

  const summary = [
    resolved.length ? `Resolved: ${resolved.join("; ")}.` : "",
    ambiguous.length ? `Ambiguous: ${ambiguous.map((m) => m.query).join(", ")}; pick by route.` : "",
    unknown.length ? `Not in the graph: ${unknown.map((m) => `"${m.query}"`).join(", ")}. No station or route has that name.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const outcome = unknown.length === matches.length ? "unknown_entity" : "answered";
  return result(ctx, "resolve_places", outcome, summary, { matches }, {
    stations: matches.flatMap((m) => m.stations?.map((s) => s.id) ?? []),
  });
}
