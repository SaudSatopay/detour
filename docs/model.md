# Detour's disruption model

This is the exact computation both implementations follow: the FalkorDB tools in `src/lib/graph/` and the independent NetworkX checker in `scripts/verify/`. Inputs are `data/nyc/network.json`, `data/nyc/demand.json` and `data/scenarios.json`.

## Network

- Nodes are station complexes (MTA complex ids).
- `RUNS` edges are directed route segments: one per (route, from, to) that has scheduled weekday service departing between 08:00 and 08:59. Each has `capacity` (trains per hour × planning capacity per train), `load` (baseline riders per hour) and `minutes`.
- `WALK` edges join complexes less than 400 m apart, in both directions, with capacity 3,000 riders per hour.
- **Platform layer** (for routing riders): a `Platform` node per station and route; `RIDE` edges along each scheduled segment (same `eid` as its `RUNS` edge); `BOARD` edges from the station to each of its platforms costing a 3-minute transfer penalty plus half the headway (capped at 30 minutes); free `ALIGHT` edges back to the station. A weighted shortest path over `BOARD`, `RIDE`, `ALIGHT` and `WALK` prices transfers the way the baseline assignment does.

## Closure

A closure is a set of routes and an ordered list of stations (the closed stretch, end to end). The closed segments are every `RUNS` edge whose `route` is in the set and whose `from` and `to` are both in the stretch. Direction: a closed segment is **forward** when its `to` comes later in the stretch than its `from`, otherwise **backward**.

## Displaced riders

A demand pair (origin, destination, riders per hour, path) is displaced when its baseline path uses at least one closed segment. Its direction is the direction of the first closed segment on its path.

**Depth.** "Affected within depth k" counts displaced pairs whose origin is at most k `RUNS` hops (any route, following edge direction) before a station of the stretch. Depth 0 means the rider boards inside the stretch. The contrast between depth 1 and depth 4 shows riders several stops away who never see the closure but whose trips cross it.

## Spare capacity

Displaced riders vacate their whole baseline path. For every open `RUNS` edge:

`spare = max(0, capacity − (load − displacedLoad))`

where `displacedLoad` is the riders per hour of all displaced pairs (both directions) whose path used that edge. Closed edges get `spare = 0`. `WALK` edges keep capacity 3,000.

## Where displaced riders go if nothing is done (fastest-path reroute)

On the closure fork (closed segments and their rides deleted), every displaced pair takes its fastest open path on the platform layer (riding, boarding with wait and transfer penalty, walking): one `algo.SPpaths` call per pair, all pairs in a single `UNWIND` query. New segment load = `load − displacedLoad + rerouted riders` on each `RIDE`'s segment. A segment is **overloaded** when its new load exceeds its capacity; the overflow is `newLoad − capacity`. Pairs with no open path are **stranded**.

## How many displaced riders can still get through (max flow)

Computed separately for each direction group, because trains in opposite directions do not share capacity.

1. Net balance per station: `net(x) = Σ riders of the group's pairs starting at x − Σ riders ending at x`.
2. A super source `SRC` feeds every station with `net > 0` (capacity `net`); every station with `net < 0` feeds a super sink `SNK` (capacity `−net`). This nets out riders who would only swap places, so the flow problem never counts a trip that uses no network.
3. Max flow from `SRC` to `SNK` over `RUNS` (spare), `WALK` and the feed edges, on the flow network described below. In FalkorDB: `CALL algo.maxFlow({sourceNodes:[src], targetNodes:[snk], relationshipTypes:['FLOW'], capacityProperty:'spare'})`.
4. **Required** = Σ positive net. **Absorbed** = max flow. **Unmet** = required − absorbed.

