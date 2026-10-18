import type { BrainTurn } from "../brain/types";
import { run } from "./db";

/**
 * Conversation history as graph state. Each agent keeps one Conversation per visitor graph; every question
 * and answer is a Turn chained by NEXT, the question linked to the stations and routes it mentions and the
 * answer to the nodes it cites. Agents read their history back from here, so a returning visitor's
 * conversation continues for as long as their graph is kept.
 */

export interface StoredTurn {
  role: "user" | "assistant";
  text: string;
  mode?: string | null;
  /** Station ids and route ids the turn mentions. */
  stations?: string[];
  routes?: string[];
  /** Ids of nodes an answer cites (documents, tickets, chats, decisions, findings, playbooks, plans). */
  cites?: string[];
}

const conversationId = (agent: string) => `CONV-${agent}`;
const turnId = () => `T-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, "0")}`;

/** Appends turns to the agent's conversation in this graph. Best effort: a failed write never fails the answer. */
export async function rememberTurns(graph: string, agent: string, turns: StoredTurn[]): Promise<string[]> {
  const ids: string[] = [];
  try {
    const conv = conversationId(agent);
    await run(graph, "MERGE (c:Conversation {id: $conv}) ON CREATE SET c.agent = $agent, c.startedMs = timestamp()", { conv, agent });
    for (const t of turns) {
      const id = turnId();
      await run(
        graph,
        `MATCH (c:Conversation {id: $conv})
         OPTIONAL MATCH (last:Turn) WHERE last.id = c.lastTurn
         CREATE (c)-[:HAS]->(t:Turn {id: $id, role: $role, text: $text, atMs: timestamp(), mode: $mode, cites: $cites, stations: $stations, routes: $routes})
         FOREACH (_ IN CASE WHEN last IS NULL THEN [] ELSE [1] END | CREATE (last)-[:NEXT]->(t))
         SET c.lastTurn = $id, c.lastMs = timestamp()`,
        // Cited ids are kept on the turn too: MTA records live in the shared agency graph, out of reach of a CITES edge.
        { conv, id, role: t.role, text: t.text.slice(0, 4000), mode: t.mode ?? null, cites: (t.cites ?? []).slice(0, 24), stations: t.stations ?? [], routes: t.routes ?? [] },
      );
      if (t.role === "assistant") {
        await run(graph, "MATCH (a:Agent {id: $agent}), (t:Turn {id: $id}) CREATE (a)-[:SAID]->(t)", { agent, id });
      }
      if (t.stations?.length || t.routes?.length) {
        await run(
          graph,
          `MATCH (t:Turn {id: $id}), (n)
           WHERE (n:Station AND n.id IN $stations) OR (n:Route AND n.id IN $routes)
           CREATE (t)-[:MENTIONS]->(n)`,
          { id, stations: t.stations ?? [], routes: t.routes ?? [] },
        );
      }
      if (t.cites?.length) {
        await run(
          graph,
          `UNWIND $cites AS cid
           MATCH (t:Turn {id: $id}), (x) WHERE x.id = cid
             AND (x:Document OR x:Ticket OR x:Message OR x:Decision OR x:Finding OR x:Playbook OR x:Plan)
           CREATE (t)-[:CITES]->(x)`,
          { id, cites: t.cites },
        );
      }
      ids.push(id);
    }
  } catch {
    // History is best effort; the answer already reached the visitor.
  }
  return ids;
}

/** The agent's last turns in this graph, oldest first, as model messages. */
export async function recentTurns(graph: string, agent: string, limit = 8): Promise<{ role: "user" | "assistant"; content: string }[]> {
  try {
    const res = await run<{ role: "user" | "assistant"; text: string }>(
      graph,
      `MATCH (:Conversation {id: $conv})-[:HAS]->(t:Turn)
       RETURN t.role AS role, t.text AS text, t.atMs AS atMs
       ORDER BY atMs DESC LIMIT ${Math.max(1, Math.min(20, Math.round(limit)))}`,
      { conv: conversationId(agent) },
      { readOnly: true },
    );
    const turns = res.rows.reverse().map((t) => ({ role: t.role, content: t.text }));
    // A history handed to a model starts with a question.
    while (turns.length && turns[0].role !== "user") turns.shift();
    return turns;
  } catch {
    return [];
  }
}

/** The previous question and what its answer was about: the ids it cited and the stations and lines it mentioned. */
export interface LastExchange {
  question: string;
  answer: string;
  cites: string[];
  stations: string[];
  routes: string[];
}

/** The agent's last question and answer in this graph, read from the Turn chain and its CITES and MENTIONS edges. */
export async function lastExchange(graph: string, agent: string): Promise<LastExchange | null> {
  try {
    const res = await run<{ question: string; answer: string; cites: string[] | null; cited: string[]; stations: string[]; routes: string[]; atMs: number }>(
      graph,
      `MATCH (:Conversation {id: $conv})-[:HAS]->(q:Turn {role: 'user'})-[:NEXT]->(a:Turn {role: 'assistant'})
       WITH q, a ORDER BY q.atMs DESC LIMIT 1
       OPTIONAL MATCH (a)-[:CITES]->(x)
       OPTIONAL MATCH (q)-[:MENTIONS]->(m)
       RETURN q.text AS question, a.text AS answer, a.cites AS cites, collect(DISTINCT x.id) AS cited,
              collect(DISTINCT CASE WHEN hasLabels(m, ['Station']) THEN m.id ELSE null END) AS stations,
              collect(DISTINCT CASE WHEN hasLabels(m, ['Route']) THEN m.id ELSE null END) AS routes, q.atMs AS atMs`,
      { conv: conversationId(agent) },
      { readOnly: true },
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      question: r.question,
      answer: r.answer,
      cites: [...new Set([...(r.cites ?? []), ...(r.cited ?? [])].filter(Boolean))],
      stations: (r.stations ?? []).filter(Boolean),
      routes: (r.routes ?? []).filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** The visitor's question-and-answer pairs with this agent, newest first. */
export async function conversationPairs(graph: string, agent: string, limit = 6): Promise<BrainTurn[]> {
  try {
    const res = await run<BrainTurn & { stored: string[] | null }>(
      graph,
      `MATCH (:Conversation {id: $conv})-[:HAS]->(q:Turn {role: 'user'})-[:NEXT]->(a:Turn {role: 'assistant'})
       OPTIONAL MATCH (a)-[:CITES]->(x)
       RETURN q.id AS id, q.text AS question, a.text AS answer, q.atMs AS atMs, a.mode AS mode, a.cites AS stored, collect(x.id) AS cites
       ORDER BY atMs DESC LIMIT ${Math.max(1, Math.min(20, Math.round(limit)))}`,
      { conv: conversationId(agent) },
      { readOnly: true },
    );
    return res.rows.map(({ stored, ...r }) => ({ ...r, cites: [...new Set([...(stored ?? []), ...(r.cites ?? [])])].filter(Boolean) }));
  } catch {
    return [];
  }
}
