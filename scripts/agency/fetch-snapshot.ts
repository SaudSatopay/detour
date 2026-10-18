/**
 * Fetches the agency's real records and writes data/agency/snapshot.json: the snapshot the shared agency graph
 * falls back to when a feed is unreachable, and the fixed input of the brain evaluation. Each run adds the
 * current outage feed as a new capture when it changed, so the snapshot keeps a short history of outages
 * opening and resolving.
 *   pnpm agency:snapshot            live feeds and archives
 *   pnpm agency:snapshot --live     live feeds only (adds an outage capture)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchArchive, fetchLive, type AgencySnapshot } from "../../src/lib/graph/agency-feeds";

const FILE = join(process.cwd(), "data", "agency", "snapshot.json");
/** Captures kept; older ones are dropped first. */
const MAX_CAPTURES = 12;

const sameOutages = (a: AgencySnapshot["outageCaptures"][number]["outages"], b: AgencySnapshot["outageCaptures"][number]["outages"]) => {
  const key = (o: (typeof a)[number]) => `${o.equipment}|${o.outagedate}|${o.estimatedreturntoservice}|${o.isupcomingoutage}`;
  const A = new Set(a.map(key));
  return a.length === b.length && b.every((o) => A.has(key(o)));
};

async function main() {
  const liveOnly = process.argv.includes("--live");
  const old: AgencySnapshot | null = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : null;

  const live = await fetchLive();
  console.log(`live: ${live.equipment.length} units, ${live.outages.length} outages, ${live.upcoming.length} planned, ${live.alerts.alerts.length} alerts`);
  const archive = liveOnly && old ? null : await fetchArchive();
  if (archive) {
    console.log(
      `archive: ${Object.keys(archive.stops).length} stops, ${archive.assets.length} assets, ${archive.notices.length} alert updates, ${archive.complaints.length} complaint months, ${archive.projects.length} projects, ${archive.milestones.length} milestones`,
    );
  }

  const captures = [...(old?.outageCaptures ?? [])];
  const last = captures[captures.length - 1];
  if (last && sameOutages(last.outages, live.outages)) {
    console.log("outage feed unchanged since the last capture; its time moves forward");
    last.fetchedMs = live.fetchedMs;
  } else {
    captures.push({ fetchedMs: live.fetchedMs, outages: live.outages });
  }

  const fetched: AgencySnapshot["fetched"] = {
    ...(old?.fetched ?? {}),
    "mta-ene-equipment": live.fetchedMs,
    "mta-ene-outages": live.fetchedMs,
    "mta-ene-upcoming": live.fetchedMs,
    "mta-subway-alerts": live.fetchedMs,
  };
  if (archive) {
    for (const id of ["39hk-dx4f", "94fv-bak7", "7kct-peq7", "nh7m-at3e", "9hy6-8j6t", "nswv-d6bz"] as const) fetched[id] = archive.fetchedMs;
  }

  const snapshot: AgencySnapshot = {
    version: 1,
    fetched,
    equipment: live.equipment,
    outageCaptures: captures.slice(-MAX_CAPTURES),
    upcoming: live.upcoming,
    alerts: { fetchedMs: live.fetchedMs, ...live.alerts },
    stops: archive?.stops ?? old?.stops ?? {},
    assets: archive?.assets ?? old?.assets ?? [],
    notices: archive?.notices ?? old?.notices ?? [],
    complaints: archive?.complaints ?? old?.complaints ?? [],
    projects: archive?.projects ?? old?.projects ?? [],
    milestones: archive?.milestones ?? old?.milestones ?? [],
  };
  mkdirSync(dirname(FILE), { recursive: true });
  const text = JSON.stringify(snapshot);
  writeFileSync(FILE, `${text}\n`);
  console.log(`wrote ${FILE}: ${(text.length / 1e6).toFixed(2)} MB, ${snapshot.outageCaptures.length} outage capture(s)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
