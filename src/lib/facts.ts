import meta from "../../data/nyc/meta.json";
import verifyL from "../../data/nyc/verify/l-canarsie.json";
import planL from "../../data/nyc/verify/plans/l-canarsie-sample.json";
import heroL from "../../public/map/hero-l-canarsie.json";
import network from "../../data/nyc/network.json";

/**
 * Headline numbers for the landing and proof pages, read from the built data and the NetworkX
 * verifier output, never typed in by hand.
 */
const round = (n: number) => Math.round(n);

const depth = (k: number) => round(verifyL.depthCounts.find((d) => d.k === k)?.riders ?? 0);
const fwd = verifyL.flow.forward;
const names = new Map(network.stations.map((s) => [s.id, s.name]));
const segs = new Map(network.segments.map((s) => [s.eid, s]));
const worst = heroL.overloaded.reduce((a, b) => (b.pct > a.pct ? b : a), heroL.overloaded[0]);
const worstSeg = segs.get(worst.id);
const plan = planL.directions.forward;

export const FACTS = {
  ridersAt8: meta.ridership.totalRiders,
  pairsKept: meta.ridership.pairsKept,
  pairsTotal: meta.ridership.pairsTotal,
  ridersKeptPct: Math.round((meta.ridership.ridersKept / meta.ridership.totalRiders) * 1000) / 10,
  stations: meta.counts.stations,
  segments: meta.counts.segments,
  routes: meta.counts.routes,
  l: {
    displaced: round(verifyL.displaced.forward.riders + verifyL.displaced.backward.riders),
    depth0: depth(0),
    depth1: depth(1),
    depth4: depth(4),
    depth6: depth(6),
    required: round(fwd.required),
    absorbed: round(fwd.absorbed),
    unmet: round(fwd.unmet),
    shuttleBuses: planL.buses[0].busesPerHour,
    unmetAfterShuttle: round(plan.unmetAfter),
    worstPct: worst.pct,
    worstRoute: worstSeg?.route ?? "",
    worstFrom: names.get(worstSeg?.from ?? "") ?? "",
    worstTo: names.get(worstSeg?.to ?? "") ?? "",
    stranded: heroL.stranded,
  },
};

export const fmt = (n: number) => n.toLocaleString("en-US");
