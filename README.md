<p align="center">
  <a href="https://detour-orpin.vercel.app">
    <img src="public/og.png" width="100%" alt="Detour. When a subway line breaks, measure what the city can still carry. Closing the L displaces 23,445 riders an hour, overloads the G to 244%, and max flow shows 93% can still move.">
  </a>
</p>

<h1 align="center">Detour</h1>

<p align="center">
  <b>When a New York subway line breaks, Detour measures what the rest of the city can still carry.</b>
</p>

<p align="center">
  <a href="https://detour-orpin.vercel.app"><img alt="Live demo: detour-orpin.vercel.app" src="https://img.shields.io/badge/live_demo-detour--orpin.vercel.app-00848b?style=flat-square&labelColor=0d1013"></a>
  <a href="https://www.wemakedevs.org/hackathons/falkordb"><img alt="Graph Hacks: tracks 1 and 2" src="https://img.shields.io/badge/Graph_Hacks-tracks_1_%2B_2-00848b?style=flat-square&labelColor=0d1013"></a>
  <a href="#why-a-graph"><img alt="FalkorDB: maxFlow, SPpaths, GRAPH.COPY" src="https://img.shields.io/badge/FalkorDB-maxFlow_%C2%B7_SPpaths_%C2%B7_GRAPH.COPY-00848b?style=flat-square&labelColor=0d1013"></a>
  <a href="#use-it-from-an-agent"><img alt="MCP: streamable HTTP" src="https://img.shields.io/badge/MCP-streamable_HTTP-00848b?style=flat-square&labelColor=0d1013"></a>
</p>

<p align="center">
  <a href="https://detour-orpin.vercel.app/control?scenario=l-canarsie&run=1"><b>Control room</b></a> &nbsp;·&nbsp;
  <a href="https://detour-orpin.vercel.app/riders?rider=aisha"><b>Riders</b></a> &nbsp;·&nbsp;
  <a href="https://detour-orpin.vercel.app/memory"><b>Memory</b></a> &nbsp;·&nbsp;
  <a href="https://detour-orpin.vercel.app/proof"><b>Proof</b></a> &nbsp;·&nbsp;
  <a href="#use-it-from-an-agent"><b>MCP</b></a>
</p>

<br>

Agents work on a FalkorDB graph of the real subway, built from MTA open data. When a line breaks, they:

1. **Find** whose trips the closure breaks, including riders four stops away who never see it.
2. **Measure** what the open network can absorb with `algo.maxFlow`, and name the bottleneck (min cut).
3. **Test** shuttle-bus plans on forked copies of the graph.
4. **Tell** every remembered rider what to take instead, after a person approves.

Memory lives in the same graph: facts carry dates, and a fact that stops being true is closed, not deleted, so it changes the next answer.

