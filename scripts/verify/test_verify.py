"""Acceptance and unit tests for the NetworkX verifier.

Run: uv run --with networkx --with pytest pytest scripts/verify/test_verify.py
 or: uv run --with networkx python scripts/verify/test_verify.py

The acceptance test runs the CLI on the real data into a temporary directory and checks the
invariants every scenario must satisfy, the headline numbers of the L closure (fastest-path
reroute and the recommended shuttle), and a sample shuttle plan. The unit tests build tiny
networks by hand for the platform-layer reroute, cut-off stations and headroom.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "verify" / "verify.py"
EXPECTED = {"l-canarsie", "lex-express", "cranberry"}
TOL = 1e-6

sys.path.insert(0, str(SCRIPT.parent))
import verify  # noqa: E402


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


# ---------------------------------------------------------------- unit: tiny networks


def tiny_network() -> tuple[dict, list]:
    """A line X: A -> B -> C -> D, a parallel line Y: A -> E -> D, and a walk B <-> E."""
    stations = [{"id": s, "lat": 40.7 + i * 0.01, "lon": -73.9} for i, s in enumerate("ABCDEF")]
    seg = lambda eid, route, a, b, cap, load: {  # noqa: E731
        "eid": eid, "route": route, "from": a, "to": b, "tph": 10, "minutes": 2.0, "capacity": cap, "load": load,
    }
    segments = [
        seg(1, "X", "A", "B", 1000, 300), seg(2, "X", "B", "C", 1000, 300), seg(3, "X", "C", "D", 1000, 300),
        seg(4, "Y", "A", "E", 350, 100), seg(5, "Y", "E", "D", 500, 100),
        seg(6, "Z", "F", "C", 100, 50),  # F only reaches C, which the closure strands as an origin
    ]
    walks = [
        {"wid": 0, "from": "B", "to": "E", "meters": 300, "minutes": 4.0, "capacity": 3000},
        {"wid": 1, "from": "E", "to": "B", "meters": 300, "minutes": 4.0, "capacity": 3000},
    ]
    routes = [{"id": r} for r in "XYZ"]
    network = {"stations": stations, "segments": segments, "walks": walks, "routes": routes}
    pairs = [
        ["A", "D", 300.0, 6.0, [1, 2, 3], []],
        ["F", "D", 50.0, 4.0, [6, 3], []],
        ["A", "E", 100.0, 2.0, [4], []],
    ]
    return network, pairs


def test_reroute_on_the_platform_layer():
    network, pairs = tiny_network()
    model = verify.Model(network, pairs, {"id": "t", "title": "t", "routes": ["X"], "stations": ["B", "C", "D"]})
    assert sorted(model.closed) == [2, 3]
    re = model.reroute()
    # A -> D boards Y at A (6 + 2 + 2 min) rather than X to B and a walk to E (20 min); F -> D has no path.
    assert re["stranded"] == 50 and re["strandedPairs"] == 1
    assert re["rerouted"] == 300
    assert [(o["eid"], o["load"], o["pct"]) for o in re["overloaded"]] == [(4, 400, 114)]
    # Y A -> E carried 100 at 8 a.m.; 300 more is 400 on 350 seats. E -> D at 400 of 500 is not over.
    assert re["overflow"] == 50
    assert re["overflow"] == sum(o["load"] - max(o["capacity"], o["baseline"]) for o in re["overloaded"])


def test_cut_off_and_headroom():
    network, pairs = tiny_network()
    model = verify.Model(network, pairs, {"id": "t", "title": "t", "routes": ["X"], "stations": ["B", "C", "D"]})
    cut_off = model.cut_off("forward")
    assert {"station": "F", "side": "origin", "riders": 50.0} in cut_off
    hr = model.headroom("forward")
    assert hr["connected"] == 300.0
    # A's 300 riders reach D only over Y E -> D (spare 400), whether they ride Y from A or X to B and walk.
    assert hr["multiplier"] is not None and abs(hr["multiplier"] - 400 / 300) < 1e-6
    assert [e["id"] for e in hr["saturating"]] == [5]


def test_js_rounding_matches_math_round():
    assert verify.js_round(2.5) == 3 and verify.js_round(-2.5) == -2 and verify.js_round(1265.7) == 1266
    assert verify.js_round1(10.25) == 10.3


# ---------------------------------------------------------------- acceptance: real data


def test_cli_on_real_data():
    with tempfile.TemporaryDirectory() as tmp:
        proc = run(["data/nyc", "data/scenarios.json", tmp])
        assert proc.returncode == 0, f"CLI exited {proc.returncode}\n{proc.stderr}"

        files = {p.stem: p for p in Path(tmp).glob("*.json")}
        assert set(files) == EXPECTED, f"expected {sorted(EXPECTED)}, got {sorted(files)}"

        for sid, path in files.items():
            out = json.loads(path.read_text(encoding="utf-8"))
            assert out["closedCount"] == len(out["closedEids"]) > 0, sid
            assert out["closedEids"] == sorted(out["closedEids"]), sid
            for direction, g in out["flow"].items():
                where = f"{sid}/{direction}"
                assert g["absorbedExact"] <= g["requiredExact"] + TOL, where
                assert abs(g["cut"]["capacity"] - g["absorbedExact"]) <= TOL, where
                assert abs(g["cut"]["networkxCapacity"] - g["absorbedExact"]) <= TOL, where
                assert abs(g["unmetExact"] - (g["requiredExact"] - g["absorbedExact"])) <= TOL, where
                hr = g["headroom"]
                if hr and hr["multiplier"] is not None:
                    assert hr["saturating"], f"{where}: a finite headroom names the segment that saturates"
            depth = [d["riders"] for d in out["depthCounts"]]
            assert depth == sorted(depth), f"{sid}: depth counts must be cumulative"
            re = out["reroute"]
            assert re["rerouted"] + re["stranded"] in range(round(sum(d["riders"] for d in out["displaced"].values())) - 1, round(sum(d["riders"] for d in out["displaced"].values())) + 2), sid

        lc = json.loads(files["l-canarsie"].read_text(encoding="utf-8"))
        peak = lc["peakDirection"]
        assert lc["flow"][peak]["requiredExact"] > 5000, (
            f"l-canarsie peak required {lc['flow'][peak]['requiredExact']} <= 5000"
        )
        # The README's fastest-path numbers: 4,689 with no path, the G at 190 to 244%.
        re = lc["reroute"]
        assert re["stranded"] == 4689, re["stranded"]
        assert re["overflow"] == 24078, re["overflow"]
        assert sorted(o["pct"] for o in re["overloaded"]) == [190, 198, 201, 244]
        assert {o["route"] for o in re["overloaded"]} == {"G"}
        # 1 Av and 3 Av, served only by the L and with no walking link, are the cut-off stations.
        assert {c["station"] for c in lc["flow"]["forward"]["cutOff"]} == {"119", "118"}

        plan = json.loads((Path(tmp) / "plans" / "l-canarsie-1av-astor.json").read_text(encoding="utf-8"))
        assert plan["reroute"]["before"]["stranded"] == 4689
        assert plan["reroute"]["after"]["stranded"] == 623
        assert round(plan["directions"]["forward"]["unmetBefore"]) == 1266
        assert round(plan["directions"]["forward"]["unmetAfter"]) == 315

        # 1 Av (119) is served only by the closed L, so a shuttle from it must raise absorbed.
        sample = {"scenario": "l-canarsie", "buses": [{"from": "119", "to": "602", "busesPerHour": 30}]}
        proc = run(["data/nyc", "data/scenarios.json", tmp, "--plan", json.dumps(sample)])
        assert proc.returncode == 0, f"plan run exited {proc.returncode}\n{proc.stderr}"
        result = json.loads(proc.stdout[proc.stdout.index("{"):])
        gains = [d["gain"] for d in result["directions"].values()]
        assert all(g >= -TOL for g in gains), f"a shuttle can never reduce absorbed: {gains}"
        assert max(gains) > 0, f"sample plan should absorb more riders: {gains}"


def main() -> int:
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"{name}: ok")
    print("acceptance: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
