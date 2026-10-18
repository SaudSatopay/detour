/**
 * The brain's held-out evaluation. Deterministic, no model: questions and their answers come from the committed
 * snapshot (data/agency/snapshot.json) in plain code; each question is put to three arms on a real FalkorDB, and
 * the held-out split is scored and written to data/eval/brain.json for the proof page.
 *   graph    the brain's standard procedure: planQuestion picks a graph tool, the tool's facts are the answer
 *   keyword  CONTAINS over every record's text (MTA records and the sample org), answer extracted from the top hits
 *   latest   the same graph tools, holding only the newest feed state (no resolved outages, alert archive or complaint history)
 *
 *   FALKORDB_URL=falkor://127.0.0.1:6380 tsx scripts/eval/brain-eval.ts
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planQuestion, runPlan } from "../../src/lib/agent/brain";
import { installFromSnapshot, loadSnapshot } from "../../src/lib/graph/agency";
import {
  ARM_LABEL,
  buildQuestions,
  EVAL_SEED,
  grade,
  score,
  TYPE_LABEL,
  type Arm,
  type BrainEvalReport,
  type EvalQuestion,
  type Grade,
  type QuestionType,
} from "../../src/lib/graph/agency-eval";
import { nyStamp, nyTime, parseMtaDate } from "../../src/lib/graph/agency-feeds";
import type { AgencyChangesData, AlertsData, ChainData, ComplaintsData, EquipmentData, LineOutagesData, ProjectData } from "../../src/lib/graph/agency-tools";
import { connect, copyGraph, deleteGraph, listGraphs, run } from "../../src/lib/graph/db";
import { TEMPLATE_GRAPH } from "../../src/lib/graph/names";
import { ensureOrgLayer } from "../../src/lib/graph/org";
import { ensureBaseGraphs } from "../../src/lib/graph/seed";
import { ORG_DECISIONS, ORG_PEOPLE } from "../../src/lib/graph/seed-org";
import { searchTerms, type TraceData } from "../../src/lib/graph/tools/brain";
import { Tracer } from "../../src/lib/graph/trace";
import type { ToolContext, ToolResult } from "../../src/lib/graph/tools/types";
import { loadNetwork } from "../../src/lib/network/data";

const AGENCY = "detour:agency-eval";
const SANDBOX = "detour:brain-eval";
const OUT = join(process.cwd(), "data", "eval", "brain.json");

const ctx = (): ToolContext => ({ visitorId: "brainevalx001", sandbox: SANDBOX, agentId: "brain", tracer: new Tracer() });
const uniq = (xs: string[]) => [...new Set(xs)];

// ---------------------------------------------------------------- the graph arms

/** The answer a tool's facts give to a question of this type; null is a refusal. */
function fromTool(q: EvalQuestion, r: ToolResult<unknown>): string[] | null {
  if (r.outcome !== "answered") return null;
  const unitOf = (d: EquipmentData) => d.units.find((u) => q.question.includes(u.id)) ?? null;
  switch (q.type) {
    case "status":
    case "return_time":
    case "alternative":
    case "maintainer": {
      if (r.tool !== "equipment_status") return null;
      const u = unitOf(r.data as EquipmentData);
      if (!u) return null;
      if (q.type === "status") return [u.state];
      if (q.type === "return_time") return u.current?.estReturnMs ? [nyStamp(u.current.estReturnMs)] : null;
      if (q.type === "alternative") return u.altRoute ? [u.altRoute] : null;
      return u.maintainedBy ? [u.maintainedBy] : null;
    }
    case "alert_lines":
    case "alert_stations":
    case "alert_outages": {
      if (r.tool !== "alerts_for") return null;
      const a = (r.data as AlertsData).alerts[0];
      if (!a) return null;
      if (q.type === "alert_outages") return a.stations.filter((s) => s.out.length).map((s) => s.id);
      return q.type === "alert_lines" ? a.routes : a.stations.map((s) => s.id);
    }
    case "station_outages":
      return r.tool === "equipment_status" && (r.data as EquipmentData).station ? (r.data as EquipmentData).units.filter((u) => u.state === "out of service").map((u) => u.id) : null;
    case "line_outages":
      return r.tool === "line_outages" ? uniq((r.data as LineOutagesData).stations.map((s) => s.id ?? s.name)) : null;
    case "outages_since":
      return r.tool === "agency_changes" ? uniq((r.data as AgencyChangesData).opened.map((o) => o.equipment)) : null;
    case "resolved_since":
      return r.tool === "agency_changes" ? uniq((r.data as AgencyChangesData).resolved.map((o) => o.equipment)) : null;
    case "project_stage":
      return r.tool === "project_trace" && (r.data as ProjectData).project?.stage ? [(r.data as ProjectData).project!.stage!] : null;
    case "milestone_date": {
      if (r.tool !== "project_trace") return null;
      const title = q.question.match(/"([^"]+)"/)?.[1]?.toLowerCase() ?? "";
      const hits = (r.data as ProjectData).milestones.filter((m) => m.title?.toLowerCase() === title && m.atMs);
      return hits.length ? uniq(hits.map((m) => nyStamp(m.atMs!).slice(0, 10))) : null;
    }
    case "complaints":
      return r.tool === "complaints_at" ? [String((r.data as ComplaintsData).total)] : null;
    case "chain_count":
      return r.tool === "notice_chain" ? [String((r.data as ChainData).updates.length)] : null;
    case "chain_last": {
      const u = r.tool === "notice_chain" ? (r.data as ChainData).updates : [];
      return u.length ? [u[u.length - 1].header] : null;
    }
    case "decision_basis":
      return r.tool === "trace_decision" && (r.data as TraceData).decision ? (r.data as TraceData).basedOn : null;
    case "decision_by":
      return r.tool === "trace_decision" && (r.data as TraceData).decision?.by ? [(r.data as TraceData).decision!.by!] : null;
  }
}

