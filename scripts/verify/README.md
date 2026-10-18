# NetworkX verifier

An independent Python implementation of `docs/model.md`, so every FalkorDB number can be cross-checked. It shares no code with `src/lib/graph/`.

- Per scenario it recomputes closed segments, displaced pairs and riders per direction, the depth counts (k = 0..6 directed RUNS hops), spare capacity, and per-direction required, absorbed and unmet.
- Max flow is `networkx.maximum_flow` with `edmonds_karp` on float capacities. The min cut is the residual reachability from `SRC` built by hand per the spec; it asserts cut capacity == max flow (1e-6) and that it equals the capacity of `networkx.minimum_cut`'s partition.
- **Cut-off stations** (`cutOff`): origins that reach no destination and destinations no origin reaches, over edges with spare capacity. On the L these are 1 Av and 3 Av.
- **Headroom** (`headroom`): the displaced-demand multiplier at which an open edge first saturates, by exact parametric max flow (Newton steps on the cut lines, `networkx.minimum_cut` each step), with the edges of the binding cut.
- **Fastest-path reroute** (`reroute`): the platform layer with FalkorDB's costs (BOARD 3 min + min(30, 30 / tph) of the platform's busiest departing segment, RIDE segment minutes, ALIGHT 0, WALK minutes, BUS 4 min + 3 min per km, closed RIDE deleted), every displaced pair on its fastest path (all-or-nothing, Dijkstra), then overloaded segments, overflow and riders with no path with the FalkorDB tool's rounding. `overflowRange` repeats it over 8 random tie-breaks (1e-7 min per edge), because equally fast paths make the assignment non-unique.
- It also writes the top 15 edges by flow and reference shortest paths (minutes over open RUNS + WALK, no waits) for the 10 largest displaced pairs in the peak direction.
- The README's shuttle plans in `plans.json` are evaluated on every full run into `<out>/plans/<id>.json`: max flow before and after, and the reroute before and after.

Run: `pnpm verify` (writes `data/nyc/verify/<id>.json` and `data/nyc/verify/plans/`).
Shuttle plan: add `--plan '{"scenario":"l-canarsie","buses":[{"from":"119","to":"602","busesPerHour":30}]}'` (inline JSON or a file path; `--plan-out <file>` saves it).
Many closures: `--summary <file>` writes one compact JSON for a scenarios file (used by `scripts/eval/closures-eval.ts`).
Test: `pnpm test:verify` (pytest: tiny hand-built networks for the reroute, cut-off stations and headroom, then the CLI on the real data, which pins the README's L numbers: 4,689 with no path, the G at 190 to 244%, 623 and 315 after the 1 Av to Astor Pl shuttle).
`bottleneckEids` lists every RUNS edge in the cut, including closed or full edges with spare 0. `bottleneckEidsWithSpare` keeps only edges with spare > 0.
