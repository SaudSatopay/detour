"""Independent NetworkX implementation of Detour's disruption model (docs/model.md).

Usage:
    uv run --with networkx python scripts/verify/verify.py data/nyc data/scenarios.json data/nyc/verify
    uv run --with networkx python scripts/verify/verify.py data/nyc data/scenarios.json data/nyc/verify \
        --plan '{"scenario":"l-canarsie","buses":[{"from":"120","to":"101","busesPerHour":40}]}'

Without --plan it writes <out>/<scenario id>.json for every scenario. With --plan it
evaluates one shuttle plan and prints the before/after absorbed riders as JSON
(and writes it to --plan-out when given).

Max flow uses networkx.algorithms.flow.edmonds_karp (shortest augmenting paths) for both
networkx.maximum_flow and networkx.minimum_cut. Capacities are floats.

The network is a multigraph (several routes run between the same two stations), and
networkx flow functions need a simple DiGraph. Every network edge u->v is therefore
split as u -> (kind, id) -> v: the first arc carries the edge's spare capacity, the
second has no capacity attribute (unbounded). Reachability between stations in the
residual graph is identical to the multigraph's, and the flow on each original edge
is the flow on its first arc.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

import networkx as nx
from networkx.algorithms.flow import edmonds_karp

FLOW_FUNC = edmonds_karp
FLOW_FUNC_NAME = "networkx.algorithms.flow.edmonds_karp"
SRC = "__SRC__"
SNK = "__SNK__"
EPS = 1e-9  # residual and net-balance tolerance on float arithmetic
TOL = 1e-6  # assertion tolerance: cut capacity vs max flow
MAX_DEPTH = 6
TOP_EDGES = 15
TOP_PAIRS = 10
BUS_RIDERS = 70  # riders per bus, docs/model.md "Shuttle plans"
DIRECTIONS = ("forward", "backward")


def r1(x: float) -> float:
    return round(x, 1) + 0.0  # + 0.0 turns -0.0 into 0.0


def r6(x: float) -> float:
    return round(x, 6) + 0.0


# ---------------------------------------------------------------- inputs


def load_inputs(data_dir: Path, scenarios_path: Path) -> tuple[dict, list, list]:
    network = json.loads((data_dir / "network.json").read_text(encoding="utf-8"))
    pairs = json.loads((data_dir / "demand.json").read_text(encoding="utf-8"))["pairs"]
    scenarios = json.loads(scenarios_path.read_text(encoding="utf-8"))
    return network, pairs, scenarios


class Model:
    """One closure applied to the baseline network, per docs/model.md."""

    def __init__(self, network: dict, pairs: list, scenario: dict) -> None:
        self.network = network
        self.scenario = scenario
        self.stations = {s["id"]: s for s in network["stations"]}
        self.segments = {s["eid"]: s for s in network["segments"]}
        self.walks = {w["wid"]: w for w in network["walks"]}

        stretch: list[str] = scenario["stations"]
        routes = set(scenario["routes"])
        missing = [s for s in stretch if s not in self.stations]
        if missing:
            raise SystemExit(f"{scenario['id']}: unknown stations {missing}")
        unknown_routes = routes - {r["id"] for r in network["routes"]}
        if unknown_routes:
            raise SystemExit(f"{scenario['id']}: unknown routes {sorted(unknown_routes)}")

        # Closure: every RUNS edge of a closed route with both ends in the stretch.
        pos = {sid: i for i, sid in enumerate(stretch)}
        self.stretch = stretch
        self.closed: dict[int, str] = {}
        for seg in network["segments"]:
            if seg["route"] in routes and seg["from"] in pos and seg["to"] in pos:
                self.closed[seg["eid"]] = "forward" if pos[seg["to"]] > pos[seg["from"]] else "backward"
        if not self.closed:
            raise SystemExit(f"{scenario['id']}: the closure closes no segment")

        # Displaced pairs: baseline path uses a closed segment; direction of the first one.
        self.displaced: dict[str, list[list]] = {d: [] for d in DIRECTIONS}
        for pair in pairs:
            for eid in pair[4]:
                if eid in self.closed:
                    self.displaced[self.closed[eid]].append(pair)
                    break

        # Spare capacity: displaced riders (both directions) vacate their whole path.
        displaced_load: dict[int, float] = defaultdict(float)
        for d in DIRECTIONS:
            for pair in self.displaced[d]:
                for eid in set(pair[4]):
                    displaced_load[eid] += pair[2]
        self.spare: dict[int, float] = {}
        for eid, seg in self.segments.items():
            if eid in self.closed:
                self.spare[eid] = 0.0
            else:
                self.spare[eid] = max(0.0, seg["capacity"] - (seg["load"] - displaced_load[eid]))

    # ------------------------------------------------------------ depth

    def runs_hops_before_stretch(self) -> dict[str, int]:
        """Directed RUNS hops (any route) from each station to the nearest stretch station."""
        reverse: dict[str, set[str]] = defaultdict(set)
        for seg in self.segments.values():
            reverse[seg["to"]].add(seg["from"])
        dist = {sid: 0 for sid in self.stretch}
        queue = deque(self.stretch)
        while queue:
            node = queue.popleft()
            if dist[node] >= MAX_DEPTH:
                continue
            for prev in reverse[node]:
                if prev not in dist:
                    dist[prev] = dist[node] + 1
                    queue.append(prev)
        return dist

    def depth_counts(self) -> tuple[list[dict], dict[str, list[dict]]]:
        dist = self.runs_hops_before_stretch()
        by_dir: dict[str, list[dict]] = {}
        totals = []
        for k in range(MAX_DEPTH + 1):
            row_pairs = 0
            row_riders = 0.0
            for d in DIRECTIONS:
                inside = [p for p in self.displaced[d] if dist.get(p[0], MAX_DEPTH + 1) <= k]
                riders = sum(p[2] for p in inside)
                by_dir.setdefault(d, []).append({"k": k, "pairs": len(inside), "riders": r1(riders)})
                row_pairs += len(inside)
                row_riders += riders
            totals.append({"k": k, "pairs": row_pairs, "riders": r1(row_riders)})
        return totals, by_dir

    # ------------------------------------------------------------ flow

    def network_edges(self, buses: list[dict] | None = None) -> list[dict]:
        """Every capacitated network edge: RUNS (spare), WALK (3000) and optional BUS."""
        edges = []
        for eid, seg in self.segments.items():
            edges.append({
                "kind": "RUNS", "id": eid, "route": seg["route"], "from": seg["from"], "to": seg["to"],
                "capacity": self.spare[eid], "closed": eid in self.closed,
            })
        for wid, walk in self.walks.items():
            edges.append({
                "kind": "WALK", "id": wid, "from": walk["from"], "to": walk["to"],
                "capacity": float(walk["capacity"]),
            })
        for i, bus in enumerate(buses or []):
            cap = float(bus["busesPerHour"]) * BUS_RIDERS
            for j, (a, b) in enumerate(((bus["from"], bus["to"]), (bus["to"], bus["from"]))):
                edges.append({"kind": "BUS", "id": 2 * i + j, "from": a, "to": b, "capacity": cap})
        return edges

    def solve(self, direction: str, buses: list[dict] | None = None) -> dict:
        group = self.displaced[direction]
        net: dict[str, float] = defaultdict(float)
        for o, dst, riders, *_ in group:
            net[o] += riders
            net[dst] -= riders
        sources = {s: v for s, v in net.items() if v > EPS}
        sinks = {s: -v for s, v in net.items() if v < -EPS}
        required = sum(sources.values())

        edges = self.network_edges(buses)
        for s, v in sorted(sources.items()):
            edges.append({"kind": "FEED", "id": f"SRC->{s}", "from": SRC, "to": s, "capacity": v, "station": s, "side": "source"})
        for s, v in sorted(sinks.items()):
            edges.append({"kind": "FEED", "id": f"{s}->SNK", "from": s, "to": SNK, "capacity": v, "station": s, "side": "sink"})

        # Split network edges through a mid node so parallel edges stay distinct.
        G = nx.DiGraph()
        G.add_nodes_from([SRC, SNK, *self.stations])
        for e in edges:
            if e["kind"] == "FEED":
                G.add_edge(e["from"], e["to"], capacity=e["capacity"])
            else:
                mid = (e["kind"], e["id"])
                G.add_edge(e["from"], mid, capacity=e["capacity"])
                G.add_edge(mid, e["to"])  # unbounded

        max_flow, flow_dict = nx.maximum_flow(G, SRC, SNK, flow_func=FLOW_FUNC)
        for e in edges:
            head = e["to"] if e["kind"] == "FEED" else (e["kind"], e["id"])
            e["flow"] = flow_dict[e["from"]][head]
            assert -EPS <= e["flow"] <= e["capacity"] + TOL, f"capacity violated on {e['kind']} {e['id']}"

        # Residual reachability from SRC, built here per docs/model.md:
        # forward along an edge while flow < capacity, backward while flow > 0.
        adj: dict[str, list[str]] = defaultdict(list)
        for e in edges:
            if e["capacity"] - e["flow"] > EPS:
                adj[e["from"]].append(e["to"])
            if e["flow"] > EPS:
                adj[e["to"]].append(e["from"])
        reach = {SRC}
        queue = deque([SRC])
        while queue:
            node = queue.popleft()
            for nxt in adj[node]:
                if nxt not in reach:
                    reach.add(nxt)
                    queue.append(nxt)
        assert SNK not in reach, "sink reachable in residual graph: flow is not maximum"

        cut = [e for e in edges if e["from"] in reach and e["to"] not in reach]
        back = [e for e in edges if e["from"] not in reach and e["to"] in reach]
        for e in cut:
            assert abs(e["capacity"] - e["flow"]) <= TOL, f"cut edge not saturated: {e['kind']} {e['id']}"
        for e in back:
            assert e["flow"] <= TOL, f"backward cut edge carries flow: {e['kind']} {e['id']}"
        cut_capacity = sum(e["capacity"] for e in cut)
        assert abs(cut_capacity - max_flow) <= TOL, f"cut {cut_capacity} != max flow {max_flow}"

        # Cross-check against networkx's own minimum cut partition.
        nx_value, (nx_s, nx_t) = nx.minimum_cut(G, SRC, SNK, flow_func=FLOW_FUNC)
        nx_capacity = 0.0
        for u, v, data in G.edges(data=True):
            if u in nx_s and v in nx_t:
                assert "capacity" in data, "networkx cut crosses an unbounded arc"
                nx_capacity += data["capacity"]
        assert abs(nx_capacity - max_flow) <= TOL, f"networkx partition {nx_capacity} != max flow {max_flow}"
        assert abs(nx_value - max_flow) <= TOL, f"networkx cut value {nx_value} != max flow {max_flow}"
        nx_station_side = {n for n in nx_s if isinstance(n, str)}
        my_station_side = {n for n in reach if isinstance(n, str)}
        # networkx puts on the sink side only the nodes that can still reach SNK in the
        # residual graph (the maximal source side); docs/model.md takes the nodes reachable
        # from SRC (the minimal source side). Both are minimum cuts, so the capacities must
        # agree and the minimal side must sit inside networkx's side.
        assert my_station_side <= nx_station_side, "residual source side is not inside networkx's source side"

        net_cut = [e for e in cut if e["kind"] != "FEED"]
        feed_cut = [e for e in cut if e["kind"] == "FEED"]
        net_cut_spare = sum(e["capacity"] for e in net_cut)
        feed_cut_cap = sum(e["capacity"] for e in feed_cut)
        assert abs(net_cut_spare - (max_flow - feed_cut_cap)) <= TOL

        def edge_out(e: dict) -> dict:
            out: dict[str, Any] = {}
            if e["kind"] == "RUNS":
                out = {"eid": e["id"], "route": e["route"]}
            elif e["kind"] == "WALK":
                out = {"wid": e["id"]}
            else:
                out = {"bus": e["id"]}
            out.update({"from": e["from"], "to": e["to"], "spare": r1(e["capacity"]), "flow": r1(e["flow"])})
            if e.get("closed"):
                out["closed"] = True
            return out

        by_kind = lambda kind: sorted((e for e in net_cut if e["kind"] == kind), key=lambda e: e["id"])  # noqa: E731
        top = sorted((e for e in edges if e["kind"] != "FEED" and e["flow"] > EPS), key=lambda e: (-e["flow"], e["kind"], str(e["id"])))

        absorbed = max_flow
        return {
            "pairs": len(group),
            "riders": r1(sum(p[2] for p in group)),
            "required": r1(required),
            "absorbed": r1(absorbed),
            "unmet": r1(required - absorbed),
            "requiredExact": r6(required),
            "absorbedExact": r6(absorbed),
            "unmetExact": r6(required - absorbed),
            "sources": len(sources),
            "sinks": len(sinks),
            "cut": {
                "capacity": r6(cut_capacity),
                "networkxCapacity": r6(nx_capacity),
                "maxFlow": r6(max_flow),
                "networkSpare": r6(net_cut_spare),
                "feedCapacity": r6(feed_cut_cap),
                "check": "cut capacity == max flow and networkx partition capacity == max flow (|diff| <= 1e-6); residual source side is a subset of networkx's (maximal) source side",
                "sourceSideStations": len(my_station_side) - 1,
                "networkxSourceSideStations": len(nx_station_side) - 1,
                "sourceSideInsideNetworkx": True,
                "bottlenecks": {
                    "runs": [edge_out(e) for e in by_kind("RUNS")],
                    "walks": [edge_out(e) for e in by_kind("WALK")],
                    "bus": [edge_out(e) for e in by_kind("BUS")],
                },
                # Every RUNS / WALK edge in the cut, as docs/model.md defines it. Closed and
                # fully loaded edges (spare 0) belong to the cut when they leave the source side.
                "bottleneckEids": [e["id"] for e in by_kind("RUNS")],
                "bottleneckWids": [e["id"] for e in by_kind("WALK")],
                "bottleneckEidsWithSpare": [e["id"] for e in by_kind("RUNS") if e["capacity"] > EPS],
                "feeds": [
                    {"station": e["station"], "side": e["side"], "capacity": r1(e["capacity"])}
                    for e in sorted(feed_cut, key=lambda e: (e["side"], e["station"]))
                ],
            },
            "_top": [edge_out(e) for e in top[:TOP_EDGES]],
        }

    # ------------------------------------------------------------ routing

    def routing_graph(self) -> nx.DiGraph:
        """Open RUNS + WALK, weight minutes; parallel edges collapse to the fastest."""
        H = nx.DiGraph()
        candidates = [
            (s["from"], s["to"], s["minutes"], {"eid": s["eid"], "route": s["route"]})
            for s in self.segments.values() if s["eid"] not in self.closed
        ] + [(w["from"], w["to"], w["minutes"], {"wid": w["wid"]}) for w in self.walks.values()]
        for u, v, minutes, ref in candidates:
            if not H.has_edge(u, v) or minutes < H[u][v]["minutes"]:
                H.add_edge(u, v, minutes=minutes, ref=ref)
        return H

    def reference_paths(self, direction: str) -> list[dict]:
        H = self.routing_graph()
        largest = sorted(self.displaced[direction], key=lambda p: (-p[2], p[0], p[1]))[:TOP_PAIRS]
        out = []
        for o, d, riders, journey, *_ in largest:
            row: dict[str, Any] = {
                "origin": o, "destination": d, "riders": r1(riders), "baselineJourneyMinutes": journey,
            }
            try:
                minutes, path = nx.single_source_dijkstra(H, o, d, weight="minutes")
                row["minutes"] = r1(minutes)
                row["stations"] = path
                row["edges"] = [H[a][b]["ref"] for a, b in zip(path, path[1:])]
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                row["minutes"] = None
                row["stations"] = None
                row["edges"] = None
            out.append(row)
        return out


# ---------------------------------------------------------------- commands


def haversine_km(a: dict, b: dict) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def evaluate_scenario(model: Model) -> dict:
    sc = model.scenario
    flow = {d: model.solve(d) for d in DIRECTIONS}
    peak = max(DIRECTIONS, key=lambda d: (flow[d]["requiredExact"], d == "forward"))
    top = flow[peak]["_top"]
    for d in DIRECTIONS:
        del flow[d]["_top"]
    depth, depth_by_dir = model.depth_counts()
    return {
        "scenario": {"id": sc["id"], "title": sc["title"], "routes": sc["routes"], "stations": sc["stations"]},
        "verifier": {
            "implementation": "scripts/verify/verify.py",
            "spec": "docs/model.md",
            "networkx": nx.__version__,
            "maxFlow": FLOW_FUNC_NAME,
            "minCut": f"own residual reachability, cross-checked with networkx.minimum_cut ({FLOW_FUNC_NAME})",
            "tolerance": TOL,
        },
        "closedEids": sorted(model.closed),
        "closedCount": len(model.closed),
        "closedByDirection": {d: sorted(e for e, dd in model.closed.items() if dd == d) for d in DIRECTIONS},
        "displaced": {
            d: {"pairs": len(model.displaced[d]), "riders": r1(sum(p[2] for p in model.displaced[d]))}
            for d in DIRECTIONS
        },
        "depthCounts": depth,
        "depthCountsByDirection": depth_by_dir,
        "peakDirection": peak,
        "flow": flow,
        "topEdgesByFlow": {"direction": peak, "edges": top},
        "referencePaths": {
            "direction": peak,
            "weight": "minutes over open RUNS + WALK (no waits, no transfer penalty)",
            "pairs": model.reference_paths(peak),
        },
    }


def evaluate_plan(model: Model, plan: dict) -> dict:
    buses = plan.get("buses") or []
    if not buses:
        raise SystemExit("plan has no buses")
    for bus in buses:
        for end in (bus["from"], bus["to"]):
            if end not in model.stations:
                raise SystemExit(f"plan: unknown station {end}")
        if not bus["busesPerHour"] > 0:
            raise SystemExit("plan: busesPerHour must be positive")
    directions = {}
    for d in DIRECTIONS:
        before = model.solve(d)
        after = model.solve(d, buses)
        assert after["absorbedExact"] >= before["absorbedExact"] - TOL, "adding capacity reduced max flow"
        directions[d] = {
            "required": before["required"],
            "absorbedBefore": before["absorbed"],
            "absorbedAfter": after["absorbed"],
            "gain": r1(after["absorbedExact"] - before["absorbedExact"]),
            "unmetBefore": before["unmet"],
            "unmetAfter": after["unmet"],
            "cutCheckAfter": {"capacity": after["cut"]["capacity"], "maxFlow": after["cut"]["maxFlow"]},
            "bottleneckEidsAfter": after["cut"]["bottleneckEids"],
            "busEdgesInCutAfter": after["cut"]["bottlenecks"]["bus"],
        }
    return {
        "scenario": model.scenario["id"],
        "maxFlow": FLOW_FUNC_NAME,
        "buses": [
            {
                "from": b["from"], "to": b["to"], "busesPerHour": b["busesPerHour"],
                "capacityEachWay": float(b["busesPerHour"]) * BUS_RIDERS,
                "minutes": r1(4 + haversine_km(model.stations[b["from"]], model.stations[b["to"]]) * 3),
            }
            for b in buses
        ],
        "directions": directions,
    }


def summary_lines(out: dict) -> list[str]:
    sid = out["scenario"]["id"]
    lines = [f"== {sid}: {out['closedCount']} closed segments {out['closedEids']}"]
    for d in DIRECTIONS:
        g = out["flow"][d]
        cut = g["cut"]
        mark = " (peak)" if d == out["peakDirection"] else ""
        lines.append(
            f"  {d}{mark}: displaced {g['pairs']} pairs / {g['riders']} riders/h; "
            f"required {g['required']}, absorbed {g['absorbed']}, unmet {g['unmet']}; "
            f"sources {g['sources']}, sinks {g['sinks']}"
        )
        lines.append(
            f"    cut {cut['capacity']} == max flow {cut['maxFlow']} (networkx partition {cut['networkxCapacity']}, "
            f"source side {cut['sourceSideStations']} stations, inside networkx's {cut['networkxSourceSideStations']}); network spare {cut['networkSpare']} + feeds {cut['feedCapacity']}"
        )
        lines.append(f"    bottleneck eids {cut['bottleneckEids']} wids {cut['bottleneckWids']}; cut feeds {len(cut['feeds'])}")
    depth = ", ".join(f"k{row['k']}={row['riders']}" for row in out["depthCounts"])
    lines.append(f"  depth riders/h: {depth}")
    ref = out["referencePaths"]["pairs"]
    reachable = sum(1 for p in ref if p["minutes"] is not None)
    lines.append(f"  reference paths ({out['peakDirection']}): {reachable}/{len(ref)} reachable")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Independent NetworkX check of Detour's closure, max-flow and min-cut model.")
    parser.add_argument("data_dir", type=Path, help="directory with network.json and demand.json")
    parser.add_argument("scenarios", type=Path, help="scenarios.json")
    parser.add_argument("out_dir", type=Path, help="where <scenario id>.json files are written")
    parser.add_argument("--plan", help="shuttle plan as inline JSON or a path to a JSON file")
    parser.add_argument("--plan-out", type=Path, help="also write the plan result to this file")
    args = parser.parse_args(argv)

    network, pairs, scenarios = load_inputs(args.data_dir, args.scenarios)

    if args.plan:
        plan_path = Path(args.plan)
        plan = json.loads(plan_path.read_text(encoding="utf-8") if plan_path.is_file() else args.plan)
        match = [s for s in scenarios if s["id"] == plan.get("scenario")]
        if not match:
            raise SystemExit(f"plan: unknown scenario {plan.get('scenario')!r}")
        result = evaluate_plan(Model(network, pairs, match[0]), plan)
        for d, row in result["directions"].items():
            print(
                f"plan {result['scenario']} {d}: required {row['required']}, absorbed "
                f"{row['absorbedBefore']} -> {row['absorbedAfter']} (gain {row['gain']}), unmet {row['unmetBefore']} -> {row['unmetAfter']}"
            )
        text = json.dumps(result, indent=2)
        if args.plan_out:
            args.plan_out.parent.mkdir(parents=True, exist_ok=True)
            args.plan_out.write_text(text + "\n", encoding="utf-8")
        print(text)
        return 0

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for scenario in scenarios:
        out = evaluate_scenario(Model(network, pairs, scenario))
        path = args.out_dir / f"{scenario['id']}.json"
        path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
        print("\n".join(summary_lines(out)))
        print(f"  wrote {path.as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