async function graphArm(q: EvalQuestion, now: number, latestOnly: boolean): Promise<string[] | null> {
  const plan = planQuestion(q.question, now);
  const r = await runPlan(ctx(), plan, { graph: AGENCY, latestOnly, now });
  return fromTool(q, r as ToolResult<unknown>);
}

// ---------------------------------------------------------------- the keyword arm

type Hit = { id: string; text: string; score: number };

/** Identifiers a question names; a hit must contain one of them to count. */
function idsIn(question: string): string[] {
  const out: string[] = [];
  for (const m of question.matchAll(/\b(E[LS]\d{2,4}[A-Z]?|lmm:[a-z_]+:\d+|DEC-[A-Z0-9-]+)\b/gi)) out.push(m[1].toLowerCase());
  const ev = question.match(/\bevent (\d+)/i);
  if (ev) out.push(ev[1]);
  const pr = question.match(/\bproject (\d+)/i);
  if (pr) out.push(`project ${pr[1]}`);
  return out;
}

async function keywordHits(question: string): Promise<Hit[]> {
  const ids = idsIn(question);
  const terms = uniq([...ids, ...searchTerms(question)]);
  if (!terms.length) return [];
  const agency = await run<Hit>(
    AGENCY,
    `MATCH (n) WHERE n:Record OR n:Notice
     WITH n, coalesce(n.text, n.header, '') AS text
     WITH n, text, toLower(n.id + ' ' + text) AS hay
     WITH n, text, hay, size([w IN $terms WHERE hay CONTAINS w]) AS score
     WHERE score > 0 AND (size($ids) = 0 OR any(i IN $ids WHERE hay CONTAINS i))
     RETURN n.id AS id, text, score ORDER BY score DESC LIMIT 12`,
    { terms, ids },
    { readOnly: true, timeoutMs: 30_000 },
  );
  const org = await run<Hit>(
    SANDBOX,
    `MATCH (x) WHERE x:Document OR x:Ticket OR x:Message OR x:Decision
     WITH x, coalesce(x.title, '') + ' ' + coalesce(x.text, '') + ' ' + coalesce(x.rationale, '') AS text
     WITH x, text, toLower(x.id + ' ' + text) AS hay
     WITH x, text, hay, size([w IN $terms WHERE hay CONTAINS w]) AS score
     WHERE score > 0 AND (size($ids) = 0 OR any(i IN $ids WHERE hay CONTAINS i))
     RETURN x.id AS id, text, score ORDER BY score DESC LIMIT 6`,
    { terms, ids },
    { readOnly: true },
  );
  return [...agency.rows, ...org.rows].sort((a, b) => b.score - a.score).slice(0, 12);
}

