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
import random
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
TRANSFER_PENALTY_MINUTES = 3  # docs/model.md "Network", platform layer
MAX_WAIT_MINUTES = 30
HEADROOM_MAX_SCALE = 20  # same default as the measure_headroom tool
TIE_BREAKS = 8  # random tie-breaks between equally fast paths for the overflow range


def r1(x: float) -> float:
    return round(x, 1) + 0.0  # + 0.0 turns -0.0 into 0.0


def r6(x: float) -> float:
    return round(x, 6) + 0.0


def js_round(x: float) -> int:
    """JavaScript's Math.round (halves round up), which the FalkorDB tools use."""
    return int(math.floor(x + 0.5))


def js_round1(x: float) -> float:
    return math.floor(x * 10 + 0.5) / 10


def bus_minutes(a: dict, b: dict) -> float:
    """Shuttle running time as the FalkorDB tool computes it: 4 min + 3 min per km, earth radius 6,371,000 m."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    meters = 2 * 6_371_000 * math.asin(math.sqrt(h))
    return js_round1(4 + meters / 1000 * 3)


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

    # ------------------------------------------------------------ cut-off stations and headroom

    def demand_feeds(self, direction: str) -> tuple[dict[str, float], dict[str, float]]:
        net: dict[str, float] = defaultdict(float)
        for o, dst, riders, *_ in self.displaced[direction]:
            net[o] += riders
            net[dst] -= riders
        return {s: v for s, v in net.items() if v > EPS}, {s: -v for s, v in net.items() if v < -EPS}

    def cut_off(self, direction: str, buses: list[dict] | None = None) -> list[dict]:
        """Origins that reach no destination and destinations no origin reaches, over edges with spare > 0."""
        sources, sinks = self.demand_feeds(direction)
        G = nx.DiGraph()
        G.add_nodes_from(self.stations)
        for e in self.network_edges(buses):
            if e["capacity"] > EPS:
                G.add_edge(e["from"], e["to"])
        from_sources: set[str] = set()
        for s in sources:
            from_sources |= nx.descendants(G, s) | {s}
        to_sinks: set[str] = set()
        for t in sinks:
            to_sinks |= nx.ancestors(G, t) | {t}
        out = [{"station": s, "side": "origin", "riders": r1(v)} for s, v in sources.items() if s not in to_sinks]
        out += [{"station": t, "side": "destination", "riders": r1(v)} for t, v in sinks.items() if t not in from_sources]
        return sorted(out, key=lambda x: (-x["riders"], x["station"]))

    def headroom(self, direction: str, max_scale: float = HEADROOM_MAX_SCALE) -> dict:
        """Displaced-demand multiplier at which an open edge first saturates (parametric max flow).

        f(lam) = max flow with every feed capacity times lam is the lower envelope of the cuts'
        lines lam*F + N. Below the first breakpoint only feed cuts bind and f(lam) = lam*F0, where
        F0 is the connected demand. From lam, the min cut's line meets lam*F0 at N / (F0 - F);
        iterating that from max_scale reaches the first breakpoint exactly (Newton on breakpoints).
        """
        sources, sinks = self.demand_feeds(direction)
        edges = self.network_edges()

        def graph(lam: float, unlimited: bool = False) -> nx.DiGraph:
            G = nx.DiGraph()
            G.add_nodes_from([SRC, SNK])
            for s, v in sources.items():
                G.add_edge(SRC, s, capacity=v * lam, feed=True)
            for t, v in sinks.items():
                G.add_edge(t, SNK, capacity=v * lam, feed=True)
            for e in edges:
                mid = (e["kind"], e["id"])
                if unlimited:
                    if e["capacity"] > EPS:
                        G.add_edge(e["from"], mid)
                        G.add_edge(mid, e["to"])
                else:
                    G.add_edge(e["from"], mid, capacity=e["capacity"])
                    G.add_edge(mid, e["to"])
            return G

        connected = nx.maximum_flow_value(graph(1.0, unlimited=True), SRC, SNK, flow_func=FLOW_FUNC) if sources else 0.0
        if connected <= EPS:
            return {"connected": 0.0, "multiplier": None, "saturating": [], "solves": 0}
        lam = max_scale
        binding: list = []
        solves = 0
        for i in range(40):
            G = graph(lam)
            value, (side_s, _side_t) = nx.minimum_cut(G, SRC, SNK, flow_func=FLOW_FUNC)
            solves += 1
            if value >= lam * connected * (1 - 1e-9) - 1e-6:
                return {
                    "connected": r6(connected),
                    "multiplier": None if i == 0 else r6(lam),
                    "saturating": binding,
                    "solves": solves,
                }
            feed_cap = 0.0
            net_cap = 0.0
            crossing = []
            for u, v, data in G.edges(data=True):
                if u in side_s and v not in side_s:
                    if data.get("feed"):
                        feed_cap += data["capacity"] / lam
                    else:
                        net_cap += data["capacity"]
                        if data["capacity"] > EPS:
                            crossing.append({"kind": v[0], "id": v[1], "from": u, "to": next(iter(G.successors(v))), "spare": r1(data["capacity"])})
            # networkx returns the maximal source side; the cut it names binds at the next breakpoint all the same.
            binding = sorted(crossing, key=lambda e: (e["spare"], e["kind"], str(e["id"])))
            lam = net_cap / (connected - feed_cap)
        return {"connected": r6(connected), "multiplier": r6(lam), "saturating": binding, "solves": solves}

    # ------------------------------------------------------------ fastest-path reroute

    def platform_graph(self, buses: list[dict] | None = None) -> nx.DiGraph:
        """The platform layer of docs/model.md on the closure fork, plus optional BUS legs.

        Station nodes ("S", id); a platform ("P", id, route) per station and route a segment
        touches. BOARD costs 3 min plus half the headway (capped at 30) of the platform's
        busiest departing segment, ALIGHT is free, RIDE is the segment's minutes (closed
        segments are deleted), WALK and BUS connect stations directly.
        """
        tph: dict[tuple[str, str], float] = {}
        for seg in self.segments.values():
            for key in ((seg["from"], seg["route"]), (seg["to"], seg["route"])):
                tph.setdefault(key, 0.0)
            key = (seg["from"], seg["route"])
            tph[key] = max(tph[key], seg["tph"])
        G = nx.DiGraph()
        for (station, route), t in tph.items():
            board = js_round1(TRANSFER_PENALTY_MINUTES + min(MAX_WAIT_MINUTES, 30 / max(1, t)))
            G.add_edge(("S", station), ("P", station, route), minutes=board, kind="BOARD")
            G.add_edge(("P", station, route), ("S", station), minutes=0.0, kind="ALIGHT")
        for seg in self.segments.values():
            if seg["eid"] in self.closed:
                continue
            G.add_edge(("P", seg["from"], seg["route"]), ("P", seg["to"], seg["route"]), minutes=seg["minutes"], kind="RIDE", eid=seg["eid"])

        def link(a: str, b: str, minutes: float, **ref: Any) -> None:
            u, v = ("S", a), ("S", b)
            # Station-to-station links can coincide (a shuttle between stations a walk apart): keep the faster.
            if not G.has_edge(u, v) or minutes < G[u][v]["minutes"]:
                G.add_edge(u, v, minutes=minutes, **ref)

        for walk in self.walks.values():
            link(walk["from"], walk["to"], walk["minutes"], kind="WALK", wid=walk["wid"])
        for i, bus in enumerate(buses or []):
            minutes = bus_minutes(self.stations[bus["from"]], self.stations[bus["to"]])
            link(bus["from"], bus["to"], minutes, kind="BUS", bid=i)
            link(bus["to"], bus["from"], minutes, kind="BUS", bid=i)
        return G

    def reroute(self, buses: list[dict] | None = None) -> dict:
        """All-or-nothing assignment of every displaced pair to its fastest open path.

        Mirrors the FalkorDB tool (capacity.ts, reroute): new load = load - displacedLoad +
        rerouted riders on each segment a path rides; a segment is overloaded when that exceeds
        its capacity and its 8 a.m. load; overflow = load - max(capacity, baseline), summed
        after rounding each load. Pairs with no open path are stranded. A BUS leg carries its
        capacity each way, so each direction's riders are checked against it on their own.
        """
        G = self.platform_graph(buses)
        pairs = [p for d in DIRECTIONS for p in self.displaced[d]]
        displaced_load: dict[int, float] = defaultdict(float)
        for pair in pairs:
            for eid in set(pair[4]):
                if eid not in self.closed:
                    displaced_load[eid] += pair[2]
        by_origin: dict[str, list] = defaultdict(list)
        for p in pairs:
            by_origin[p[0]].append(p)
        added: dict[int, float] = defaultdict(float)
        bus_added: dict[tuple[int, str], float] = defaultdict(float)
        rerouted = 0.0
        stranded: list = []
        for origin, group in sorted(by_origin.items()):
            source = ("S", origin)
            _dist, paths = nx.single_source_dijkstra(G, source, weight="minutes") if source in G else ({}, {})
            for o, dst, riders, *_ in group:
                path = paths.get(("S", dst))
                if path is None:
                    stranded.append((o, dst, riders))
                    continue
                rerouted += riders
                for a, b in zip(path, path[1:]):
                    data = G[a][b]
                    if data["kind"] == "RIDE":
                        added[data["eid"]] += riders
                    elif data["kind"] == "BUS":
                        # Keyed by the station the bus leaves from: each direction has its own capacity.
                        bus_added[(data["bid"], a[1])] += riders

        overloaded = []
        for eid, n in added.items():
            seg = self.segments[eid]
            load = seg["load"] - displaced_load[eid] + n
            if load > seg["capacity"] and load > seg["load"]:
                overloaded.append({
                    "kind": "RUNS", "eid": eid, "route": seg["route"], "from": seg["from"], "to": seg["to"],
                    "load": js_round(load), "baseline": js_round(seg["load"]), "capacity": seg["capacity"],
                    "pct": js_round(load / seg["capacity"] * 100),
                })
        bus_loads = []
        for i, bus in enumerate(buses or []):
            cap = float(bus["busesPerHour"]) * BUS_RIDERS
            for a, b in ((bus["from"], bus["to"]), (bus["to"], bus["from"])):
                load = bus_added[(i, a)]
                bus_loads.append({"bid": i, "from": a, "to": b, "load": js_round(load), "capacity": cap})
                if load > cap:
                    overloaded.append({
                        "kind": "BUS", "bid": i, "route": "BUS", "from": a, "to": b, "load": js_round(load),
                        "baseline": 0, "capacity": cap, "pct": js_round(load / cap * 100),
                    })
        excess = lambda o: o["load"] - max(o["capacity"], o["baseline"])  # noqa: E731
        overloaded.sort(key=lambda o: (-excess(o), o["kind"], o.get("eid", o.get("bid"))))
        no_path_ends: dict[str, float] = defaultdict(float)
        for o, dst, riders in stranded:
            for end in {o, dst}:
                no_path_ends[end] += riders
        return {
            "costModel": "BOARD 3 min + min(30, 30/tph); RIDE segment minutes; ALIGHT 0; WALK minutes; BUS 4 min + 3 min/km; closed RIDE deleted",
            "pairs": len(pairs),
            "rerouted": js_round(rerouted),
            "stranded": js_round(sum(r for *_, r in stranded)),
            "strandedPairs": len(stranded),
            "strandedByStation": [
                {"station": s, "riders": r1(v)} for s, v in sorted(no_path_ends.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
            ],
            "overflow": js_round(sum(excess(o) for o in overloaded)),
            "overloaded": overloaded,
            **({"busLoads": bus_loads} if buses else {}),
        }

    def overflow_range(self, tie_breaks: int = TIE_BREAKS) -> dict:
        """Overflow over several tie-breaks between equally fast paths.

        All-or-nothing assignment is not unique when two paths cost the same minutes, and which
        one a shortest-path routine returns is an implementation detail (FalkorDB's SPpaths and
        networkx's Dijkstra need not agree). Adding a random 1e-7 minutes to every edge picks
        a different equally fast path without changing any strictly faster one; the spread of
        the resulting overflow is the range any correct implementation can land in.
        """
        values = [self.reroute()["overflow"]]
        original = self.platform_graph
        for seed in range(1, tie_breaks + 1):
            rng = random.Random(seed)

            def perturbed(buses: list[dict] | None = None, rng: random.Random = rng) -> nx.DiGraph:
                G = original(buses)
                for _u, _v, data in G.edges(data=True):
                    data["minutes"] += rng.random() * 1e-7
                return G

            self.platform_graph = perturbed  # type: ignore[method-assign]
            try:
                values.append(self.reroute()["overflow"])
            finally:
                del self.platform_graph
        return {"min": min(values), "max": max(values), "tieBreaks": tie_breaks}

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
        flow[d]["cutOff"] = model.cut_off(d)
        flow[d]["headroom"] = model.headroom(d) if flow[d]["requiredExact"] > EPS else None
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
        "reroute": {**model.reroute(), "overflowRange": model.overflow_range()},
    }


def evaluate_compact(model: Model) -> dict:
    """The numbers the held-out evaluation compares, without depth counts or reference paths."""
    flow = {}
    for d in DIRECTIONS:
        g = model.solve(d)
        flow[d] = {
            "required": g["requiredExact"],
            "absorbed": g["absorbedExact"],
            "unmet": g["unmetExact"],
            "cutCapacity": g["cut"]["capacity"],
            "openEdgesInCut": len(g["cut"]["bottleneckEidsWithSpare"]) + len([w for w in g["cut"]["bottlenecks"]["walks"] if w["spare"] > 0]),
            "cutOff": model.cut_off(d),
            "headroom": model.headroom(d) if g["requiredExact"] > EPS else None,
        }
    re = model.reroute()
    return {
        "closedEids": sorted(model.closed),
        "displaced": r6(sum(p[2] for d in DIRECTIONS for p in model.displaced[d])),
        "flow": flow,
        "reroute": {k: re[k] for k in ("rerouted", "stranded", "strandedPairs", "overflow")}
        | {"overloaded": len(re["overloaded"]), "overflowRange": model.overflow_range()},
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
            "cutOffAfter": model.cut_off(d, buses),
        }
    re_before = model.reroute()
    re_after = model.reroute(buses)
    return {
        "scenario": model.scenario["id"],
        "label": plan.get("label"),
        "maxFlow": FLOW_FUNC_NAME,
        "reroute": {
            "before": {k: re_before[k] for k in ("rerouted", "stranded", "strandedPairs", "overflow")},
            "after": {k: re_after[k] for k in ("rerouted", "stranded", "strandedPairs", "overflow", "strandedByStation", "busLoads")},
            "overloadedAfter": re_after["overloaded"][:12],
        },
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
        cut_off = ", ".join(f"{c['station']} ({c['side']}, {c['riders']})" for c in g["cutOff"][:4]) or "none"
        hr = g["headroom"]
        hr_text = "n/a" if hr is None else ("beyond scale" if hr["multiplier"] is None else f"{hr['multiplier']:.3f}x")
        lines.append(f"    cut off: {cut_off}; headroom {hr_text}")
    depth = ", ".join(f"k{row['k']}={row['riders']}" for row in out["depthCounts"])
    lines.append(f"  depth riders/h: {depth}")
    re = out["reroute"]
    worst = ", ".join(f"{o['route']} {o['from']}>{o['to']} {o['pct']}%" for o in re["overloaded"][:4])
    lines.append(
        f"  fastest-path reroute: {re['rerouted']} rerouted, {re['stranded']} with no path ({re['strandedPairs']} pairs), "
        f"{len(re['overloaded'])} overloaded, overflow {re['overflow']}{f' ({worst})' if worst else ''}"
    )
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
    parser.add_argument(
        "--plans", type=Path, default=Path(__file__).with_name("plans.json"),
        help="headline shuttle plans to evaluate on a full run (default scripts/verify/plans.json); written to <out>/plans/<id>.json",
    )
    parser.add_argument(
        "--summary", type=Path,
        help="compact mode for many closures: write one JSON of {scenario id: closed segments, displaced, max flow, reroute} here and skip the per-scenario files",
    )
    args = parser.parse_args(argv)

    network, pairs, scenarios = load_inputs(args.data_dir, args.scenarios)

    if args.summary:
        compact = {}
        for scenario in scenarios:
            compact[scenario["id"]] = evaluate_compact(Model(network, pairs, scenario))
            row = compact[scenario["id"]]
            print(f"{scenario['id']}: {len(row['closedEids'])} closed, {row['displaced']:.0f} displaced, no path {row['reroute']['stranded']}")
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps({"verifier": FLOW_FUNC_NAME, "networkx": nx.__version__, "closures": compact}, indent=1) + "\n", encoding="utf-8", newline="\n")
        print(f"wrote {args.summary.as_posix()}")
        return 0

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
            args.plan_out.write_text(text + "\n", encoding="utf-8", newline="\n")
        print(text)
        return 0

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for scenario in scenarios:
        out = evaluate_scenario(Model(network, pairs, scenario))
        path = args.out_dir / f"{scenario['id']}.json"
        path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8", newline="\n")
        print("\n".join(summary_lines(out)))
        print(f"  wrote {path.as_posix()}")

    # The README's headline shuttle plans, so their before/after numbers are recomputed too.
    if args.plans.is_file():
        by_id = {s["id"]: s for s in scenarios}
        for plan in json.loads(args.plans.read_text(encoding="utf-8")):
            if plan["scenario"] not in by_id:
                continue
            result = evaluate_plan(Model(network, pairs, by_id[plan["scenario"]]), plan)
            path = args.out_dir / "plans" / f"{plan['id']}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
            re = result["reroute"]
            peak = max(result["directions"].values(), key=lambda row: row["required"])
            print(
                f"== plan {plan['id']}: no path {re['before']['stranded']} -> {re['after']['stranded']}; "
                f"max-flow shortfall {peak['unmetBefore']} -> {peak['unmetAfter']}; overflow {re['before']['overflow']} -> {re['after']['overflow']}"
            )
            print(f"  wrote {path.as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
