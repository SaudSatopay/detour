import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Network } from "../network/types";
import { stretchBetween } from "../network/stretch";
import {
  busLeg,
  certifyMaxFlow,
  cutOffStations,
  dinicMaxFlow,
  directionOf,
  freedLoad,
  heldOutClosures,
  minCut,
  netBalance,
  parametricHeadroom,
  planGain,
  policyGap,
  seededRandom,
  type CapEdge,
  type FlowEdge,
} from "./flow";

describe("directionOf", () => {
  const stretch = new Map([
    ["A", 0],
    ["B", 1],
    ["C", 2],
  ]);
  const segments = new Map([
    [1, { from: "A", to: "B" }],
    [2, { from: "B", to: "A" }],
    [9, { from: "X", to: "A" }],
  ]);
  const closed = new Set([1, 2]);

  it("reads the direction of the first closed segment on the path", () => {
    expect(directionOf([9, 1], closed, stretch, segments)).toBe("forward");
    expect(directionOf([2, 9], closed, stretch, segments)).toBe("backward");
  });

  it("returns null when the path never crosses the closure", () => {
    expect(directionOf([9], closed, stretch, segments)).toBeNull();
  });
});

describe("freedLoad and netBalance", () => {
  const pairs = [
    { o: "X", d: "Y", riders: 10, via: [1, 5, 6] },
    { o: "X", d: "Z", riders: 4, via: [1, 5] },
    { o: "Y", d: "X", riders: 3, via: [7, 1] },
  ];

  it("frees every open segment a displaced rider used, skipping closed ones", () => {
    const freed = freedLoad(pairs, new Set([1]));
    expect(freed.get(5)).toBe(14);
    expect(freed.get(6)).toBe(10);
    expect(freed.get(7)).toBe(3);
    expect(freed.has(1)).toBe(false);
  });

  it("nets riders starting and ending at the same station", () => {
    const net = netBalance(pairs);
    expect(net.get("X")).toBe(11);
    expect(net.get("Y")).toBe(-7);
    expect(net.get("Z")).toBe(-4);
  });
});

describe("minCut", () => {
  // S -> a (5), S -> b (5), a -> T (3), b -> T (10), a -> b (1). Max flow 9: a->T 3, a->b 1, b->T 6? S->b 5 so b->T 6.
  const edges: FlowEdge[] = [
    { key: "S>a", from: "S", to: "a", capacity: 5, flow: 4 },
    { key: "S>b", from: "S", to: "b", capacity: 5, flow: 5 },
    { key: "a>T", from: "a", to: "T", capacity: 3, flow: 3 },
    { key: "a>b", from: "a", to: "b", capacity: 1, flow: 1 },
    { key: "b>T", from: "b", to: "T", capacity: 10, flow: 6 },
  ];

  it("finds the saturated edges leaving the residual-reachable set", () => {
    const { reachable, cut } = minCut(edges, "S");
    expect([...reachable].sort()).toEqual(["S", "a"]);
    expect(cut.map((e) => e.key).sort()).toEqual(["S>b", "a>T", "a>b"]);
    const cutCapacity = cut.reduce((sum, e) => sum + e.capacity, 0);
    expect(cutCapacity).toBe(9);
  });
});

describe("busLeg", () => {
  it("sizes a 2 km shuttle at 30 buses an hour", () => {
    expect(busLeg(2000, 30)).toEqual({ minutes: 10, capacity: 2100, vehicles: 13 });
  });
});

const edge = (from: string, to: string, capacity: number): CapEdge => ({ key: `${from}>${to}`, from, to, capacity });

/** Chokepoint's 11-edge node-split network, on which FalkorDB 4.22.0 and 6.0.2 return 300 instead of 453. */
const CHOKEPOINT: CapEdge[] = [
  edge("src:out", "a15:in", 3322),
  edge("a15:in", "a15:out", 158),
  edge("a15:out", "a20:in", 3322),
  edge("src:out", "a20:in", 3322),
  edge("a20:in", "a20:out", 300),
  edge("a20:out", "x1:in", 3322),
  edge("a15:out", "a3:in", 3322),
  edge("a3:in", "a3:out", 153),
  edge("a3:out", "a12:in", 3322),
  edge("a12:in", "a12:out", 261),
  edge("a12:out", "x1:in", 3322),
];

const withFlows = (edges: CapEdge[], flows: number[]): FlowEdge[] => edges.map((e, i) => ({ ...e, flow: flows[i] }));