/** Extracts an answer of the question's type from the top hits' text, the way a retrieval pipeline would. */
function extract(q: EvalQuestion, hits: Hit[], stationByName: Map<string, string>): string[] | null {
  if (!hits.length) return null;
  // The keyword arm is handed the question's parameters (unit, station, line, time) from its generated wording.
  const unit = q.canonical.match(/\b(E[LS]\d{2,4}[A-Z]?)\b/)?.[1] ?? "";
  const since = q.canonical.match(/since (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1] ?? null;
  const mtaStamp = (text: string) => {
    const ms = parseMtaDate(text);
    return ms === null ? null : nyStamp(ms);
  };
  switch (q.type) {
    case "status": {
      const mine = hits.filter((h) => h.id.startsWith(unit));
      if (!mine.length) return null;
      return [mine.some((h) => h.id.includes("@") && h.text.startsWith("Outage of") && !h.text.includes("Left the feed")) ? "out of service" : "in service"];
    }
    case "return_time": {
      const h = hits.find((x) => x.id.startsWith(`${unit}@`) && x.text.startsWith("Outage of") && !x.text.includes("Left the feed"));
      const m = h?.text.match(/estimated return (\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M)/);
      const s = m ? mtaStamp(m[1]) : null;
      return s ? [s] : null;
    }
    case "alternative": {
      const h = hits.find((x) => x.id === `ALT-${unit}`);
      return h ? [h.text] : null;
    }
    case "maintainer": {
      const m = hits.find((x) => x.id === unit)?.text.match(/Maintained by ([^.]+)\./);
      return m ? [m[1]] : null;
    }
    case "alert_lines": {
      const m = hits[0].text.match(/^Alert \S+(?: \([^)]*\))? on ([^:]+):/);
      return m ? (m[1] === "no line" ? [] : m[1].split(/,\s*/)) : null;
    }
    case "alert_stations":
    case "alert_outages":
      // An alert's text names lines, not station ids, and says nothing of elevators.
      return null;
    case "station_outages": {
      const name = q.canonical.match(/ at (.+) are out of service/)?.[1] ?? "";
      const ids = hits.filter((h) => h.id.includes("@") && h.text.startsWith("Outage of") && !h.text.includes("Left the feed") && h.text.includes(` at ${name} (`)).map((h) => h.id.split("@")[0]);
      return hits.some((h) => h.text.includes(` at ${name}`)) ? uniq(ids) : null;
    }
    case "line_outages": {
      const route = q.canonical.match(/stations on the (\S+) have/)?.[1] ?? "";
      const ids: string[] = [];
      for (const h of hits) {
        const m = h.text.match(/^Outage of \S+ \S+ at (.+?) \(([^)]*)\)/);
        if (m && m[2].split("/").includes(route) && stationByName.has(m[1])) ids.push(stationByName.get(m[1])!);
      }
      return uniq(ids);
    }
    case "outages_since":
    case "resolved_since": {
      const t = since ? nyTime(+since.slice(0, 4), +since.slice(5, 7), +since.slice(8, 10), +since.slice(11, 13), +since.slice(14, 16)) : 0;
      const ids: string[] = [];
      for (const h of hits) {
        if (!h.id.includes("@")) continue;
        if (q.type === "outages_since") {
          const m = h.text.match(/since (\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M)/);
          const at = m ? parseMtaDate(m[1]) : null;
          if (at !== null && at >= t && h.text.startsWith("Outage of")) ids.push(h.id.split("@")[0]);
        } else {
          const m = h.text.match(/Left the feed \(resolved\) by (\S+?)\.?$/);
          if (m && Date.parse(m[1]) >= t) ids.push(h.id.split("@")[0]);
        }
      }
      return uniq(ids);
    }
    case "project_stage": {
      const m = hits.find((h) => h.id.startsWith("CP-") && !/-\d+-\d+$/.test(h.id))?.text.match(/Stage: ([^.]+)\./);
      return m ? [m[1]] : null;
    }
    case "milestone_date": {
      const title = q.canonical.match(/"([^"]+)"/)?.[1]?.toLowerCase() ?? "";
      const dates = hits.filter((h) => h.text.toLowerCase().includes(`: ${title} on `)).map((h) => h.text.match(/ on (\d{4}-\d{2}-\d{2})/)?.[1]).filter((d): d is string => Boolean(d));
      return dates.length ? uniq(dates) : null;
    }
    case "complaints": {
      const quarter = q.canonical.match(/in (\d{4} Q[1-4])/)?.[1] ?? "";
      const m = hits.find((h) => h.id.startsWith("CMP-") && h.text.includes(quarter))?.text.match(/^(\d+) rider complaint/);
      return m ? [m[1]] : null;
    }
    case "chain_count": {
      const m = hits.find((h) => h.id.startsWith("EV-"))?.text.match(/: (\d+) updates?/);
      return m ? [m[1]] : null;
    }
    case "chain_last": {
      const m = hits.find((h) => h.id.startsWith("EV-"))?.text.match(/Latest: ([\s\S]*)$/);
      return m ? [m[1]] : null;
    }
    case "decision_basis":
    case "decision_by":
      // The decision's text holds its title and rationale; what it rests on and who made it are edges, not words.
      return null;
  }
}

