// Builds public/map/hero-l-canarsie.json: the landing-page flow overlay for the L closure.
// Interim source: the same fastest-path reroute docs/model.md specifies, computed from data/nyc
// (max-flow numbers come from data/nyc/verify, the NetworkX check). Replaced by real FalkorDB
// tool output (ci-out/l-canarsie.json) once CI runs: node scripts/fixtures/build-hero.mjs ci-out/l-canarsie.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const net = JSON.parse(readFileSync("data/nyc/network.json", "utf8"));
const dem = JSON.parse(readFileSync("data/nyc/demand.json", "utf8"));
const verify = JSON.parse(readFileSync("data/nyc/verify/l-canarsie.json", "utf8"));
const fromCi = process.argv[2] && existsSync(process.argv[2]) ? JSON.parse(readFileSync(process.argv[2], "utf8")) : null;

let hero;
if (fromCi) {
  const cap = fromCi.capacity;
  hero = {
    source: "FalkorDB tool output (scripts/ci/run-scenarios.ts)",
    closedEids: cap.highlight.closedEids,
    flows: cap.highlight.flows,
    overloaded: cap.data.reroute.overloaded.map((o) => ({ kind: o.kind, id: o.id, pct: o.pct })),
    stranded: cap.data.reroute.stranded,
    displaced: cap.data.displacedRiders,
    peak: cap.data.directions.find((d) => d.direction === cap.data.peak),
  };
} else {
  const sc = { routes: ["L"], stations: ["120", "119", "118", "602", "601", "618"] };
  const st = new Set(sc.stations);
  const closed = new Set(net.segments.filter((e) => sc.routes.includes(e.route) && st.has(e.from) && st.has(e.to)).map((e) => e.eid));
  const disp = dem.pairs.filter((p) => p[4].some((e) => closed.has(e)));
  const freed = new Map();
  for (const p of disp) for (const e of p[4]) if (!closed.has(e)) freed.set(e, (freed.get(e) ?? 0) + p[2]);
  const adj = new Map();
  const add = (a, b, w, k) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push([b, w, k]); };
  for (const e of net.segments) if (!closed.has(e.eid)) add(e.from, e.to, e.minutes, ["RUNS", e.eid]);
  for (const w of net.walks) add(w.from, w.to, w.minutes, ["WALK", w.wid]);
  const byO = new Map();
  for (const p of disp) { if (!byO.has(p[0])) byO.set(p[0], []); byO.get(p[0]).push(p); }
  const added = new Map();
  let stranded = 0;
  for (const [o, ps] of byO) {
    const dist = new Map([[o, 0]]), prev = new Map(), done = new Set(), pq = [[0, o]];
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, u] = pq.shift();
      if (done.has(u)) continue;
      done.add(u);
      for (const [v, w, k] of adj.get(u) ?? []) { const nd = d + w; if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, [u, k]); pq.push([nd, v]); } }
    }
    for (const p of ps) {
      if (!dist.has(p[1])) { stranded += p[2]; continue; }
      for (let x = p[1]; x !== o; x = prev.get(x)[0]) {
        const [kind, id] = prev.get(x)[1];
        const key = `${kind}:${id}`;
        added.set(key, (added.get(key) ?? 0) + p[2]);
      }
    }
  }
  const segs = new Map(net.segments.map((s) => [s.eid, s]));
  const flows = [];
  const overloaded = [];
  for (const [key, flow] of added) {
    const [kind, idStr] = key.split(":");
    const id = Number(idStr);
    if (kind === "RUNS") {
      const s = segs.get(id);
      flows.push({ kind, id, from: s.from, to: s.to, flow: Math.round(flow) });
      const load = s.load - (freed.get(id) ?? 0) + flow;
      if (load > s.capacity) overloaded.push({ kind, id, pct: Math.round((load / s.capacity) * 100) });
    } else {
      const w = net.walks[id];
      flows.push({ kind, id, from: w.from, to: w.to, flow: Math.round(flow) });
    }
  }
  flows.sort((a, b) => b.flow - a.flow);
  const f = verify.flow.forward;
  hero = {
    source: "interim: docs/model.md reroute on data/nyc; max flow from the NetworkX verifier",
    closedEids: [...closed],
    flows: flows.slice(0, 160),
    overloaded,
    stranded: Math.round(stranded),
    displaced: Math.round(disp.reduce((s, p) => s + p[2], 0)),
    peak: { direction: "forward", required: Math.round(f.required), absorbed: Math.round(f.absorbed), unmet: Math.round(f.unmet) },
  };
}
writeFileSync("public/map/hero-l-canarsie.json", JSON.stringify(hero));
console.log(hero.source, "flows", hero.flows.length, "overloaded", hero.overloaded.length, "displaced", hero.displaced, "stranded", hero.stranded);
