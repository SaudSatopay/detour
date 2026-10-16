/** Shapes of the NYC subway network built by scripts/build-network.ts from MTA open data. */

export type Borough = "M" | "Bk" | "Q" | "Bx" | "SI";

/** ADA accessibility as published by the MTA: 0 none, 1 fully accessible, 2 partially accessible. */
export type AdaLevel = 0 | 1 | 2;

export interface Station {
  /** MTA station complex id (shared with the origin-destination ridership dataset). */
  id: string;
  /** Short name, e.g. "14 St/6 Av". */
  name: string;
  /** Name with the routes it serves, e.g. "14 St/6 Av (1,2,3,L,F,M)". */
  label: string;
  lat: number;
  lon: number;
  borough: Borough;
  /** Inside Manhattan's central business district (MTA flag). */
  cbd: boolean;
  ada: AdaLevel;
  adaNotes: string | null;
  /** Base routes that stop here in the weekday 8 a.m. hour. */
  routes: string[];
  /** Riders entering here between 8:00 and 8:59 on a weekday (OD estimate). */
  entries: number;
  /** Riders leaving here between 8:00 and 8:59 on a weekday (OD estimate). */
  exits: number;
}

export interface Route {
  /** Base route id, e.g. "L", "6", "GS". Express variants (6X, 7X, FX) are folded in. */
  id: string;
  /** Rider-facing letter or number, e.g. "S" for every shuttle. */
  short: string;
  longName: string;
  /** Hex color from GTFS routes.txt, without '#'. */
  color: string;
  textColor: string;
  /** Planning capacity of one train, riders (cars × guideline load per car). */
  trainCapacity: number;
  /** Ordered station sequences served in the 8 a.m. hour, one per distinct pattern and direction. */
  patterns: string[][];
  sort: number;
}

export interface Segment {
  /** Stable id used by demand paths and by the graph (FalkorDB `eid`). */
  eid: number;
  route: string;
  from: string;
  to: string;
  /** Scheduled trains departing `from` toward `to` between 8:00 and 8:59 on a weekday. */
  tph: number;
  /** Median scheduled running time, minutes. */
  minutes: number;
  /** tph × train capacity, riders per hour. */
  capacity: number;
  /** Riders per hour assigned to this segment by the baseline shortest-path assignment. */
  load: number;
}

export interface Walk {
  wid: number;
  from: string;
  to: string;
  meters: number;
  minutes: number;
  capacity: number;
}

/** [origin, destination, riders per hour, journey minutes, segment eids, walk wids] */
export type DemandPair = [string, string, number, number, number[], number[]];

export interface Network {
  stations: Station[];
  routes: Route[];
  segments: Segment[];
  walks: Walk[];
}

export interface Demand {
  pairs: DemandPair[];
}

export interface NetworkMeta {
  builtAt: string;
  sources: { name: string; url: string; slice?: string; retrieved: string }[];
  assumptions: Record<string, string | number>;
  counts: Record<string, number>;
  ridership: {
    totalRiders: number;
    pairsTotal: number;
    pairsKept: number;
    ridersKept: number;
    ridersAssigned: number;
    unassignedPairs: number;
  };
}
