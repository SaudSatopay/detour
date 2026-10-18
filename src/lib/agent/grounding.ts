import type { ToolResult } from "../graph/tools/types";

/**
 * Checks a model's brief against the run's tool results: every figure it states must be one a tool returned (to
 * rounding), or, for a percentage, a percentage or a ratio of two numbers in the same result. What fails is shown to
 * the dispatcher next to the brief, so a number the model invented cannot pass as the graph's.
 */
export interface Grounding {
  checked: number;
  unmatched: string[];
}

const FIGURE = /(?<![\w.-])\d{1,3}(?:,\d{3})+(?:\.\d+)?%?(?![\w-])|(?<![\w.-])\d+(?:\.\d+)?%?(?![\w-])/g;
const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/i;

/** The figures worth checking: percentages, and quantities of 100 or more (small counts are stops, legs and depths). */
export function figuresIn(text: string): { raw: string; value: number; pct: boolean }[] {
  const out: { raw: string; value: number; pct: boolean }[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const raw = m[0];
    const pct = raw.endsWith("%");
    const value = Number(raw.replace(/[,%]/g, ""));
    if (!Number.isFinite(value)) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
    if (MONTH.test(before)) continue; // a date, like Oct 14
    if (!pct && (value < 100 || (value >= 1900 && value <= 2100 && Number.isInteger(value)))) continue;
    out.push({ raw, value, pct });
  }
  return out;
}

function numbersOf(value: unknown, into: number[], budget = { left: 20_000 }): number[] {
  if (budget.left-- <= 0) return into;
  if (typeof value === "number" && Number.isFinite(value)) into.push(value);
  else if (typeof value === "string") for (const f of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) into.push(Number(f[0].replace(/,/g, "")));
  else if (Array.isArray(value)) for (const v of value) numbersOf(v, into, budget);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (k !== "trace" && k !== "cypher" && k !== "params") numbersOf(v, into, budget);
  return into;
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.005);

export function ground(text: string, results: ToolResult[]): Grounding {
  const perResult = results.map((r) => numbersOf([r.summary, r.data], []));
  const all = perResult.flat();
  const figures = figuresIn(text);
  const unmatched = figures.filter((f) => {
    if (all.some((v) => near(v, f.value))) return false;
    if (!f.pct) return true;
    // A share the model worked out from one result, like absorbed / required.
    return !perResult.some((nums) => {
      const big = nums.filter((n) => n > 0).slice(0, 400);
      return big.some((a) => big.some((b) => b > 0 && Math.abs((a / b) * 100 - f.value) <= 0.6));
    });
  });
  return { checked: figures.length, unmatched: [...new Set(unmatched.map((f) => f.raw))] };
}