| Track | Where to see it |
|:---|:---|
| **1 · Agents That Act on Connected Data** (primary) | The [control room](https://detour-orpin.vercel.app/control?scenario=l-canarsie&run=1) runs the controller on your own copy of the graph and shows every tool call with its Cypher |
| **2 · Agent Memory and Coordination** | On the [riders page](https://detour-orpin.vercel.app/riders?rider=aisha), a superseded fact changes a wheelchair user's route; the [memory page](https://detour-orpin.vercel.app/memory) shows every episode, finding and handoff |

## What it finds on the L train

> [!NOTE]
> Every number in this table comes from tool calls on FalkorDB and is recomputed by an independent NetworkX program.

Close the L between Bedford Av and 8 Av at 8 a.m. on a weekday:

| Question | What the graph says |
|:---|:---|
| Whose trips cross the closure? | **23,445** riders an hour (10,142 board within one stop of it; 14,713 within four) |
| Where do they go if nobody steers them? | 4 G segments run at **190 to 244%** of capacity; 4,689 riders have no open path |
| What can the open network carry if riders spread perfectly? *(max flow)* | **17,167 of 18,432** riders an hour toward Manhattan (93%) |
| Where is the bottleneck? *(min cut)* | **1 Av**: its only rail links are the closed L, so no spare capacity elsewhere reaches its riders |
| Does a shuttle help? *(tested on a fork)* | 1 Av ↔ Astor Pl: riders with no path 4,689 → **623**; max-flow shortfall 1,266 → **315**. A two-leg plan does no better with 18 more buses |
| Did memory change the plan? | The June bus bridge carried 79% of plan, so the controller adds **27%** more buses |

With the shuttle, fastest-path overflow rises (24,078 → 28,762) because 4,066 more riders can now travel, so the rider desk steers them onto lines with room. The Lexington express and Cranberry Street Tunnel closures come out differently: the open network absorbs everyone, so the controller proposes steering riders with no buses at all.

## See it run

<p align="center">
  <a href="https://detour-orpin.vercel.app/control?scenario=l-canarsie&run=1">
    <img src="docs/images/control-room.gif" alt="A run of the L closure: the controller's tool calls stream in, the map shows each step's evidence, and the G overload and max flow appear with their numbers.">
  </a>
  <br>
  <sub>The controller on the L closure: each tool call streams into the trace, and the map shows its evidence.</sub>
</p>

## How it works

```mermaid
flowchart LR
    dispatcher(["Dispatcher<br/>describes a closure"]) --> agents
    subgraph agents ["Agents"]
        direction TB
        controller["Controller agent<br/>Gemini, then Groq, or<br/>its procedure as code"]
        approval{"A person<br/>approves"}
        desk["Rider desk<br/>one agent per<br/>affected rider"]
        controller -- "plans and a brief" --> approval
        approval -- "HANDED_OFF" --> desk
    end
    agents -- "fixed tool catalogue<br/>13 tools · 83 queries" --> falkor
    subgraph falkor ["FalkorDB"]
        direction TB
        template[("detour:template<br/>network and seeded memory")]
        sandbox[("detour:sbx:‹visitor›<br/>your closures, plans, memory")]
        fork[("detour:fork:…<br/>one per what-if")]
        demand[("detour:demand<br/>30,205 origin-destination<br/>flows, read-only")]
        template -- "GRAPH.COPY" --> sandbox
        sandbox -- "GRAPH.COPY" --> fork
    end
    style agents fill:transparent,stroke:#8b949e,stroke-dasharray:4 3
    style falkor fill:transparent,stroke:#00848b,stroke-width:2px
```

- **The model never writes Cypher.** It picks from a fixed catalogue of typed tools. Each returns one of four answer shapes (answered, from memory, not in the graph, unknown name), a one-line summary, the data, and the exact queries it ran with their timings, which the control room shows step by step.
- **Three run modes, labeled in the interface.** *Live*: a free model (Gemini, then Groq) chooses the tools. *Scripted*: when the free quota is spent, the controller's procedure runs as code with the same tools on your graph. *Recorded*: when the database is unreachable, a run recorded on FalkorDB plays back.
- **Every visitor gets a graph.** The first request copies the template into `detour:sbx:<visitor>`; what-if forks are copied from that and deleted after use. Visitors never write to the template, and the demand graph is shared and read-only.

## Why a graph

Each step is a graph question that a table or a vector store answers badly:

| Question | How the graph answers it |
|:---|:---|
| **Whose trips cross the break?** | Demand edges carry the segment ids of their 8 a.m. path; stations upstream are found hop by hop over `RUNS` |
| **What can the rest of the network carry?** | `algo.maxFlow` from a super source to a super sink over spare capacity, per direction of travel, on a fork without the closed segments. The min cut comes from the residual graph |
| **Where do riders actually go?** | `algo.SPpaths` over a platform layer (board, ride, alight, walk, bus), so waits and transfers are priced the way the baseline assignment prices them |
| **What did we learn last time?** | Findings hang off the same `Station` and `Route` nodes, so recall is a match from the stations an agent is about to touch |

## Graph data model

**The network** (`detour:template`, copied into every visitor's sandbox). Max flow runs on the station-to-station links; shortest paths add the platform layer, so waits and transfers have a price.

```mermaid
flowchart LR
    route(["Route"]) -- SERVES --> a(["Station"])
    a -- "RUNS · WALK · BUS<br/>capacity, load, spare" --> b(["Station"])
    a -- "BOARD<br/>3 min + half the headway" --> pa(["Platform"])
    pa -- RIDE --> pb(["Platform"])
    pb -- ALIGHT --> b
```

**Memory and coordination** (in each sandbox). Everything an agent does or learns hangs off the same `Station` and `Route` nodes it reasons about.

```mermaid
flowchart TB
    controller(["Agent<br/>controller"]) -- HANDED_OFF --> desk(["Agent<br/>rider desk"])
    controller -- OPENED --> incident(["Incident"])
    controller -- PROPOSED --> plan(["Plan"])
    controller & desk -- ACTED --> episode(["Episode"])
    controller & desk -- WROTE --> finding(["Finding<br/>valid from, valid to"])
    desk -- WROTE --> advisory(["Advisory"])
    plan -- FOR --> incident
    episode -- IN --> incident
    finding -- FROM --> incident
    finding -- SUPERSEDES --> closed(["Finding<br/>closed, still queryable"])
    shuttle(["Shuttle<br/>planned vs observed"]) -- FOR --> incident
    advisory -- FOR --> rider(["Rider"])
    rider -- PREFERS --> preference(["Preference"])
    finding -- ABOUT --> station(["Station"])
    incident -- CLOSES --> station
    rider -- "STARTS_AT · ENDS_AT" --> station
    finding -- ABOUT --> route(["Route"])
    playbook(["Playbook"]) -- FOR --> route
    classDef network stroke:#00848b,stroke-width:2px
    class station,route network
```

The demand graph (`detour:demand`, shared and read-only) holds one `DEMAND` edge per station pair: 30,205 pairs, 404,040 of 446,230 riders at 8 a.m. Forks add `(:Hub {id: 'SRC_F' | 'SNK_F' | …})` and `FLOW {kind, spare, refs}` edges: spare capacity summed per corridor, because `algo.maxFlow` takes one relationship type and no parallel edges. The full spec both implementations follow is [docs/model.md](docs/model.md).

<details>
<summary><b>Every label and property</b></summary>

<br>

**Network** (`detour:template`, copied per visitor)

```cypher
(:Station {id, name, label, lat, lon, loc, borough, ada, routes, entries})
(:Route {id, short, longName, color})-[:SERVES]->(:Station)

// 1,459 scheduled segments
(:Station)-[:RUNS {eid, route, tph, minutes, baseMinutes, capacity, load, spare, closed}]->(:Station)
// 190 walking links under 400 m
(:Station)-[:WALK {wid, meters, minutes, capacity, spare}]->(:Station)
// BOARD minutes = 3 + half the headway
(:Station)-[:BOARD {minutes}]->(:Platform {id, station, route})
(:Platform)-[:RIDE {eid, minutes, closed}]->(:Platform)-[:ALIGHT {minutes: 0}]->(:Station)
// published shuttle legs
(:Station)-[:BUS {bid, plan, capacity, minutes, busesPerHour}]->(:Station)
```

**Demand** (`detour:demand`, shared and read-only)

```cypher
// 30,205 pairs, 404,040 of 446,230 riders at 8 a.m.
(:Station)-[:DEMAND {riders, minutes, via: [eid], walks: [wid]}]->(:Station)
```

**Memory and coordination** (in each sandbox)

```cypher
(:Agent)-[:WROTE]->(:Finding {id, text, kind, confidence, validFromMs, validToMs})-[:ABOUT]->(:Station | :Route)
// a changed fact gets an end date and a successor
(:Finding)-[:SUPERSEDES]->(:Finding)
(:Finding)-[:FROM]->(:Incident)
(:Agent)-[:OPENED]->(:Incident {id, routes, stretch, closedEids, status, displaced,
                                overflow, stranded, required, absorbed, unmet})-[:CLOSES]->(:Station)
(:Agent)-[:ACTED]->(:Episode {tool, outcome, summary, queries, ms, atMs})-[:IN]->(:Incident)
(:Agent)-[:PROPOSED]->(:Plan {id, legs, vehicles, strandedBefore, strandedAfter,
                              unmetBefore, unmetAfter, …})-[:FOR]->(:Incident)
(:Agent)-[:HANDED_OFF {plan, incident, note, atMs}]->(:Agent)
(:Shuttle {busesPerHour, planned, observed})-[:FOR]->(:Incident)
(:Playbook {title, steps, uses, lastUsedMs})-[:FOR]->(:Route)
(:Rider {id, name, persona, stepFree, usualEids})-[:STARTS_AT|ENDS_AT]->(:Station)
(:Rider)-[:PREFERS {validFromMs, validToMs}]->(:Preference {key, value})
(:Agent)-[:WROTE]->(:Advisory {text, minutes, route, stepFree, atMs})-[:FOR]->(:Rider)
```

</details>

## The queries it depends on

All 83 queries and graph commands are listed with their labels on the [proof page](https://detour-orpin.vercel.app/proof#cypher). The two that carry the reasoning:

```cypher
// On a fork without the closed segments: spare capacity summed per corridor, then max flow
MATCH (a:Station)-[r]->(b:Station) WHERE type(r) IN $kinds
WITH a, b, sum(r.spare) AS spare,
     collect(CASE type(r) WHEN 'RUNS' THEN 'R' + toString(r.eid)
                          WHEN 'WALK' THEN 'W' + toString(r.wid)
                          ELSE 'B' + toString(r.bid) END) AS refs
CREATE (a)-[:FLOW {spare: spare, kind: 'NET', refs: refs}]->(b)

MATCH (src:Hub {id: $src}), (snk:Hub {id: $snk})
CALL algo.maxFlow({sourceNodes: [src], targetNodes: [snk],
                   relationshipTypes: ['FLOW'], capacityProperty: 'spare'})
YIELD maxFlow, edges, edgeFlows
RETURN maxFlow,
       [e IN edges | [e.kind, startNode(e).id, endNode(e).id]] AS es,
       edgeFlows AS flows
```

```cypher
// Every displaced pair on its fastest open path, in one query
UNWIND $pairs AS p
MATCH (a:Station {id: p.o}), (b:Station {id: p.d})
CALL algo.SPpaths({sourceNode: a, targetNode: b,
                   relTypes: ['BOARD', 'RIDE', 'ALIGHT', 'WALK', 'BUS'], weightProp: 'minutes'})
YIELD path, pathWeight
RETURN p.o AS o, p.d AS d, pathWeight AS minutes,
       [r IN relationships(path) WHERE type(r) = 'RIDE' | r.eid] AS eids
```

<details>
<summary><b>Four more: who is hit, upstream stations, forks and recall</b></summary>

<br>

```cypher
// Whose trips cross the closure (demand graph)
MATCH (o:Station)-[d:DEMAND]->(x:Station)
WHERE any(e IN d.via WHERE e IN $closed)
RETURN o.id AS o, x.id AS d, d.riders AS riders, d.via AS via

// Stations k stops upstream, one hop per query
// (variable-length paths over parallel edges time out)
MATCH (o:Station)-[:RUNS]->(t:Station)
WHERE t.id IN $frontier AND NOT o.id IN $seen
RETURN DISTINCT o.id AS id

// A what-if fork per call
GRAPH.COPY detour:sbx:<visitor> detour:fork:<visitor>:<label>

// Memory: recall from the stations and routes an agent is about to touch
MATCH (f:Finding)-[:ABOUT]->(n)
WHERE (n:Station AND n.id IN $stations) OR (n:Route AND n.id IN $routes)
WITH DISTINCT f
OPTIONAL MATCH (f)-[:FROM]->(i:Incident)
RETURN f.id AS id, f.text AS text, f.validFromMs AS validFromMs,
       f.validToMs AS validToMs, i.id AS incident
```

</details>

## Track 2: memory you can watch change an answer

On the [riders page](https://detour-orpin.vercel.app/riders?rider=aisha), Aisha uses a wheelchair. Memory says the elevator to the L platform at Myrtle-Wyckoff Avs has been out since Oct 14, so her step-free route skips the faster L and takes the M (33 min). Report the elevator fixed: the rider desk writes a new finding that supersedes the outage (the old one gets an end date and stays queryable), and her next route is the L (24 min).

<p align="center">
  <img src="docs/images/memory-changes-route.png" alt="Aisha's step-free route before and after the elevator outage was superseded in memory: the L in 24 minutes now, the M in 33 minutes before the memory changed.">
</p>

The write that changes her route:

```cypher
// A fact that stopped being true is closed and linked to its successor, never deleted
MATCH (old:Finding {id: $old}), (f:Finding {id: $id})
WHERE old.validToMs IS NULL
SET old.validToMs = timestamp()
CREATE (f)-[:SUPERSEDES]->(old)
```

| Memory | How it lives in the graph |
|:---|:---|
| **Episodic** | Every tool call becomes an `Episode` linked to its incident ([memory page](https://detour-orpin.vercel.app/memory)) |
| **Semantic, with time** | Findings carry `validFromMs`/`validToMs` and provenance (who wrote it, from which incident) |
| **Procedural** | Playbooks per route; past shuttles keep planned against observed riders, and the controller sizes new bus plans by the worst ratio it remembers |
| **Shared state and handoffs** | Approval writes `HANDED_OFF` from the controller to the rider desk, which runs one agent per affected rider concurrently |
| **Per tenant, under load** | One graph per visitor. 48 reader and 6 writer agents across 6 tenant graphs sustained 7,195 reads and 719 writes a second (p95 15.5 ms and 17.1 ms), 0 errors, and a closure in one tenant was invisible in the other five |

## Proof

| Check | Result |
|:---|:---|
| Max flow, FalkorDB `algo.maxFlow` vs NetworkX Edmonds-Karp | Agree in all 6 direction groups of the 3 closures |
| Riders hit by distance from the L closure | Agree at every depth, 0 to 6 stops |
| Closed segments per scenario | Identical sets |
| Concurrency (FalkorDB 4.22.1) | 7,195 reads/s and 719 writes/s, 0 errors, tenant isolation held |
| Unit tests | 26 Vitest tests, including the control room's state on recorded runs and the eval grader |
| End-to-end tests | 7 Playwright tests, each on desktop and phone, including axe accessibility checks after a run and after approval, in light and dark |
| Lighthouse, mobile (home, control room, proof) | Performance 98 to 99; accessibility, best practices and SEO 100 |

<p align="center">
  <img src="docs/images/proof.png" alt="The proof page: FalkorDB and NetworkX side by side for every closure.">
</p>

## Screens

<table>
  <tr>
    <td width="37%" rowspan="2" align="center">
      <img src="docs/images/phone-dark.png" width="100%" alt="The control room on a phone in the dark theme, with the dispatcher's report, the run button and the flow map.">
      <br>
      <sub><b>On a phone, in the dark theme.</b> The dispatcher's report, the run button and the flow map.</sub>
    </td>
    <td width="63%">
      <img src="docs/images/control-room.png" width="100%" alt="The control room after closing the L: displaced riders' fastest paths overload the G (red), max flow moves 17,167 of 18,432 riders an hour, and the trace shows every tool call with its Cypher.">
      <br>
      <sub><b>Control room.</b> The G overloads in red, max flow moves 17,167 of 18,432 riders an hour, and the trace shows every tool call with its Cypher.</sub>
    </td>
  </tr>
  <tr>
    <td width="63%">
      <img src="docs/images/rider-desk.png" width="100%" alt="After approval: two shuttle plans tested on forked graphs, the recommended one published to riders, and a rider agent routing Tomás around the closure.">
      <br>
      <sub><b>After approval.</b> Two shuttle plans tested on forks, the recommended one published, and a rider agent routing Tomás around the break.</sub>
    </td>
  </tr>
</table>

## Use it from an agent

The same tools are served over MCP (Streamable HTTP) at `https://detour-orpin.vercel.app/api/mcp`. `assess_closure` runs on a private copy of the graph, so clients never see each other's closures.

```bash
claude mcp add --transport http detour https://detour-orpin.vercel.app/api/mcp
```

| Tool | What it does |
|:---|:---|
| `resolve_places` | Resolves station and route names to graph ids, with ambiguous candidates or unknown names |
| `route_trip` | The fastest route at 8 a.m. on a weekday; `step_free` keeps every boarding and exit accessible and skips platforms with a remembered elevator outage |
| `recall_memory` | Dated facts, past incidents with planned versus observed shuttle capacity, and playbooks for the given routes and stations |
| `assess_closure` | Closes routes between two stations on a private copy of the graph, then reports riders hit by distance, overflow, max flow with the min cut and, optionally, a shuttle plan (about 4 seconds; 30 an hour per client) |

## Run it locally

Requirements: Node 22+, pnpm 11, a FalkorDB instance (FalkorDB Cloud's free tier, or `docker run -p 6379:6379 falkordb/falkordb`), and optionally a free Gemini or Groq key.

```bash
pnpm install
cp .env.example .env.local
# in .env.local: FALKORDB_URL, and GOOGLE_GENERATIVE_AI_API_KEY or GROQ_API_KEY for live agents
pnpm seed    # loads the network, demand and memory into FalkorDB (about a second)
pnpm dev     # http://localhost:3000
```

From a clean checkout, install, type check, unit tests and a production build take about a minute (62 s with a warm pnpm cache). The built network is committed in `data/nyc/`; to rebuild it from MTA sources, run `pnpm fetch:data && pnpm build:data`.

| Command | What it checks |
|:---|:---|
| `pnpm test` | Unit tests (Vitest) |
| `pnpm typecheck`, `pnpm lint` | Types and lint |
| `pnpm test:e2e` | Playwright on desktop and phone; set `BASE_URL` to test a deployment |
| `pnpm verify` | The NetworkX verifier (needs [uv](https://docs.astral.sh/uv/)) |
| `pnpm ci:scenarios` | Every tool on all three closures against FalkorDB, compared with NetworkX |
| `pnpm ci:bench` | The concurrency and tenant-isolation benchmark |

**Stack:** Next.js 16 (App Router, Cache Components), React 19, Tailwind 4, TypeScript, FalkorDB 4.22 via `falkordb` 6.8, Vercel AI SDK 7 with Gemini and Groq, and `mcp-handler`. Deployed on Vercel.

## Data

[MTA GTFS static](http://web.mta.info/developers/data/nyct/subway/google_transit.zip) (weekday trains departing 08:00 to 08:59 give trains per hour and capacity), [MTA Subway Stations](https://data.ny.gov/d/39hk-dx4f) and [Stations and Complexes](https://data.ny.gov/d/5f5g-n3cz) (accessibility), and the [MTA Subway Origin-Destination Ridership Estimate: 2025](https://data.ny.gov/d/y2qv-fytt) (a Wednesday in October 2025, 8 a.m.). Assumptions are listed on the [proof page](https://detour-orpin.vercel.app/proof#data). The remembered riders, past incidents and playbooks are example data and labeled as such. Detour is not affiliated with the MTA.

## AI assistance

Detour was built with [Claude Code](https://claude.com/claude-code), Anthropic's coding agent, as a pair programmer: it did much of the research, design, code, tests and documentation under my direction. At runtime the agents use free-tier Gemini and Groq models. The graph model, queries and architecture are documented above, and every number the agents report is checked by the NetworkX verifier rather than by a language model.
