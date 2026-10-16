# NetworkX verifier

An independent Python implementation of `docs/model.md`, so every FalkorDB number can be cross-checked. It shares no code with `src/lib/graph/`.

- Per scenario it recomputes closed segments, displaced pairs and riders per direction, the depth counts (k = 0..6 directed RUNS hops), spare capacity, and per-direction required, absorbed and unmet.
- Max flow is `networkx.maximum_flow` with `edmonds_karp` on float capacities. The min cut is the residual reachability from `SRC` built by hand per the spec; it asserts cut capacity == max flow (1e-6) and that it equals the capacity of `networkx.minimum_cut`'s partition.
- It also writes the top 15 edges by flow and reference shortest paths (minutes over open RUNS + WALK, no waits) for the 10 largest displaced pairs in the peak direction.

Run: `uv run --with networkx python scripts/verify/verify.py data/nyc data/scenarios.json data/nyc/verify` (writes `data/nyc/verify/<id>.json`).
Shuttle plan: add `--plan '{"scenario":"l-canarsie","buses":[{"from":"119","to":"602","busesPerHour":30}]}'` (inline JSON or a file path; `--plan-out <file>` saves it).
Test: `uv run --with networkx python scripts/verify/test_verify.py` runs the CLI into a temp dir and checks the invariants.
`bottleneckEids` lists every RUNS edge in the cut, including closed or full edges with spare 0. `bottleneckEidsWithSpare` keeps only edges with spare > 0.
