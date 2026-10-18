import bench from "../../data/proof/bench.json";
import proofCranberry from "../../data/proof/cranberry.json";
import proofL from "../../data/proof/l-canarsie.json";
import proofLex from "../../data/proof/lex-express.json";
import summary from "../../data/proof/summary.json";
import meta from "../../data/nyc/meta.json";
import verifyCranberry from "../../data/nyc/verify/cranberry.json";
import verifyL from "../../data/nyc/verify/l-canarsie.json";
import verifyLex from "../../data/nyc/verify/lex-express.json";
import verifyPlan from "../../data/nyc/verify/plans/l-canarsie-1av-astor.json";
import network from "../../data/nyc/network.json";
import closuresEval from "../../data/eval/closures.json";
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

/** The held-out evaluation and the preset closures' certificates (scripts/eval/closures-eval.ts). */
type Check = { checked: boolean; solver: "falkordb" | "dinic"; value: number; cutCapacity: number; falkordb: { value: number; checked: boolean; problems: string[] } };
type PresetDirection = {
  direction: string;
  required: number;
  absorbed: number;
  check: Check;
  openSegmentsInCut: number;
  cutOff: { id: string; side: "origin" | "destination"; riders: number }[];
  headroom: { multiplier: number | null; connected: number; solves: number; recomputed: number; checked: boolean; saturating: { route?: string; kind: string; from: string; to: string; spare: number }[] } | null;
};
type Preset = {
  id: string;
  title: string;
  displaced: number;
  noPath: number;
  overflow: number;
  overloaded: { route: string; from: string; to: string; pct: number }[];
  plan: { shuttles: { from: string; to: string; busesPerHour: number }[]; vehicles: number; before: { stranded: number; unmet: number; overflow: number }; after: { stranded: number; unmet: number; overflow: number } } | null;
  directions: PresetDirection[];
};
type Rate = { agree: number; total: number; rate: number };
type Closures = {
  generatedAt: string;
  engine: string;
  seed: number;
  count: number;
  lines: string[];
  segments: { min: number; max: number };
  agreement: Record<string, Rate>;
  overflowDetail: { sameAsNetworkx: number; withinTieRange: number; tieSensitive: number };
  worst: Record<string, { id: string; title: string; diff: number; agree: boolean }[]>;
  certificates: { maxFlowRuns: number; falkordbPassed: number; recomputedByDinic: number; allChecked: boolean; headroomSolves: number; headroomRecomputed: number };
  maxFlowRepro: {
    engine: string;
    chokepoint: { falkordb: number; exact: number; feasible: boolean; maximal: boolean; checked: boolean; problems: string[] };
    random: { networks: number; wrong: number; caughtByCertificate: number; missedByCertificate: number };
  };
  policy: {
    needingBuses: number;
    optimal: number;
    meanGap: number;
    maxGap: number;
    worst: { id: string; title: string; gap: number; chosen: { perBus: number; vehicles: number; gain: number } | null; oracle: { perBus: number; vehicles: number; gain: number } | null }[];
  };
  presets: Preset[];
};
const CLOSURES = closuresEval as unknown as Closures;
const NAME = new Map<string, string>();

/** Station names for the proof page, read once from the network file's station list. */
function stationName(id: string): string {
  if (!NAME.size) for (const s of network.stations) NAME.set(s.id, s.name);
  return NAME.get(id) ?? id;
}

interface CertificateRow {
  scenario: string;
  title: string;
  direction: string;
  value: number;
  cutCapacity: number;
  solver: "falkordb" | "dinic";
  checked: boolean;
  falkordbValue: number;
  headroom: number | null;
  firstToFill: string | null;
  /** Open segments with spare capacity in the min cut. */
  openSegments: number;
  cutOff: string;
}

/** Every preset max flow with its certificate, headroom and cut-off stations. */
export function certificates(): { rows: CertificateRow[]; repro: Closures["maxFlowRepro"]; totals: Closures["certificates"]; heldOut: number } {
  const rows = CLOSURES.presets.flatMap((p) =>
    p.directions.map((d) => {
      const first = d.headroom?.saturating[0];
      return {
        scenario: p.id,
        title: p.title,
        direction: d.direction,
        value: d.check.value,
        cutCapacity: d.check.cutCapacity,
        solver: d.check.solver,
        checked: d.check.checked,
        falkordbValue: d.check.falkordb.value,
        headroom: d.headroom?.multiplier ?? null,
        firstToFill: first ? `${first.route ?? first.kind} ${stationName(first.from)} → ${stationName(first.to)}` : null,
        cutOff: d.cutOff.map((s) => `${stationName(s.id)} (${s.side})`).join(", "),
        openSegments: d.openSegmentsInCut,
      };
    }),
  );
  return { rows, repro: CLOSURES.maxFlowRepro, totals: CLOSURES.certificates, heldOut: CLOSURES.count };
}

const METRIC_LABEL: Record<string, string> = {
  closedSegments: "Closed segments",
  displaced: "Displaced riders",
  maxFlow: "Max flow, each direction",
  certified: "Max flow certified",
  cutOff: "Cut-off stations",
  headroom: "Headroom multiplier",
  noPath: "Riders with no path",
  overflow: "Fastest-path overflow",
};

