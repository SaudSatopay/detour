import { describe, expect, it } from "vitest";
import { busLeg, directionOf, freedLoad, minCut, netBalance, type FlowEdge } from "./flow";

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
