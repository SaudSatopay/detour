import { run } from "./db";
import { FINDING_SOURCES, ORG_DECISIONS, ORG_DOCUMENTS, ORG_MESSAGES, ORG_PEOPLE, ORG_TEAMS, ORG_TICKETS } from "./seed-org";

/** Bump when the org layer's model or sample data changes; an older layer is replaced. */
const ORG_VERSION = 1;

const ORG_LABELS = ["Team", "Person", "Document", "Ticket", "Message", "Decision", "OrgMeta"];
const DIGITS = ["1", "2", "3", "4", "5", "6", "7"];

const ms = (iso: string) => Date.parse(iso);

const pending = new Map<string, Promise<void>>();

/**
 * Adds the agency's people, teams, documents, tickets, chats and decisions to a graph that already
 * holds the network and its memory, wired to the same Station, Route, Incident, Finding and Playbook
 * nodes. Idempotent; concurrent callers for one graph share a single install.
 */
export function ensureOrgLayer(graph: string): Promise<void> {
  let job = pending.get(graph);
  if (!job) {
    job = install(graph).finally(() => pending.delete(graph));
    pending.set(graph, job);
  }
  return job;
}

async function install(graph: string): Promise<void> {
  const have = await run<{ v: number }>(graph, "MATCH (m:OrgMeta) RETURN m.version AS v LIMIT 1", {}, { readOnly: true });
  if (have.rows[0]?.v === ORG_VERSION) return;

  await run(graph, `MATCH (n) WHERE ${ORG_LABELS.map((l) => `n:${l}`).join(" OR ")} DETACH DELETE n`);
  await run(graph, "MERGE (a:Agent {id: 'brain'}) ON CREATE SET a.role = 'brain', a.name = 'Agency brain'");

  await run(graph, "UNWIND $teams AS t CREATE (:Team {id: t.id, name: t.name, mission: t.mission, ord: t.ord})", {
    teams: ORG_TEAMS.map((t, ord) => ({ id: t.id, name: t.name, mission: t.mission, ord })),
  });
  await run(graph, "UNWIND $people AS p MATCH (t:Team {id: p.team}) CREATE (:Person {id: p.id, name: p.name, role: p.role})-[:MEMBER_OF]->(t)", {
    people: ORG_PEOPLE.map((p) => ({ ...p })),
  });

  for (const t of ORG_TEAMS) {
    if (t.routes === "numbered") {
      await run(graph, "MATCH (t:Team {id: $team}), (r:Route) WHERE substring(r.id, 0, 1) IN $digits OR r.id = 'GS' CREATE (t)-[:OWNS]->(r)", { team: t.id, digits: DIGITS });
    } else if (t.routes === "lettered") {
      await run(graph, "MATCH (t:Team {id: $team}), (r:Route) WHERE NOT substring(r.id, 0, 1) IN $digits AND NOT r.id IN ['GS', 'SI'] CREATE (t)-[:OWNS]->(r)", {
        team: t.id,
        digits: DIGITS,
      });
    } else if (t.routes.length) {
      await run(graph, "MATCH (t:Team {id: $team}), (r:Route) WHERE r.id IN $routes CREATE (t)-[:OWNS]->(r)", { team: t.id, routes: t.routes });
    }
    if (t.playbooks.length) await run(graph, "MATCH (t:Team {id: $team}), (p:Playbook) WHERE p.id IN $ids CREATE (t)-[:OWNS]->(p)", { team: t.id, ids: t.playbooks });
    if (t.incidents.length) await run(graph, "MATCH (t:Team {id: $team}), (i:Incident) WHERE i.id IN $ids CREATE (t)-[:OWNS]->(i)", { team: t.id, ids: t.incidents });
    if (t.maintainsAccessible) await run(graph, "MATCH (t:Team {id: $team}), (s:Station) WHERE s.ada > 0 CREATE (t)-[:MAINTAINS]->(s)", { team: t.id });
  }

  await run(
    graph,
    `UNWIND $docs AS d MATCH (p:Person {id: d.author})
     CREATE (p)-[:AUTHORED]->(:Document {id: d.id, kind: d.kind, title: d.title, text: d.text, createdMs: d.createdMs})`,
    { docs: ORG_DOCUMENTS.map((d) => ({ id: d.id, kind: d.kind, title: d.title, text: d.text, author: d.author, createdMs: ms(d.created) })) },
  );
  await run(graph, "UNWIND $pairs AS p MATCH (d:Document {id: p.doc}), (pb:Playbook {id: p.pb}) CREATE (d)-[:DESCRIBES]->(pb)", {
    pairs: ORG_DOCUMENTS.filter((d) => d.describes).map((d) => ({ doc: d.id, pb: d.describes! })),
  });
  await run(
    graph,
    `UNWIND $tickets AS k MATCH (f:Person {id: k.filedBy}), (a:Person {id: k.assignedTo})
     CREATE (f)-[:FILED]->(:Ticket {id: k.id, title: k.title, text: k.text, station: k.station, route: k.route, status: k.status,
       openedMs: k.openedMs, resolvedMs: k.resolvedMs})-[:ASSIGNED_TO]->(a)`,
    {
      tickets: ORG_TICKETS.map((k) => ({
        id: k.id,
        title: k.title,
        text: k.text,
        station: k.station,
        route: k.route,
        status: k.status,
        openedMs: ms(k.opened),
        resolvedMs: k.resolved ? ms(k.resolved) : null,
        filedBy: k.filedBy,
        assignedTo: k.assignedTo,
      })),
    },
  );
  await run(
    graph,
    "UNWIND $msgs AS m MATCH (p:Person {id: m.author}) CREATE (p)-[:POSTED]->(:Message {id: m.id, channel: m.channel, text: m.text, atMs: m.atMs})",
    { msgs: ORG_MESSAGES.map((m) => ({ id: m.id, channel: m.channel, text: m.text, author: m.author, atMs: ms(m.at) })) },
  );
  await run(
    graph,
    `UNWIND $decs AS d MATCH (p:Person {id: d.by})
     CREATE (p)-[:DECIDED]->(:Decision {id: d.id, title: d.title, rationale: d.rationale, decidedMs: d.decidedMs, status: 'in force', until: d.until})`,
    { decs: ORG_DECISIONS.map((d) => ({ id: d.id, title: d.title, rationale: d.rationale, by: d.decidedBy, decidedMs: ms(d.decided), until: d.until ?? null })) },
  );

  // What each document, ticket, message and decision is about.
  const mentioning = [...ORG_DOCUMENTS, ...ORG_TICKETS, ...ORG_MESSAGES, ...ORG_DECISIONS];
  const pairs = (key: "stations" | "routes" | "incidents") => mentioning.flatMap((x) => (x.mentions[key] ?? []).map((target) => ({ x: x.id, target })));
  const ORG_NODE = "(x:Document OR x:Ticket OR x:Message OR x:Decision)";
  await run(graph, `UNWIND $pairs AS p MATCH (x {id: p.x}), (s:Station {id: p.target}) WHERE ${ORG_NODE} CREATE (x)-[:MENTIONS]->(s)`, { pairs: pairs("stations") });
  await run(graph, `UNWIND $pairs AS p MATCH (x {id: p.x}), (r:Route {id: p.target}) WHERE ${ORG_NODE} CREATE (x)-[:MENTIONS]->(r)`, { pairs: pairs("routes") });
  await run(graph, `UNWIND $pairs AS p MATCH (x {id: p.x}), (i:Incident {id: p.target}) WHERE ${ORG_NODE} CREATE (x)-[:MENTIONS]->(i)`, { pairs: pairs("incidents") });

  // Provenance: what each decision rests on and changed, and where each seeded finding came from.
  await run(graph, "UNWIND $pairs AS p MATCH (d:Decision {id: p.d}), (x {id: p.x}) CREATE (d)-[:BASED_ON]->(x)", {
    pairs: ORG_DECISIONS.flatMap((d) => d.basedOn.map((x) => ({ d: d.id, x }))),
  });
  await run(graph, "UNWIND $pairs AS p MATCH (d:Decision {id: p.d}), (x {id: p.x}) CREATE (d)-[:CHANGED]->(x)", {
    pairs: ORG_DECISIONS.flatMap((d) => d.changed.map((x) => ({ d: d.id, x }))),
  });
  await run(graph, "UNWIND $pairs AS p MATCH (f:Finding {id: p.f}), (x {id: p.x}) CREATE (f)-[:SOURCED_FROM]->(x)", {
    pairs: Object.entries(FINDING_SOURCES).flatMap(([f, xs]) => xs.map((x) => ({ f, x }))),
  });

  // Keep the layer consistent with what this visitor already reported: an outage fact closed before
  // the layer existed resolves its ticket, and lifts the decisions that rested on that ticket.
  await run(
    graph,
    `MATCH (f:Finding {kind: 'accessibility'})-[:SOURCED_FROM]->(k:Ticket {status: 'open'})
     WHERE f.validToMs IS NOT NULL
     SET k.status = 'resolved', k.resolvedMs = f.validToMs`,
  );
  await run(
    graph,
    `MATCH (d:Decision {status: 'in force'}), (k:Ticket {status: 'resolved'})
     WHERE d.until = k.id
     SET d.status = 'lifted', d.liftedMs = k.resolvedMs`,
  );

  for (const label of ["Team", "Person", "Document", "Ticket", "Message", "Decision"]) {
    await run(graph, `CREATE INDEX FOR (n:${label}) ON (n.id)`).catch(() => undefined);
  }
  await run(graph, "CREATE (:OrgMeta {version: $v, installedMs: timestamp()})", { v: ORG_VERSION });
}