function randomNetwork(rand: () => number, nodes: number, arcs: number, split: boolean): CapEdge[] {
  const edges: CapEdge[] = [];
  const id = (i: number) => (i === 0 ? "S" : i === nodes - 1 ? "T" : `n${i}`);
  for (let k = 0; k < arcs; k++) {
    const a = Math.floor(rand() * nodes);
    const b = Math.floor(rand() * nodes);
    if (a === b) continue;
    const cap = Math.round(rand() * 1000) / (rand() < 0.5 ? 1 : 7);
    if (split) edges.push({ key: `e${k}`, from: `${id(a)}:out`, to: `${id(b)}:in`, capacity: 5000 });
    else edges.push({ key: `e${k}`, from: id(a), to: id(b), capacity: cap });
  }
  if (split) for (let i = 0; i < nodes; i++) edges.push(edge(`${id(i)}:in`, `${id(i)}:out`, Math.round(rand() * 500)));
  return edges;
}

describe("dinicMaxFlow", () => {
  it("solves Chokepoint's 11-edge reproduction exactly (453, not 300)", () => {
    const { value, flows } = dinicMaxFlow(CHOKEPOINT, "src:out", "x1:in");
    expect(value).toBe(453);
    expect(certifyMaxFlow(withFlows(CHOKEPOINT, flows), "src:out", "x1:in", value).checked).toBe(true);
  });

  it("keeps parallel edges apart and returns flows in input order", () => {
    const edges = [
      { key: "p1", from: "S", to: "a", capacity: 2 },
      { key: "p2", from: "S", to: "a", capacity: 3 },
      { key: "q", from: "a", to: "T", capacity: 10 },
    ];
    const { value, flows } = dinicMaxFlow(edges, "S", "T");
    expect(value).toBe(5);
    expect(flows).toEqual([2, 3, 5]);
  });

  it("returns zero when the sink is unreachable or missing", () => {
    expect(dinicMaxFlow([edge("S", "a", 4)], "S", "T").value).toBe(0);
    expect(dinicMaxFlow([], "S", "S").value).toBe(0);
  });

  it("produces a certified maximum on 300 random plain and node-split networks", () => {
    const rand = seededRandom(7);
    for (let i = 0; i < 300; i++) {
      const split = i % 2 === 1;
      const edges = randomNetwork(rand, 6 + Math.floor(rand() * 14), 10 + Math.floor(rand() * 60), split);
      const [s, t] = split ? ["S:out", "T:in"] : ["S", "T"];
      const { value, flows } = dinicMaxFlow(edges, s, t);
      const cert = certifyMaxFlow(withFlows(edges, flows), s, t, value);
      expect(cert.checked, `network ${i}: ${cert.problems.join("; ")}`).toBe(true);
      expect(Math.abs(cert.cutCapacity - value)).toBeLessThanOrEqual(cert.tolerance);
    }
  });
});

describe("certifyMaxFlow", () => {
  it("rejects FalkorDB's 300 on the reproduction: feasible, but an augmenting path remains", () => {
    // What algo.maxFlow returns there: everything through a20, nothing through a3 and a12.
    const flows = CHOKEPOINT.map((e) => (["src:out>a20:in", "a20:in>a20:out", "a20:out>x1:in"].includes(e.key) ? 300 : 0));
    const cert = certifyMaxFlow(withFlows(CHOKEPOINT, flows), "src:out", "x1:in", 300);
    expect(cert.feasible).toBe(true);
    expect(cert.maximal).toBe(false);
    expect(cert.checked).toBe(false);
    expect(cert.problems.join(" ")).toMatch(/augmenting path/);
  });

  it("rejects flows that break capacity or conservation, and a value the flows do not carry", () => {
    const edges = [edge("S", "a", 5), edge("a", "T", 5)];
    expect(certifyMaxFlow(withFlows(edges, [6, 6]), "S", "T", 6).feasible).toBe(false);
    const leaky = certifyMaxFlow(withFlows(edges, [5, 3]), "S", "T", 5);
    expect(leaky.feasible).toBe(false);
    expect(leaky.problems[0]).toMatch(/not conserved at a/);
    const overclaimed = certifyMaxFlow(withFlows(edges, [5, 5]), "S", "T", 7);
    expect(overclaimed.feasible).toBe(true);
    expect(overclaimed.checked).toBe(false);
  });

  it("accepts a maximum flow and reports the cut capacity equal to it", () => {
    const edges = [edge("S", "a", 5), edge("S", "b", 5), edge("a", "T", 3), edge("a", "b", 1), edge("b", "T", 10)];
    const cert = certifyMaxFlow(withFlows(edges, [4, 5, 3, 1, 6]), "S", "T", 9);
    expect(cert).toMatchObject({ checked: true, feasible: true, maximal: true, value: 9, cutCapacity: 9 });
  });
});