/** Agreement on closures nobody tuned for, and the controller's plan choice against the oracle. */
export function heldOut() {
  const order = ["closedSegments", "displaced", "maxFlow", "certified", "cutOff", "headroom", "noPath", "overflow"];
  return {
    count: CLOSURES.count,
    lines: CLOSURES.lines.length,
    seed: CLOSURES.seed,
    segments: CLOSURES.segments,
    engine: CLOSURES.engine,
    generatedAt: CLOSURES.generatedAt,
    metrics: order.filter((m) => CLOSURES.agreement[m]).map((m) => ({ key: m, label: METRIC_LABEL[m] ?? m, ...CLOSURES.agreement[m] })),
    overflow: CLOSURES.overflowDetail,
    worstOverflow: CLOSURES.worst.overflow ?? [],
    policy: CLOSURES.policy,
  };
}

interface CoverageRow {
  what: string;
  falkordb: string;
  networkx: string | null;
  match: boolean | null;
}

/** What the NetworkX verifier recomputes for the L closure, and what it cannot. */
export function verifierCoverage(): CoverageRow[] {
  const p = CLOSURES.presets.find((x) => x.id === "l-canarsie")!;
  const v = verifyL as unknown as {
    displaced: Record<string, { riders: number }>;
    flow: Record<string, { cutOff: { station: string; side: string }[]; headroom: { multiplier: number | null } | null }>;
    reroute: { stranded: number; overflow: number; overloaded: { pct: number }[] };
  };
  const plan = verifyPlan as unknown as { reroute: { after: { stranded: number } }; directions: { forward: { unmetAfter: number } } };
  const fmt = (x: number) => Math.round(x).toLocaleString("en-US");
  const pcts = (rows: { pct: number }[]) => rows.map((o) => o.pct).sort((a, b) => a - b).join(", ");
  const fwd = p.directions.find((d) => d.direction === "forward")!;
  const nxDisplaced = Object.values(v.displaced).reduce((s, d) => s + d.riders, 0);
  const cutOff = (list: { id?: string; station?: string; side: string }[]) => list.map((s) => `${stationName(s.id ?? s.station ?? "")} (${s.side})`).join(", ");
  const rows: CoverageRow[] = [
    { what: "Displaced riders", falkordb: fmt(p.displaced), networkx: fmt(nxDisplaced), match: Math.abs(p.displaced - nxDisplaced) <= 1.5 },
    { what: "Overloaded segments on fastest paths (%)", falkordb: pcts(p.overloaded), networkx: pcts(v.reroute.overloaded), match: pcts(p.overloaded) === pcts(v.reroute.overloaded) },
    { what: "Riders with no open path", falkordb: fmt(p.noPath), networkx: fmt(v.reroute.stranded), match: Math.abs(p.noPath - v.reroute.stranded) <= 1.5 },
    { what: "Fastest-path overflow", falkordb: fmt(p.overflow), networkx: fmt(v.reroute.overflow), match: Math.abs(p.overflow - v.reroute.overflow) <= 1.5 },
    { what: "Cut-off stations toward Manhattan", falkordb: cutOff(fwd.cutOff), networkx: cutOff(v.flow.forward.cutOff), match: cutOff(fwd.cutOff) === cutOff(v.flow.forward.cutOff) },
    {
      what: "Headroom toward Manhattan",
      falkordb: fwd.headroom?.multiplier ? `${fwd.headroom.multiplier.toFixed(2)}×` : "beyond 20×",
      networkx: v.flow.forward.headroom?.multiplier ? `${v.flow.forward.headroom.multiplier.toFixed(2)}×` : "beyond 20×",
      match: Math.abs((fwd.headroom?.multiplier ?? 0) - (v.flow.forward.headroom?.multiplier ?? 0)) <= 2e-3,
    },
  ];
  if (p.plan) {
    rows.push(
      { what: "Shuttle 1 Av ↔ Astor Pl: riders with no path after", falkordb: fmt(p.plan.after.stranded), networkx: fmt(plan.reroute.after.stranded), match: Math.abs(p.plan.after.stranded - plan.reroute.after.stranded) <= 1.5 },
      { what: "Shuttle 1 Av ↔ Astor Pl: max-flow shortfall after", falkordb: fmt(p.plan.after.unmet), networkx: fmt(plan.directions.forward.unmetAfter), match: Math.abs(p.plan.after.unmet - plan.directions.forward.unmetAfter) <= 1.5 },
    );
  }
  rows.push(
    { what: "Memory: past shuttle carried 79%, so 27% more buses", falkordb: "read from graph memory", networkx: null, match: null },
    { what: "Concurrency: reads and writes a second", falkordb: `${fmt(bench.reads.perSecond)} reads/s`, networkx: null, match: null },
    { what: "Step-free routes for remembered riders", falkordb: "k fastest paths, filtered", networkx: null, match: null },
  );
  return rows;
}
