import { loadNetwork } from "../../network/data";
import { result, type ToolContext, type ToolResult } from "./types";

interface StationMatch {
  id: string;
  name: string;
  label: string;
  routes: string[];
  ada: number;
  score: number;
}

interface PlaceMatch {
  query: string;
  kind: "station" | "route" | "unknown";
  stations?: StationMatch[];
  route?: { id: string; short: string; longName: string };
  ambiguous?: boolean;
}

const ROUTE_WORDS = /^(?:the\s+)?([a-z0-9]{1,2})(?:\s*(?:train|trains|line|service))?$/i;

/** Station names use the MTA's short forms ("Times Sq-42 St", "1 Av"); people write the words out. */
const SHORT_FORM: Record<string, string> = {
  square: "sq",
  street: "st",
  avenue: "av",
  ave: "av",
  boulevard: "blvd",
  parkway: "pkwy",
  road: "rd",
  place: "pl",
  center: "ctr",
  centre: "ctr",
  junction: "jct",
  heights: "hts",
  highway: "hwy",
  first: "1",
  second: "2",
  third: "3",
  fourth: "4",
  fifth: "5",
  sixth: "6",
  seventh: "7",
  eighth: "8",
  ninth: "9",
  tenth: "10",
};

/** Names people use for a station that share no word with its MTA name. */
const ALIASES: Record<string, string> = {
  wtc: "world trade center",
  "world trade": "world trade center",
  "yankee stadium": "161 st yankee stadium",
  "barclays center": "atlantic av barclays ctr",
  "port authority": "42 st port authority",
  "jfk airport": "howard beach jfk airport",
  jfk: "howard beach jfk airport",
  "columbus circle": "59 st columbus circle",
};

/** Lowercase words with the MTA's short forms, so "Times Square" finds "Times Sq-42 St". */
export function normalizePlace(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SHORT_FORM[w] ?? w.replace(/^(\d+)(st|nd|rd|th)$/, "$1"));
  const joined = words.join(" ");
  return ALIASES[joined] ?? joined;
}

/** RediSearch query text: words only, every term required, short numbers kept. */
function fulltextQuery(name: string, fuzzy = false): string {
  const terms = normalizePlace(name).split(" ").filter(Boolean);
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
  // A route named alongside the stations ("Bedford Av", "8 Av", "L") disambiguates them.
  const namedRoutes = input.names
    .map((n) => n.trim().match(ROUTE_WORDS)?.[1]?.toUpperCase())
    .filter((r): r is string => Boolean(r && network.routes.some((x) => x.id === r)));
  const hints = [input.routeHint?.toUpperCase(), ...namedRoutes].filter((r): r is string => Boolean(r));

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

    if (hints.length) {
      const withHint = stations.filter((s) => s.routes.some((r) => hints.includes(r)));
      if (withHint.length) stations = withHint;
    }
    if (!stations.length) {
      matches.push({ query: name, kind: "unknown" });
      continue;
    }
    const top = stations[0];
    const sameName = stations.filter((s) => s.name.toLowerCase() === top.name.toLowerCase());
    // Different stations that match about equally well ("Metropolitan": the M's Middle Village or the G and L's
    // Lorimer St) are a choice to make by route, not one to make silently.
    const exact = stations.find((s) => normalizePlace(s.name) === normalizePlace(name));
    const close = stations.filter((s) => s.score >= top.score * 0.9).slice(0, 4);
    const candidates = sameName.length > 1 ? sameName : exact ? [exact] : close;
    matches.push({
      query: name,
      kind: "station",
      stations: candidates.length > 1 ? candidates : [exact ?? top],
      ambiguous: candidates.length > 1,
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
