import type { ToolResult } from "../graph/tools/types";

/**
 * Checks a model's brief against the run's tool results. Every figure of 10 or more it states must be a quantity a
 * tool returned, to the precision the brief writes it (half a unit in its last digit), and every percentage must be
 * one a tool stated, in its text or in a field it names as a share. Ids, station codes and endpoints are not
 * quantities, so they cannot vouch for a figure. What fails is shown to the dispatcher next to the brief.
 *
 * The check says a figure exists in the results, not that the brief uses it correctly: a true number attached to the
 * wrong station still passes.
 */
export interface Grounding {
  checked: number;
  unmatched: string[];
}

const FIGURE = /(?<![\w.-])\d{1,3}(?:,\d{3})+(?:\.\d+)?%?(?![\w-])|(?<![\w.-])\d+(?:\.\d+)?%?(?![\w-])/g;
const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/i;

/** The figures worth checking: percentages, and quantities of 10 or more (0 to 9 are stops, legs and depths). */
export function figuresIn(text: string): { raw: string; value: number; pct: boolean; decimals: number }[] {
  const out: { raw: string; value: number; pct: boolean; decimals: number }[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const raw = m[0];
    const pct = raw.endsWith("%");
    const value = Number(raw.replace(/[,%]/g, ""));
    if (!Number.isFinite(value)) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
    if (MONTH.test(before)) continue; // a date, like Oct 14
    if (!pct && (value < 10 || (value >= 1900 && value <= 2100 && Number.isInteger(value)))) continue;
    const decimals = raw.includes(".") ? raw.replace(/%$/, "").split(".")[1].length : 0;
    out.push({ raw, value, pct, decimals });
  }
  return out;
}

/** Keys that hold identifiers or endpoints rather than quantities: "o", "eids", "from", "stationId", "closedEids". */
const ID_KEYS = new Set(["o", "d", "id", "ids", "eid", "eids", "bid", "wid", "from", "to", "via", "route", "routes", "station", "stations", "key", "label", "name"]);
const notAQuantity = (key: string) => ID_KEYS.has(key) || /(Id|Ids|Eids)$/.test(key);
/** Keys that hold a share as a percentage. */
const PERCENT_KEY = /pct|percent/i;

interface Pool {
  quantities: number[];
  percents: number[];
}

function collect(value: unknown, key: string, into: Pool, budget: { left: number }): void {
  if (budget.left-- <= 0) return;
  if (key === "trace" || key === "cypher" || key === "params") return;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (PERCENT_KEY.test(key)) into.percents.push(value);
    else if (!notAQuantity(key)) into.quantities.push(value);
  } else if (typeof value === "string") {
    if (notAQuantity(key)) return;
    // "[120]" in a summary is a station id, not a quantity.
    for (const f of value.matchAll(/(?<![\w.[-])(\d[\d,]*(?:\.\d+)?)(%?)(?!\])/g)) {
      const n = Number(f[1].replace(/,/g, ""));
      if (!Number.isFinite(n)) continue;
      (f[2] ? into.percents : into.quantities).push(n);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, key, into, budget);
  } else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    // A share a result implies with its own fields: absorbed of required.
    if (typeof o.absorbed === "number" && typeof o.required === "number" && o.required > 0) into.percents.push((o.absorbed / o.required) * 100);
    for (const [k, v] of Object.entries(o)) collect(v, k, into, budget);
  }
}

export function ground(text: string, results: ToolResult[]): Grounding {
  const pool: Pool = { quantities: [], percents: [] };
  for (const r of results) {
    collect(r.summary, "summary", pool, { left: 20_000 });
    collect(r.data, "data", pool, { left: 20_000 });
  }
  const figures = figuresIn(text);
  const unmatched = figures.filter((f) => {
    // Half a unit in the last digit the brief writes: "17,167" covers 17,166.7, "33.3" covers 33.25 to 33.35.
    const tolerance = 0.5 * 10 ** -f.decimals + 1e-9;
    const candidates = f.pct ? pool.percents : pool.quantities;
    return !candidates.some((v) => Math.abs(v - f.value) <= tolerance);
  });
  return { checked: figures.length, unmatched: [...new Set(unmatched.map((f) => f.raw))] };
}
