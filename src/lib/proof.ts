import bench from "../../data/proof/bench.json";
import proofCranberry from "../../data/proof/cranberry.json";
import proofL from "../../data/proof/l-canarsie.json";
import proofLex from "../../data/proof/lex-express.json";
import summary from "../../data/proof/summary.json";
import meta from "../../data/nyc/meta.json";
import verifyCranberry from "../../data/nyc/verify/cranberry.json";
import verifyL from "../../data/nyc/verify/l-canarsie.json";
import verifyLex from "../../data/nyc/verify/lex-express.json";
import scenarios from "../../data/scenarios.json";

/**
 * The proof page's numbers, assembled from committed outputs: FalkorDB tool runs (scripts/ci/run-scenarios.ts),
 * the independent NetworkX checker (scripts/verify/verify.py) and the concurrency bench (scripts/ci/bench.ts).
 */
type Step = {
  tool: string;
  outcome: string;
  summary: string;
  trace: { label: string; graph: string; cypher: string; ms: number; rows: number }[];
  byDepth?: { depth: number; riders: number }[];
};
type Proof = Record<string, Step>;
type Flow = { required: number; absorbed: number; unmet: number; requiredExact?: number; absorbedExact?: number };
type Verify = { closedCount: number; flow: Record<string, Flow>; depthCounts: { k: number; riders: number }[] };
type Summary = Record<string, { displaced: number; overflow: number; stranded: number; directions: { direction: string; required: number; absorbed: number; unmet: number }[]; queries: number }>;

const PROOF: Record<string, Proof> = { "l-canarsie": proofL as Proof, "lex-express": proofLex as Proof, cranberry: proofCranberry as Proof };
const VERIFY: Record<string, Verify> = { "l-canarsie": verifyL as Verify, "lex-express": verifyLex as Verify, cranberry: verifyCranberry as Verify };
const SUMMARY = summary as unknown as Summary;

interface AgreementRow {
  scenario: string;
  title: string;
  direction: string;
  falkor: { required: number; absorbed: number; unmet: number };
  networkx: { required: number; absorbed: number; unmet: number };
  match: boolean;
}

export function agreement(): AgreementRow[] {
  return scenarios.flatMap((sc) =>
    (SUMMARY[sc.id]?.directions ?? []).map((d) => {
      const v = VERIFY[sc.id].flow[d.direction];
      const nx = { required: v.requiredExact ?? v.required, absorbed: v.absorbedExact ?? v.absorbed, unmet: v.unmet };
      return {
        scenario: sc.id,
        title: sc.title,
        direction: d.direction,
        falkor: { required: d.required, absorbed: d.absorbed, unmet: d.unmet },
        networkx: nx,
        match: Math.abs(d.required - nx.required) <= 1.5 && Math.abs(d.absorbed - nx.absorbed) <= 1.5,
      };
    }),
  );
}

/** Displaced riders within k stops of each closure: FalkorDB's affected_riders tool against NetworkX. */
export function depthAgreement(scenario: string): { k: number; falkor: number; networkx: number; match: boolean }[] {
  const byDepth = PROOF[scenario]?.affected?.byDepth ?? [];
  return VERIFY[scenario].depthCounts.map((d) => {
    const falkor = byDepth.find((b) => b.depth === d.k)?.riders ?? NaN;
    return { k: d.k, falkor, networkx: d.riders, match: Math.abs(falkor - d.riders) <= 1.5 };
  });
}

interface ToolCost {
  key: string;
  tool: string;
  queries: number;
  ms: number;
  summary: string;
}

/** What each tool call cost on the L closure (query count and summed query time). */
export function toolCosts(): ToolCost[] {
  return Object.entries(PROOF["l-canarsie"]).map(([key, s]) => ({
    key,
    tool: s.tool,
    queries: s.trace.length,
    ms: Math.round(s.trace.reduce((sum, t) => sum + t.ms, 0)),
    summary: s.summary,
  }));
}

interface CatalogEntry {
  tool: string;
  queries: { label: string; graph: string; cypher: string }[];
}

const normalize = (text: string) =>
  text
    .replace(/detour:fork:[a-z0-9]+:[a-z0-9-]+/g, "detour:fork:<visitor>:<fork>")
    .replace(/detour:sbx:[a-z0-9]+/g, "detour:sbx:<visitor>")
    .replace(/"[^"]*"/g, '"…"');

/** Every distinct query the tools ran across the three closures, grouped by tool. */
export function cypherCatalog(): CatalogEntry[] {
  const byTool = new Map<string, Map<string, { label: string; graph: string; cypher: string }>>();
  for (const proof of Object.values(PROOF)) {
    for (const step of Object.values(proof)) {
      const seen = byTool.get(step.tool) ?? new Map();
      byTool.set(step.tool, seen);
      for (const t of step.trace) {
        const cypher = normalize(t.cypher);
        if (!seen.has(cypher)) seen.set(cypher, { label: normalize(t.label).replace(/\d+ stops? upstream/, "k stops upstream"), graph: normalize(t.graph), cypher });
      }
    }
  }
  return [...byTool].map(([tool, queries]) => ({ tool, queries: [...queries.values()] }));
}

export const BENCH = bench;
export const META = meta;