describe("cutOffStations", () => {
  // x has only a full link out; y is a destination nothing reaches; a and b are joined.
  const net = [edge("a", "b", 100), edge("b", "a", 100), edge("x", "q", 0), edge("q", "b", 50)];

  it("names origins that reach no destination and destinations no origin reaches", () => {
    const sources = new Map([["a", 30], ["x", 12]]);
    const sinks = new Map([["b", 30], ["y", 12]]);
    expect(cutOffStations(net, sources, sinks)).toEqual([
      { id: "x", side: "origin", riders: 12 },
      { id: "y", side: "destination", riders: 12 },
    ]);
  });

  it("returns nothing when every origin reaches a destination", () => {
    expect(cutOffStations(net, new Map([["a", 5]]), new Map([["b", 5]]))).toEqual([]);
  });
});

describe("parametricHeadroom", () => {
  const dinic = (edges: CapEdge[]) => (_lambda: number, caps: number[]) => dinicMaxFlow(edges.map((e, i) => ({ ...e, capacity: caps[i] })), "SRC", "SNK").flows;

  it("finds the multiplier where an open segment first saturates, past a cut-off station", async () => {
    // a sends 10 riders to b over a 25-rider segment; c (5 riders) has no link at all.
    const edges = [
      { ...edge("SRC", "a", 10), feed: true },
      { ...edge("SRC", "c", 5), feed: true },
      { ...edge("a", "b", 25), feed: false },
      { ...edge("b", "SNK", 15), feed: true },
    ];
    const h = await parametricHeadroom(edges, "SRC", "SNK", dinic(edges));
    expect(h.connected).toBe(10);
    expect(h.multiplier).toBeCloseTo(2.5, 9);
    expect(h.saturating.map((e) => e.key)).toEqual(["a>b"]);
  });

  it("takes the first of several breakpoints, and reports none beyond the scale", async () => {
    const edges = [
      { ...edge("SRC", "a", 10), feed: true },
      { ...edge("SRC", "d", 10), feed: true },
      { ...edge("a", "b", 40), feed: false },
      { ...edge("d", "b", 15), feed: false },
      { ...edge("b", "SNK", 20), feed: true },
    ];
    const h = await parametricHeadroom(edges, "SRC", "SNK", dinic(edges));
    expect(h.multiplier).toBeCloseTo(1.5, 9);
    expect(h.saturating.map((e) => e.key)).toEqual(["d>b"]);
    const narrow = await parametricHeadroom(edges, "SRC", "SNK", dinic(edges), 1.2);
    expect(narrow.multiplier).toBeNull();
  });

  it("has no headroom to report when nothing can move", async () => {
    const edges = [{ ...edge("SRC", "c", 5), feed: true }, { ...edge("b", "SNK", 5), feed: true }];
    expect(await parametricHeadroom(edges, "SRC", "SNK", dinic(edges))).toMatchObject({ connected: 0, multiplier: null });
  });
});

describe("heldOutClosures", () => {
  const network = JSON.parse(readFileSync("data/nyc/network.json", "utf8")) as Network;
  const closures = heldOutClosures(network, 48, 20261019);

  it("draws 48 distinct stretches of 2 to 6 segments across most lines", () => {
    expect(closures).toHaveLength(48);
    expect(new Set(closures.map((c) => `${c.routes[0]}:${c.stations.join(",")}`)).size).toBe(48);
    for (const c of closures) {
      expect(c.stations.length - 1).toBeGreaterThanOrEqual(2);
      expect(c.stations.length - 1).toBeLessThanOrEqual(6);
    }
    expect(new Set(closures.map((c) => c.routes[0])).size).toBeGreaterThanOrEqual(20);
  });

  it("is the stretch close_line would close, and the same on every run", () => {
    for (const c of closures) expect(stretchBetween(network, c.routes, c.stations[0], c.stations[c.stations.length - 1])).toEqual(c.stations);
    expect(heldOutClosures(network, 48, 20261019)).toEqual(closures);
    expect(heldOutClosures(network, 48, 1)).not.toEqual(closures);
  });
});

describe("planGain and policyGap", () => {
  it("scores plans as the controller does and measures the gap to the oracle", () => {
    expect(planGain({ before: { stranded: 4689, unmet: 1266 }, after: { stranded: 623, unmet: 315 } })).toBe(5017);
    expect(policyGap(80, 100)).toBeCloseTo(0.2);
    expect(policyGap(120, 100)).toBe(0);
    expect(policyGap(null, 0)).toBe(0);
    expect(policyGap(null, 50)).toBe(1);
  });
});