**The flow network.** `algo.maxFlow` takes one relationship type and no parallel edges, so the FalkorDB fork sums the spare capacity of every open `RUNS` and `WALK` edge between the same two stations (plus `BUS` legs on a plan's fork) into one `FLOW {kind: 'NET', spare, refs}` edge, where `refs` names the edges it stands for (`R<eid>`, `W<wid>`, `B<bid>`). `SRC` and `SNK` are `Hub` nodes per direction group (`SRC_F` and `SNK_F`, `SRC_B` and `SNK_B`), and the feed edges are `FLOW` edges of kind `FEED_F` or `FEED_B`. Summing parallel capacities does not change the max flow. The NetworkX checker keeps parallel edges apart instead: it splits each edge `u→v` into `u→(kind, id)→v`, with the capacity on the first arc.

This is a single-commodity relaxation with no detour limit: an upper bound on how many displaced riders the open network could carry if they spread perfectly. Read the two results together. The reroute shows what happens when everyone takes their fastest alternative (lines that overflow); the max flow shows what is possible if riders are steered (its edge flows are the steering plan the rider agents follow); the gap the max flow cannot close needs extra service.

## Checking max flow (certificate)

`algo.maxFlow` is not trusted on its word. After every call the tool reads back the edges it ran over and checks a max-flow/min-cut certificate (`certifyMaxFlow` in `src/lib/graph/flow.ts`):

1. **Feasible**: `0 ≤ flow ≤ spare` on every edge, and flow is conserved at every node except `SRC` and `SNK`.
2. **Maximal**: `SNK` is unreachable from `SRC` in the residual graph (no augmenting path).
3. **Consistent**: the reported value equals the net flow out of `SRC` and the capacity of the residual cut.

Tolerance is `1e-6 ×` the largest capacity on the network. If any check fails, Detour's own solver (`dinicMaxFlow`, Dinic's algorithm on the same edges) recomputes the flow, the new answer is certified the same way, and the result says so: `check: {checked, solver: 'falkordb' | 'dinic', value, cutCapacity, falkordb: {value, checked, problems}}` on every direction of `measure_capacity`, and a sentence in its summary that the control room shows under the call.

