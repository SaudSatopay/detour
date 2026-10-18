# Claims and how to check them

Every headline number in the README, the code that measures it on FalkorDB, the independent program that recomputes it, and the test that pins it. One command re-measures all of them:

```bash
FALKORDB_URL=falkor://<host>:<port> pnpm judge          # FalkorDB tools + NetworkX verifier (needs uv)
FALKORDB_URL=... pnpm judge --no-python                 # use the committed NetworkX results in data/nyc/verify
FALKORDB_URL=... pnpm judge --bench                     # also rerun the 15-second concurrency benchmark
```

`pnpm judge` (`scripts/judge/judge.ts`) seeds the graphs if needed, closes the L between Bedford Av and 8 Av in a sandbox of its own, runs the same tools the agents call, runs `scripts/verify/verify.py`, and prints one line per claim with the README's value, FalkorDB's and NetworkX's. It also checks that the README still contains each claim's text. Any difference prints `MISMATCH` and exits 1. A local FalkorDB 4.22 (`docker run -p 6379:6379 falkordb/falkordb:v4.22.1`) is enough.

All numbers are riders an hour at 8 a.m. on a weekday, for the L closed between Bedford Av and 8 Av.

| README claim | Measured on FalkorDB by | Recomputed independently by | Pinned by |
|:---|:---|:---|:---|
| **23,445** riders an hour whose trips cross the closure | `affected_riders` and `measure_capacity` (`src/lib/graph/tools/impact.ts`, `capacity.ts`): demand pairs whose baseline path uses a closed segment | `verify.py`, `Model.displaced` | judge `displaced`; `scripts/ci/run-scenarios.ts` (closed segments) |
| 10,142 board within one stop; 14,713 within four | `affected_riders`: hop-by-hop upstream frontier in Cypher | `verify.py`, `depth_counts` (BFS) | judge `within one stop`, `within four stops`; proof page depth table |
| 4 G segments at **190 to 244%** of capacity | `measure_capacity` fastest-path reroute: one `algo.SPpaths` per displaced pair on the platform layer | `verify.py`, `Model.reroute` (same cost model: board 3 min + half headway, ride, free alight, walk; all-or-nothing) | judge `G overload`; `test_verify.py::test_cli_on_real_data`; run-scenarios (overloaded %, ±1 point) |
| 4,689 riders have no open path | same reroute: pairs `algo.SPpaths` finds no path for | `Model.reroute` (`strandedByStation` shows they all start or end at 1 Av or 3 Av) | judge `no open path`; `test_verify.py`; run-scenarios (±1.5) |
| Overflow 24,078 → 24,130 with the shuttle | `measure_capacity`, `simulate_plan` (each bus direction counted on its own) | `Model.reroute`, `evaluate_plan` (`scripts/verify/plans.json`) | judge `shuttle: overflow`; run-scenarios (1%) |
| The 1 Av → Astor Pl bus carries **2,487** riders an hour on 3,220 seats | `simulate_plan`: `peak` of the leg, from the reroute's per-direction bus loads | `Model.reroute` `busLoads` | judge `shuttle: bus load` |
| **17,167 of 18,432** toward Manhattan (93%) | `measure_capacity`: `algo.maxFlow` on the closure fork, checked by a max-flow/min-cut certificate (`certifyMaxFlow`), recomputed by Dinic if it fails | `verify.py`, `Model.solve` (`networkx` Edmonds-Karp, cut = flow asserted) | judge `max flow`, `max flow certified`; run-scenarios (±1.5); `flow.test.ts` |
| Bottleneck: **1 Av**, whose only rail links are the closed L | `measure_capacity` `cutOff` (`cutOffStations`): the min cut holds no open segment, only stations the closure cuts off; 1 Av is the origin, 3 Av the destination | `verify.py`, `Model.cut_off` | judge `bottleneck station`; run-scenarios (identical sets); `test_verify.py` |
| 1 Av ↔ Astor Pl: no path 4,689 → **623**; shortfall 1,266 → **315** | `simulate_plan` with 46 buses an hour on a `GRAPH.COPY` fork (36 for the riders of its busier direction, plus 27% from memory) | `evaluate_plan` (`scripts/verify/plans.json`, `l-canarsie-1av-astor`) | judge `shuttle: no path`, `shuttle: shortfall`; `test_verify.py` |
| A two-leg plan does no better with 18 more buses | `simulate_plan` with both legs | `evaluate_plan` (`l-canarsie-two-leg`) | judge `two legs do no better` |
| The June bus bridge carried 79% of plan, so **27%** more buses | `recall_memory`: remembered shuttles' observed / planned riders | the seed data itself (`src/lib/graph/seed-memory.ts`); a memory claim has no NetworkX counterpart | judge `memory: carried`, `memory: more buses` |
| 7,195 reads a second, 0 errors, tenants isolated | `scripts/ci/bench.ts` (48 readers, 6 writers, 6 tenant graphs, 15 s), committed in `data/proof/bench.json` | not recomputable elsewhere: throughput depends on the machine. `--bench` reruns it and requires 0 errors and isolation | judge `reads a second` |

## Beyond the README

| Claim | Where | Checked by |
|:---|:---|:---|
| Every `algo.maxFlow` answer is certified (feasible, no augmenting path, value = cut capacity) or recomputed by Dinic | `certifiedMaxFlow` in `capacity.ts`; `certifyMaxFlow`, `dinicMaxFlow` in `flow.ts` | `flow.test.ts` (300 random networks, Chokepoint's network); `data/eval/closures.json` `certificates` |
| FalkorDB 4.22.1 returns 300 instead of 453 on Chokepoint's 11-edge network, and a wrong value or a flow that breaks conservation on 13 of 100 random node-split networks; the certificate catches every one | `scripts/judge/maxflow-repro.ts` | `pnpm judge:maxflow`; `docs/model.md`, "Checking max flow" |
| Headroom: displaced demand toward Manhattan can grow 1.77× before an open segment (the G, Greenpoint Av to 21 St) saturates | `measureHeadroom` in `capacity.ts` (parametric max flow, exact breakpoint) | `verify.py`, `Model.headroom`; run-scenarios (relative 1e-3) |
| Held-out agreement: 48 random closures on 25 lines, FalkorDB and NetworkX agree on all 48 for every measure | `scripts/eval/closures-eval.ts` → `data/eval/closures.json` | rerun with `pnpm eval:closures` |
| The controller picks the best shuttle by gain per bus on 11 of the 15 held-out closures that need buses (mean gap 3.9%, worst 33%), with legs sized to the riders they carry | `scripts/eval/closures-eval.ts`: the scripted policy (`src/lib/agent/scripted.ts`) against an oracle that simulates every candidate leg | `data/eval/closures.json`, `policy` |

## Tolerances

FalkorDB rounds to whole riders, NetworkX keeps floats, so rider counts agree within 1.5. Closed segments and cut-off stations must be identical sets. Overloaded percentages agree within 1 point. Headroom agrees within a relative 1e-3. Fastest-path overflow agrees within 1% or lies inside the range NetworkX finds across 8 random tie-breaks between equally fast paths: all-or-nothing assignment is not unique when two paths take the same minutes. Ties exist on 9 of the 48 held-out closures; on 6 of them FalkorDB's choice differs from NetworkX's default, by up to 1,248 riders an hour, and all 6 lie inside NetworkX's tie-break range. On the README's L closure ties move it by at most 44 (24,078 to 24,122), and both programs' default choice gives 24,078.