// ---------------------------------------------------------------- run

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const started = Date.now();
  const snap = await loadSnapshot();
  const network = await loadNetwork();
  const latestMs = snap.outageCaptures[snap.outageCaptures.length - 1].fetchedMs;
  const names = new Map(ORG_PEOPLE.map((p) => [p.id, p.name]));
  const questions = buildQuestions(
    snap,
    { stations: network.stations.map((s) => ({ id: s.id, name: s.name, routes: s.routes })), routes: network.routes.map((r) => r.id) },
    ORG_DECISIONS.map((d) => ({ id: d.id, basedOn: d.basedOn, by: names.get(d.decidedBy) ?? d.decidedBy })),
    EVAL_SEED,
  );
  const stationByName = new Map(snap.equipment.map((e) => [e.station, e.stationcomplexid]));
  console.log(`${questions.length} questions: ${questions.filter((q) => q.split === "heldout").length} held out, ${questions.filter((q) => q.gold === null).length} unanswerable`);

  // The agency graph from the snapshot, and a sandbox with the sample org for the decision questions.
  console.log(`agency graph: ${JSON.stringify(await installFromSnapshot(AGENCY))}`);
  if (!(await listGraphs()).includes(TEMPLATE_GRAPH)) await ensureBaseGraphs((m) => console.log(m));
  if ((await listGraphs()).includes(SANDBOX)) await deleteGraph(SANDBOX);
  await copyGraph(TEMPLATE_GRAPH, SANDBOX);
  await ensureOrgLayer(SANDBOX);

  const arms: Arm[] = ["graph", "keyword", "latest"];
  const answers = new Map<string, Record<Arm, string[] | null>>();
  const ms: Record<Arm, number> = { graph: 0, keyword: 0, latest: 0 };
  try {
    for (const [i, q] of questions.entries()) {
      const a = {} as Record<Arm, string[] | null>;
      for (const arm of arms) {
        const t = performance.now();
        try {
          a[arm] = arm === "keyword" ? extract(q, await keywordHits(q.question), stationByName) : await graphArm(q, latestMs, arm === "latest");
        } catch (error) {
          console.error(`${q.id} ${arm}: ${error instanceof Error ? error.message : error}`);
          a[arm] = null;
        }
        ms[arm] += performance.now() - t;
      }
      answers.set(q.id, a);
      if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${questions.length}`);
    }
  } finally {
    await deleteGraph(SANDBOX).catch(() => undefined);
    await deleteGraph(AGENCY).catch(() => undefined);
    await (await connect()).close();
  }

  const graded = (qs: EvalQuestion[], arm: Arm): Grade[] => qs.map((q) => grade(q.gold, answers.get(q.id)![arm]));
  const held = questions.filter((q) => q.split === "heldout");
  const dev = questions.filter((q) => q.split === "dev");
  const types = [...new Set(questions.map((q) => q.type))] as QuestionType[];
  const mean = (gs: Grade[], k: "em" | "f1") => (gs.length ? gs.reduce((s, g) => s + g[k], 0) / gs.length : 0);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const roundScore = (s: ReturnType<typeof score>) => ({
    em: { mean: round(s.em.mean), lo: round(s.em.lo), hi: round(s.em.hi), n: s.em.n },
    f1: { mean: round(s.f1.mean), lo: round(s.f1.lo), hi: round(s.f1.hi), n: s.f1.n },
    refusals: { mean: round(s.refusals.mean), n: s.refusals.n },
    falseRefusals: { mean: round(s.falseRefusals.mean), n: s.falseRefusals.n },
  });

  const report: BrainEvalReport = {
    generatedMs: Date.now(),
    seed: EVAL_SEED,
    snapshot: { fetched: snap.fetched as Record<string, number>, outageCaptures: snap.outageCaptures.map((c) => c.fetchedMs) },
    questions: {
      total: questions.length,
      dev: dev.length,
      heldout: held.length,
      unanswerable: questions.filter((q) => q.gold === null).length,
      heldoutUnanswerable: held.filter((q) => q.gold === null).length,
    },
    arms,
    overall: Object.fromEntries(arms.map((arm) => [arm, roundScore(score(graded(held, arm)))])) as BrainEvalReport["overall"],
    byType: types.map((type) => {
      const qs = held.filter((q) => q.type === type);
      return {
        type,
        label: TYPE_LABEL[type],
        n: qs.length,
        unanswerable: qs.filter((q) => q.gold === null).length,
        arms: Object.fromEntries(arms.map((arm) => [arm, { em: round(mean(graded(qs, arm), "em")), f1: round(mean(graded(qs, arm), "f1")) }])) as Record<Arm, { em: number; f1: number }>,
      };
    }),
    dev: Object.fromEntries(arms.map((arm) => [arm, { em: round(mean(graded(dev, arm), "em")), f1: round(mean(graded(dev, arm), "f1")), n: dev.length }])) as BrainEvalReport["dev"],
    heldout: held.map((q) => {
      const a = answers.get(q.id)!;
      return { id: q.id, type: q.type, question: q.question, gold: q.gold, answers: a, em: Object.fromEntries(arms.map((arm) => [arm, grade(q.gold, a[arm]).em])) as Record<Arm, number> };
    }),
    ms: Object.fromEntries(arms.map((arm) => [arm, Math.round(ms[arm])])) as Record<Arm, number>,
  };
  mkdirSync(join(process.cwd(), "data", "eval"), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);

  // Only the dev split's misses are printed: they are what the brain's tools may be tuned on.
  const misses = dev.filter((q) => grade(q.gold, answers.get(q.id)!.graph).em === 0);
  console.log(`\ndev misses (graph tools): ${misses.length} of ${dev.length}`);
  for (const q of misses.slice(0, 40)) console.log(`  ${q.type} | ${q.question} | gold ${JSON.stringify(q.gold)} | got ${JSON.stringify(answers.get(q.id)!.graph)}`);

  console.log(`\nheld out: ${held.length} questions (${report.questions.heldoutUnanswerable} unanswerable)`);
  for (const arm of arms) {
    const s = report.overall[arm];
    console.log(
      `${ARM_LABEL[arm].padEnd(22)} EM ${(s.em.mean * 100).toFixed(1)} [${(s.em.lo * 100).toFixed(1)}, ${(s.em.hi * 100).toFixed(1)}]  F1 ${(s.f1.mean * 100).toFixed(1)}  refusals ${(s.refusals.mean * 100).toFixed(1)}%  false refusals ${(s.falseRefusals.mean * 100).toFixed(1)}%  ${(ms[arm] / questions.length).toFixed(0)} ms/q`,
    );
  }
  for (const t of report.byType) console.log(`  ${t.label.padEnd(44)} n=${String(t.n).padStart(3)}  ${arms.map((arm) => `${arm} ${(t.arms[arm].em * 100).toFixed(0)}`).join("  ")}`);
  console.log(`wrote ${OUT} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
