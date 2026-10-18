import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Network } from "../network/types";
import { bootstrap, buildQuestions, grade, hash32, normalize, rng, score, splitOf } from "./agency-eval";
import type { AgencySnapshot } from "./agency-feeds";
import { ORG_DECISIONS, ORG_PEOPLE } from "./seed-org";

const read = <T,>(...path: string[]) => JSON.parse(readFileSync(join(process.cwd(), ...path), "utf8")) as T;

describe("grading", () => {
  it("scores exact matches after normalizing case, quotes, spaces and trailing punctuation", () => {
    expect(normalize("  In   Service. ")).toBe("in service");
    expect(normalize("Take the “A” train’s platform")).toBe('take the "a" train\'s platform');
    expect(grade(["NYCT"], ["nyct"])).toEqual({ em: 1, f1: 1, refused: null, falseRefusal: 0 });
    expect(grade(["2026-10-31 06:00"], ["2026-10-31 07:00"]).em).toBe(0);
  });
  it("scores sets by F1 and exact match by equality", () => {
    const g = grade(["A", "C", "E"], ["A", "C"]);
    expect(g.em).toBe(0);
    expect(g.f1).toBeCloseTo(0.8);
    expect(grade([], []).em).toBe(1);
    expect(grade(["A"], []).f1).toBe(0);
  });
  it("rewards refusing an unanswerable question and penalizes refusing an answerable one", () => {
    expect(grade(null, null)).toEqual({ em: 1, f1: 1, refused: 1, falseRefusal: null });
    expect(grade(null, ["in service"])).toEqual({ em: 0, f1: 0, refused: 0, falseRefusal: null });
    expect(grade(["in service"], null)).toEqual({ em: 0, f1: 0, refused: null, falseRefusal: 1 });
  });
  it("bootstraps a seeded interval around the mean", () => {
    const xs = Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? 0 : 1));
    const a = bootstrap(xs, 7);
    expect(a.mean).toBeCloseTo(0.75);
    expect(a.lo).toBeLessThan(0.75);
    expect(a.hi).toBeGreaterThan(0.75);
    expect(bootstrap(xs, 7)).toEqual(a);
    const s = score([grade(null, null), grade(["x"], null), grade(["x"], ["x"])]);
    expect(s.refusals).toEqual({ mean: 1, n: 1 });
    expect(s.falseRefusals).toEqual({ mean: 0.5, n: 2 });
  });
});

describe("seeded randomness and the split", () => {
  it("repeats for a seed", () => {
    const a = rng(1);
    const b = rng(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(hash32("abc")).toBe(hash32("abc"));
  });
  it("depends only on the key", () => {
    expect(splitOf("119")).toBe(splitOf("119"));
    const keys = Array.from({ length: 500 }, (_, i) => String(i));
    const held = keys.filter((k) => splitOf(k) === "heldout").length / keys.length;
    expect(held).toBeGreaterThan(0.5);
    expect(held).toBeLessThan(0.7);
  });
});

describe("buildQuestions on the committed snapshot", () => {
  const snap = read<AgencySnapshot>("data", "agency", "snapshot.json");
  const network = read<Network>("data", "nyc", "network.json");
  const net = { stations: network.stations.map((s) => ({ id: s.id, name: s.name, routes: s.routes })), routes: network.routes.map((r) => r.id) };
  const names = new Map(ORG_PEOPLE.map((p) => [p.id, p.name]));
  const decisions = ORG_DECISIONS.map((d) => ({ id: d.id, basedOn: d.basedOn, by: names.get(d.decidedBy)! }));
  const qs = buildQuestions(snap, net, decisions);

  it("asks at least 300 questions of every type, about a third without an answer", () => {
    expect(qs.length).toBeGreaterThanOrEqual(300);
    for (const t of ["status", "return_time", "alternative", "maintainer", "alert_lines", "alert_stations", "line_outages", "outages_since", "project_stage", "milestone_date", "complaints", "chain_count", "chain_last", "decision_basis", "decision_by"]) {
      expect(qs.some((q) => q.type === t)).toBe(true);
    }
    const unanswerable = qs.filter((q) => q.gold === null).length / qs.length;
    expect(unanswerable).toBeGreaterThan(0.2);
    expect(unanswerable).toBeLessThan(0.4);
    expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
  });
  it("is the same every time", () => {
    expect(buildQuestions(snap, net, decisions)).toEqual(qs);
  });
  it("holds out whole keys: no station, alert or project is in both splits", () => {
    const splits = new Map<string, Set<string>>();
    for (const q of qs) splits.set(q.key, (splits.get(q.key) ?? new Set()).add(q.split));
    expect([...splits.values()].every((s) => s.size === 1)).toBe(true);
    expect(qs.filter((q) => q.split === "heldout").length).toBeGreaterThan(qs.length * 0.4);
  });
  it("takes its answers from the raw records", () => {
    const latest = snap.outageCaptures[snap.outageCaptures.length - 1].outages;
    const out = latest.find((o) => o.isupcomingoutage !== "Y")!;
    const status = qs.find((q) => q.type === "status" && q.question.includes(` ${out.equipment} `))!;
    expect(status.gold).toEqual(["out of service"]);
    const asset = snap.assets.find((a) => qs.some((q) => q.type === "maintainer" && q.question.includes(` ${a.equipment_code}?`)))!;
    expect(qs.find((q) => q.type === "maintainer" && q.question.includes(` ${asset.equipment_code}?`))!.gold).toEqual([asset.maintained_by]);
    const dec = qs.find((q) => q.type === "decision_by" && q.question.includes("DEC-0616-SIZE"))!;
    expect(dec.gold).toEqual(["Renee Alvarez"]);
    expect(qs.find((q) => q.type === "status" && q.question.includes("EL901"))?.gold ?? null).toBeNull();
  });
});
