"""Acceptance test for the NetworkX verifier.

Run: uv run --with networkx python scripts/verify/test_verify.py

Runs the CLI on the real data into a temporary directory and checks the
invariants every scenario must satisfy, then evaluates a sample shuttle plan.
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


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def main() -> int:
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
            depth = [d["riders"] for d in out["depthCounts"]]
            assert depth == sorted(depth), f"{sid}: depth counts must be cumulative"

        lc = json.loads(files["l-canarsie"].read_text(encoding="utf-8"))
        peak = lc["peakDirection"]
        assert lc["flow"][peak]["requiredExact"] > 5000, (
            f"l-canarsie peak required {lc['flow'][peak]['requiredExact']} <= 5000"
        )

        # 1 Av (119) is served only by the closed L, so a shuttle from it must raise absorbed.
        plan = {"scenario": "l-canarsie", "buses": [{"from": "119", "to": "602", "busesPerHour": 30}]}
        proc = run(["data/nyc", "data/scenarios.json", tmp, "--plan", json.dumps(plan)])
        assert proc.returncode == 0, f"plan run exited {proc.returncode}\n{proc.stderr}"
        result = json.loads(proc.stdout[proc.stdout.index("{"):])
        gains = [d["gain"] for d in result["directions"].values()]
        assert all(g >= -TOL for g in gains), f"a shuttle can never reduce absorbed: {gains}"
        assert max(gains) > 0, f"sample plan should absorb more riders: {gains}"

    print("acceptance: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
