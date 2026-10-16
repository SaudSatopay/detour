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
3. Max flow from `SRC` to `SNK` over `RUNS` (spare), `WALK` and the feed edges. In FalkorDB: `CALL algo.maxFlow({sourceNodes:[src], targetNodes:[snk], relationshipTypes:['RUNS','WALK','FEED'], capacityProperty:'spare'})`.
4. **Required** = Σ positive net. **Absorbed** = max flow. **Unmet** = required − absorbed.

This is a single-commodity relaxation with no detour limit: an upper bound on how many displaced riders the open network could carry if they spread perfectly. Read the two results together. The reroute shows what happens when everyone takes their fastest alternative (lines that overflow); the max flow shows what is possible if riders are steered (its edge flows are the steering plan the rider agents follow); the gap the max flow cannot close needs extra service.

## Bottleneck (min cut)

From the max-flow residual graph, collect the nodes reachable from `SRC` through edges with `flow < spare` (forward) or `flow > 0` (backward). The min cut is every edge from a reachable node to an unreachable one. The bottlenecks shown to users are the `RUNS` and `WALK` edges in the cut. Their summed spare equals the absorbed flow minus any cut feed edges, which is how the checker verifies the cut.

## Shuttle plans

A plan adds `BUS` edges in both directions between two stations: `capacity = buses per hour × 70 riders` (a standard 40-ft bus at crush load), with `minutes = 4 + straight-line km × 3` for street running. A plan is simulated on a fork of the closure graph (`GRAPH.COPY`), max flow is recomputed with `BUS` included, and the gain is the difference in absorbed riders.

## Rider routing

Weighted shortest path on the platform layer plus `WALK` and the `BUS` edges of a published plan, weight `minutes`: `algo.SPpaths({sourceNode, targetNode, relTypes:['BOARD','RIDE','ALIGHT','WALK','BUS'], weightProp:'minutes', pathCount: k})`. Step-free riders take the first of the k fastest paths whose every boarding and exit is at a station with `ada = 1` and whose platform has no elevator outage remembered as current (an outage tagged with a route blocks only that route's platform).

## Station criticality

Harmonic centrality over open `RUNS` edges (`algo.HarmonicCentrality`). A station's drop in harmonic centrality after a closure shows how cut off it became.