**Why.** Chokepoint (another Graph Hacks entry, [github.com/Hackmaass/Chokepoint](https://github.com/Hackmaass/Chokepoint)) found `algo.maxFlow` returning non-maximal flows on 12 to 17% of random node-split networks, with an 11-edge reproduction. We ran it on the FalkorDB Detour uses (`scripts/judge/maxflow-repro.ts`, module version 42201, i.e. 4.22.1, in a Vercel Sandbox on 2026-10-19):

| Network | `algo.maxFlow` | Exact (Dinic, NetworkX) | Certificate |
|:---|---:|---:|:---|
| Chokepoint's 11 edges | 300 | 453 | rejects it: flow not conserved at `a20:in` (158 in, nothing out), 458 leave the source while 300 is reported, and an augmenting path remains |
| 100 random node-split networks (seed 7) | wrong on 13 (13%): a value below the maximum, or flows that break conservation | | caught all 13, passed none of them |

The defect is present in 4.22.1. On Detour's own flow networks it has not fired: every `algo.maxFlow` answer on the three preset closures, their headroom searches and the 48 held-out closures passed the certificate (counts in `data/eval/closures.json`, `certificates`). The check costs one extra read of the fork's flow edges per call.

## Bottleneck (min cut)

From the max-flow residual graph, collect the nodes reachable from `SRC` through edges with `flow < spare` (forward) or `flow > 0` (backward). The min cut is every edge from a reachable node to an unreachable one. The bottlenecks shown to users are the `RUNS` and `WALK` edges in the cut (and `BUS` legs on a plan's fork); in FalkorDB they are the `refs` of each cut `NET` edge. Their summed spare equals the absorbed flow minus any cut feed edges, which is how the checker verifies the cut.

**When the cut holds no open segment.** Often the min cut crosses only feed edges: the open network has spare capacity everywhere displaced riders can reach, and the shortfall is riders at stations the closure cuts off. Those are named by connectivity over edges with spare capacity (`cutOffStations`): an **origin** is cut off when it reaches no destination of its group, a **destination** when no origin reaches it. In all six direction groups of the three preset closures the cut contains no open edge with spare. On the Lexington and Cranberry closures nothing is short at all. On the L the cut-off stations are 1 Av (origin, 1,266 riders an hour toward Manhattan) and 3 Av (destination, 315), the two stations only the L serves and with no walking link. The summary says exactly that instead of calling them a bottleneck. Riders "the network cannot move" (`strandedAt`, used to seed shuttle candidates) are cut-off origins first; other origins with riders left over are listed only when open segments bind, because when a destination is cut off the leftover supply lands on whichever origins the solver filled last.

## Headroom (parametric max flow)

How much more displaced demand fits before an open segment saturates? Scale every feed capacity by `λ`. The max flow `f(λ)` is the lower envelope of the cuts' lines `λ·F + N` (`F` a cut's feed capacity at `λ = 1`, `N` its network capacity). For small `λ` only feed cuts bind and `f(λ) = λ·F0`, where `F0` is the **connected demand** (max flow with unlimited spare). The **headroom** is the first breakpoint: the smallest `λ` where a cut through an open segment binds. Starting from `λ = 20`, each step runs a certified `algo.maxFlow` on the fork with the feeds scaled in Cypher (`SET f.spare = f.base * $lambda`), takes the min cut, and jumps to where that cut's line meets `λ·F0`, which is `N / (F0 − F)`. The sequence decreases and stops exactly at the breakpoint, usually in three or four solves (`parametricHeadroom` in `flow.ts`, `measureHeadroom` in `capacity.ts`). The edges of the last binding cut are the segments that fill first. On the L toward Manhattan the headroom is 1.77×, first filling the G between Greenpoint Av and 21 St; the verifier finds the same multiplier with `networkx.minimum_cut`.

## Shuttle plans

A plan adds `BUS` edges in both directions between two stations: `capacity = buses per hour × 70 riders` each way (a standard 40-ft bus at crush load), with `minutes = 4 + straight-line km × 3` for street running. A plan is simulated on a fork of the closure graph (`GRAPH.COPY`), max flow is recomputed with `BUS` included, and the gain is the difference in absorbed riders.

In the fastest-path reroute, a leg's load is counted per direction, the riders whose paths board it at each end, and each direction is compared with its own capacity. A leg whose busier direction runs over its seats reports the buses an hour that would carry those riders (`ceil(load / 70)`); the controller tests the plan again at that size, divided by the lowest share of plan a remembered shuttle on the corridor carried.

## Rider routing

Weighted shortest path on the platform layer plus `WALK` and the `BUS` edges of a published plan, weight `minutes`: `algo.SPpaths({sourceNode, targetNode, relTypes:['BOARD','RIDE','ALIGHT','WALK','BUS'], weightProp:'minutes', pathCount: k})`. Step-free riders take the first of the k fastest paths whose every boarding and exit is at a station with `ada = 1` and whose platform has no elevator outage remembered as current (an outage tagged with a route blocks only that route's platform).

## Checking the numbers

`scripts/verify/verify.py` recomputes, independently of FalkorDB: closed segments, displaced riders and their depth counts, max flow per direction with its cut, cut-off stations, headroom, the fastest-path reroute on the platform layer (riders with no path, overloaded segments, overflow) and the README's shuttle plans before and after. It cannot recompute what has no second implementation: graph memory (the 79% and 27%), the concurrency benchmark, and step-free routing.

Tolerances, the same in `scripts/ci/run-scenarios.ts`, `scripts/eval/closures-eval.ts` and `pnpm judge`: rider counts within 1.5 an hour (FalkorDB rounds, NetworkX keeps floats); closed segments and cut-off stations identical; overloaded percentages within 1 point; headroom within a relative 1e-3. Fastest-path overflow within 1%, or inside the range NetworkX finds over 8 random tie-breaks: when two paths take exactly the same minutes the all-or-nothing assignment is not unique, and which one `algo.SPpaths` or Dijkstra returns is an implementation detail. On the L the range is 24,078 to 24,122; on one held-out 7 closure it spans 391 to 1,639.

**Held-out closures.** `pnpm eval:closures` draws 48 closures with seed 20261019 (`heldOutClosures` in `flow.ts`: stretches of 2 to 6 segments, lines taken in a shuffled round, 25 lines in all), runs each through the scripted controller on FalkorDB and through the verifier, and writes `data/eval/closures.json`. On FalkorDB 4.22.1 the two programs agree on all 48 for closed segments, displaced riders, max flow per direction, riders with no path, cut-off stations, headroom and overflow (42 the same value, 6 inside the tie range); all 90 max flows and 254 headroom solves passed the certificate as FalkorDB returned them. It also scores the controller's plan choice against an oracle that simulates every shuttle candidate leg alone, at the controller's sizing, and keeps the best gain per bus: 15 closures need buses, the controller's choice is the best on 13, the mean gap is 3.9% and the worst 31% (it simulates only the first candidate for riders with no line and the first for relief).

**One command.** `pnpm judge` re-measures every headline number in the README on a FalkorDB, recomputes it with the verifier, and exits 1 on any mismatch. `CLAIMS.md` maps each claim to its code and tests.