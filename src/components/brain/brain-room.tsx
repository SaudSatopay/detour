"use client";

import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AgencyRefreshReply,
  AgencySummary,
  BrainAnswer,
  BrainDirectory,
  BrainIntake,
  BrainOwned,
  BrainPerson,
  BrainSource,
  BrainStep,
  BrainTeam,
  BrainTurn,
  IntakeKind,
  SourceKind,
} from "@/lib/brain/types";
import type { CypherTrace } from "@/lib/graph/trace";
import { readable } from "@/lib/readable";
import { TOOL_TITLE } from "@/lib/tool-titles";
import { CypherBlock } from "../cypher-block";
import { fmt, OutcomeChip, RouteTag, Stat } from "../control/bits";
import { agentName } from "../control/trace";

type Colors = Record<string, string>;

/** The API's limits on a question. */
const MIN = 2;
const MAX = 400;

const KIND: Record<SourceKind, string> = {
  document: "Document",
  ticket: "Ticket",
  message: "Chat",
  decision: "Decision",
  finding: "Finding",
  playbook: "Playbook",
  equipment: "Unit",
  asset: "Asset inventory",
  outage: "Outage",
  alert: "Alert",
  notice: "Alert update",
  complaints: "Complaints",
  project: "Capital project",
  milestone: "Milestone",
  alternative: "Alternative route",
};
const BY: Record<SourceKind, string> = {
  document: "Written by",
  ticket: "Filed by",
  message: "Posted by",
  decision: "Decided by",
  finding: "Written by",
  playbook: "Written by",
  equipment: "Published by",
  asset: "Published by",
  outage: "Published by",
  alert: "Published by",
  notice: "Published by",
  complaints: "Published by",
  project: "Published by",
  milestone: "Published by",
  alternative: "Published by",
};
/** The brain's tools over the MTA's records, named for the trace beside the shared titles. */
const TITLES: Record<string, string> = {
  ...TOOL_TITLE,
  equipment_status: "Elevator and escalator status",
  line_outages: "Outages along a line",
  alerts_for: "Service alerts",
  notice_chain: "An alert's updates",
  agency_changes: "What changed at the MTA",
  project_trace: "Trace a capital project",
  complaints_at: "Rider complaints",
  agency_search: "Search MTA records",
};
const OUTCOMES = new Set<string>(["answered", "memory", "not_in_graph", "unknown_entity"]);

// Dated in the subway's time zone, as the memory page dates facts.
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
// In a byline the date never breaks across lines.
const dayKept = (ms: number) => day(ms).replace(/ /g, "\u00a0");
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const motion = (): ScrollBehavior => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
const sourceId = (n: number) => `brain-source-${n}`;
const kindOf = (kind: string) => KIND[kind as SourceKind] ?? kind;

/** "Filed by Dana Ortiz · Elevators · Oct 12, 2026": who, which team, when, skipping what is unknown. */
function byline(s: BrainSource) {
  const who = s.by ? `${BY[s.kind] ?? "By"} ${s.kind === "finding" ? agentName(s.by) : s.by}` : null;
  return [who, s.team, s.atMs ? dayKept(s.atMs) : null].filter(Boolean).join(" · ");
}

// A moment in the subway's time zone, for "as of" times and receipts.
const moment = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";

/** Real MTA record, sample org record, or the visitor's own: said in words, not by color alone. */
function OriginTag({ origin }: { origin: BrainSource["origin"] }) {
  if (origin === "mta") {
    return <span className="label inline-flex items-center rounded-sm border border-signal bg-signal-wash px-1.5 text-ink-900">MTA record</span>;
  }
  if (origin === "visitor") return <span className="label inline-flex items-center rounded-sm border border-line-strong px-1.5 text-ink-700">Yours</span>;
  return <span className="label inline-flex items-center rounded-sm border border-dashed border-line-strong px-1.5 text-ink-500">Sample</span>;
}

/** The record's own words as published, where, and when Detour read them. */
function ReceiptBlock({ s }: { s: BrainSource }) {
  const r = s.receipt;
  if (!r) return null;
  return (
    <figure className="flex min-w-0 flex-col gap-1 rounded-sm border-l-2 border-signal bg-sunk/60 px-2.5 py-1.5">
      <blockquote className="line-clamp-4 break-words font-mono text-xs leading-relaxed text-ink-900">{r.quote}</blockquote>
      <figcaption className="flex flex-wrap gap-x-2 text-xs text-ink-500">
        <a href={r.url} target="_blank" rel="noreferrer" className="break-all underline decoration-line-strong underline-offset-2 hover:text-ink-900">
          {r.source}
        </a>
        {r.fetchedMs ? <span>fetched {moment(r.fetchedMs)}</span> : null}
        {r.hash ? <span className="font-mono">sha1 {r.hash.slice(0, 8)}</span> : null}
      </figcaption>
    </figure>
  );
}

type Got<T> = { ok: true; data: T } | { ok: false; error: string };

/** One JSON call. Every failure comes back as a sentence to show, never a throw. */
async function call<T>(url: string, init?: RequestInit): Promise<Got<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    return { ok: false, error: "The server did not answer. Check your connection and try again." };
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (typeof body?.error === "string") return { ok: false, error: body.error };
  if (res.status === 504) return { ok: false, error: "The answer took too long to come back. Try again." };
  if (!res.ok) return { ok: false, error: `The server answered ${res.status}.` };
  if (!body) return { ok: false, error: "The server's reply could not be read. Try again." };
  return { ok: true, data: body };
}

// The contract is typed, but a list the server leaves out renders as empty rather than breaking the page.
const list = <T,>(x: unknown): T[] => (Array.isArray(x) ? x : []);
const toSource = (s: BrainSource): BrainSource => ({ ...s, about: list<string>(s.about) });

const NO_COUNTS: BrainDirectory["counts"] = { people: 0, teams: 0, documents: 0, tickets: 0, messages: 0, decisions: 0 };

function toDirectory(d: BrainDirectory): BrainDirectory {
  return {
    counts: { ...NO_COUNTS, ...d.counts },
    teams: list<BrainTeam>(d.teams).map((t) => ({ ...t, people: list<BrainPerson>(t.people), owns: list<BrainOwned>(t.owns) })),
    openTickets: list<BrainSource>(d.openTickets).map(toSource),
    decisions: list<BrainSource>(d.decisions).map(toSource),
    suggestions: list<string>(d.suggestions).filter((s) => typeof s === "string" && s.trim().length >= MIN),
    history: list<BrainTurn>(d.history).map((t) => ({ ...t, cites: list<string>(t.cites) })),
    agency: toAgency(d.agency),
    recorded: d.recorded && typeof d.recorded.at === "string" ? { at: d.recorded.at } : null,
  };
}

function toAgency(a: AgencySummary | null | undefined): AgencySummary | null {
  if (!a || typeof a !== "object" || !a.counts || !a.asOf) return null;
  return { ...a, sources: list<AgencySummary["sources"][number]>(a.sources), outages: list<BrainSource>(a.outages).map(toSource) };
}

function toAnswer(a: BrainAnswer, asked: string): BrainAnswer {
  return {
    ...a,
    question: a.question || asked,
    answer: typeof a.answer === "string" ? a.answer : "",
    sources: list<BrainSource>(a.sources).map(toSource),
    steps: list<BrainStep>(a.steps).map((s) => ({ ...s, trace: list<CypherTrace>(s.trace) })),
  };
}

/** The day something was recorded on the deployment. */
const recordedDay = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "earlier";

// The visitor's own turns are shown in their own time zone.
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const withoutCites = (text: string) => text.replace(/\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, "");

/** Earlier questions and answers, read back from Turn nodes in the visitor's graph. Picking one asks it again. */
function History({ turns, pending, onAsk }: { turns: BrainTurn[]; pending: boolean; onAsk: (q: string) => void }) {
  if (!turns.length) return null;
  return (
    <section aria-labelledby="brain-history" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="brain-history" className="font-display text-2xl font-bold">
          Your conversation, remembered
        </h2>
        <p className="max-w-prose text-sm text-ink-700">
          Each question and answer is a Turn node in your graph, chained in order and linked to the nodes it cited. The brain reads them back as
          context, so they are still here when you come back.
        </p>
      </div>
      <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
        {turns.map((t) => (
          <li key={t.id} className="flex flex-col gap-1 px-3 py-2.5">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="break-all font-mono text-xs text-ink-500">{t.id}</span>
              <span className="tabular ml-auto font-mono text-xs text-ink-500">
                {when(t.atMs)}
                {t.cites.length ? ` · ${count(t.cites.length, "source")}` : ""}
              </span>
            </span>
            <button
              type="button"
              onClick={() => {
                if (!pending) onAsk(t.question);
              }}
              aria-disabled={pending}
              className={`w-fit max-w-full break-words rounded-sm text-left text-sm font-semibold text-ink-900 underline-offset-2 ${pending ? "cursor-not-allowed opacity-60" : "hover:underline"}`}
            >
              {t.question}
            </button>
            <p className="line-clamp-2 break-words text-sm text-ink-700">{withoutCites(t.answer)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

const INTAKE_KINDS: { kind: IntakeKind; label: string }[] = [
  { kind: "message", label: "Chat message" },
  { kind: "ticket", label: "Ticket" },
  { kind: "note", label: "Note" },
];

const INTAKE_EXAMPLES: { label: string; kind: IntakeKind; text: string }[] = [
  {
    label: "Example: an outage",
    kind: "message",
    text: "Elevator to the A platform at Jay St-MetroTech is stuck between floors. Sending step-free riders to Borough Hall for now.",
  },
  { label: "Example: a fix", kind: "message", text: "Myrtle-Wyckoff L platform elevator is back in service: the motor controller was replaced." },
];

type IntakeState = { status: "idle" } | { status: "pending" } | { status: "done"; data: BrainIntake } | { status: "error"; error: string };

/** Adds a chat message, ticket or note to the brain, and shows what it was linked to and what work it created. */
function Intake({ colors, onAdded, onAskChanged, offline }: { colors: Colors; onAdded: () => void; onAskChanged: () => void; offline: boolean }) {
  const [kind, setKind] = useState<IntakeKind>("message");
  const [text, setText] = useState("");
  const [state, setState] = useState<IntakeState>({ status: "idle" });
  const pending = state.status === "pending";
  const blocked = pending || offline || text.trim().length < 8;
  const submit = async () => {
    if (blocked) return;
    setState({ status: "pending" });
    const res = await call<BrainIntake>("/api/brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intake: { kind, text: text.trim() } }),
    });
    if (!res.ok) {
      setState({ status: "error", error: res.error });
      return;
    }
    setState({ status: "done", data: { ...res.data, sources: list<BrainSource>(res.data.sources).map(toSource) } });
    onAdded();
  };
  return (
    <section aria-labelledby="brain-intake" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="brain-intake" className="font-display text-2xl font-bold">
          Add to the brain
        </h2>
        <p className="max-w-prose text-sm text-ink-700">
          Paste a chat message, a ticket or a note. The brain links it to the stations, lines and people it names. An elevator outage files a
          ticket with the team that maintains it and goes into memory, so step-free routes change; a fix resolves the ticket.
        </p>
        {offline ? <p className="max-w-prose text-sm font-semibold text-ink-900">Adding needs the live graph database, which is unreachable right now.</p> : null}
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <legend className="label mb-2 text-ink-500">It is a</legend>
          {INTAKE_KINDS.map((k) => (
            <label key={k.kind} className="flex cursor-pointer items-center gap-2 text-sm text-ink-900">
              <input type="radio" name="brain-intake-kind" value={k.kind} checked={kind === k.kind} onChange={() => setKind(k.kind)} className="accent-current" />
              {k.label}
            </label>
          ))}
        </fieldset>
        <label htmlFor="brain-intake-text" className="label text-ink-500">
          Text
        </label>
        <textarea
          id="brain-intake-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={1200}
          placeholder="Elevator to the A platform at Jay St-MetroTech is stuck between floors…"
          className="resize-y rounded-md border border-line bg-panel px-3 py-2 text-base text-ink-900 placeholder:text-ink-500 focus:border-signal"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            aria-disabled={blocked}
            className={`shrink-0 whitespace-nowrap rounded-md bg-ink-900 px-4 py-2 font-display text-lg font-semibold tracking-wide text-paper transition-transform duration-150 ease-out ${
              blocked ? "cursor-not-allowed opacity-50" : "hover:-translate-y-px"
            }`}
          >
            {pending ? "Adding…" : "Add to the brain"}
          </button>
          {INTAKE_EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              onClick={() => {
                setKind(ex.kind);
                setText(ex.text);
              }}
              className="rounded-md border border-line bg-panel px-3 py-1.5 text-left text-sm text-ink-700 transition-colors duration-150 hover:border-line-strong hover:text-ink-900"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </form>
      <div aria-live="polite">
        {state.status === "error" ? (
          <p className="rounded-md border border-crit bg-crit-wash px-3 py-2 text-sm text-ink-900">
            <span className="label mr-2 text-crit">Could not add it</span>
            {state.error}
          </p>
        ) : state.status === "done" ? (
          <div className="flex flex-col gap-3 rounded-md border border-line bg-panel p-4">
            <p className="break-words text-base text-ink-900">{state.data.summary}</p>
            {state.data.sources.length ? (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                {state.data.sources.map((s) => (
                  <li key={s.id} className="flex flex-col gap-1 px-3 py-2.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <OriginTag origin={s.origin} />
                      <span className="label text-ink-500">{kindOf(s.kind)}</span>
                      <span className="break-all font-mono text-xs text-ink-500">{s.id}</span>
                      <StatusPill status={s.status} className="ml-auto" />
                    </span>
                    <span className="break-words text-sm text-ink-900">{s.title}</span>
                    {byline(s) ? <span className="text-xs text-ink-500">{byline(s)}</span> : null}
                    <About labels={s.about} colors={colors} />
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              onClick={onAskChanged}
              className="w-fit rounded-md border border-ink-900 px-3 py-1.5 font-display text-base font-semibold text-ink-900 transition-colors duration-150 hover:bg-sunk"
            >
              Ask what changed today
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Open tickets and current findings call for attention; closed ones step back; a decision in force reads plainly. */
function StatusPill({ status, className = "" }: { status: string | null; className?: string }) {
  if (!status) return null;
  const s = status.toLowerCase();
  const attention = s === "open" || s === "current";
  const tone = attention ? "border-warn bg-warn-wash text-ink-900" : ["resolved", "closed", "superseded"].includes(s) ? "border-line bg-sunk text-ink-500" : "border-line-strong text-ink-900";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 font-display text-xs font-semibold uppercase leading-5 tracking-[0.06em] ${tone} ${className}`}>
      {attention ? <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" /> : null}
      {status}
    </span>
  );
}

/** A route as the app tags routes everywhere (its GTFS color as a bar); a station or anything else as a plain chip. */
const colorOf = (colors: Colors, ...keys: string[]) => keys.map((k) => (Object.hasOwn(colors, k) ? colors[k] : undefined)).find(Boolean);

function Place({ label, colors }: { label: string; colors: Colors }) {
  const hex = colorOf(colors, label);
  if (hex) return <RouteTag route={label} color={hex} />;
  return <span className="inline-flex items-center rounded-sm border border-line bg-sunk px-1.5 text-xs leading-5 text-ink-700">{label}</span>;
}

function About({ labels, colors }: { labels: string[]; colors: Colors }) {
  if (!labels.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="About">
      {labels.map((l, i) => (
        <li key={`${i}${l}`}>
          <Place label={l} colors={colors} />
        </li>
      ))}
    </ul>
  );
}

/** A route or a station a team owns, as a chip. Playbooks have long titles, so they get a line of their own. */
function Owned({ o, colors }: { o: BrainOwned; colors: Colors }) {
  if (o.kind === "route") return <RouteTag route={o.label} color={colorOf(colors, o.id, o.label)} />;
  return <Place label={o.label} colors={{}} />;
}

// One citation group: "[2]", "[1, 3]" or "[3][4]".
const CITES = /\[\d{1,3}(?:\s*,\s*\d{1,3})*\](?:[ \t]*\[\d{1,3}(?:\s*,\s*\d{1,3})*\])*/g;

/** The answer's [n] markers as superscript buttons that jump to source n; a group naming a source past the list stays text. */
function cited(text: string, sources: BrainSource[], onCite: (n: number) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CITES)) {
    const nums = [...new Set((m[0].match(/\d+/g) ?? []).map(Number))];
    if (!nums.every((n) => n >= 1 && n <= sources.length)) continue;
    const at = m.index ?? 0;
    const end = at + m[0].length;
    // The markers sit against the word they support, and never start a line alone or leave its full stop to the next.
    const before = text.slice(last, at).replace(/[ \t]+$/, "");
    const word = /\S*$/.exec(before)?.[0] ?? "";
    const stop = /^[.,;:!?)\]"”’]*/.exec(text.slice(end))?.[0] ?? "";
    out.push(before.slice(0, before.length - word.length));
    out.push(
      <span key={at} className="whitespace-nowrap">
        {word}
        <sup>
          {nums.map((n, i) => {
            const s = sources[n - 1];
            return (
              <Fragment key={n}>
                {i ? <span aria-hidden="true">,</span> : null}
                <button
                  type="button"
                  onClick={() => onCite(n)}
                  aria-label={`Source ${n}`}
                  title={`${kindOf(s.kind)} ${s.id}: ${s.title}`}
                  className="tabular rounded-sm px-px py-px font-mono font-semibold leading-none text-signal-strong transition-colors duration-150 hover:bg-signal-wash hover:text-ink-900"
                >
                  {n}
                </button>
              </Fragment>
            );
          })}
        </sup>
        {stop}
      </span>,
    );
    last = end + stop.length;
  }
  out.push(text.slice(last));
  return out;
}

function AnswerText({ text, sources, onCite }: { text: string; sources: BrainSource[]; onCite: (n: number) => void }) {
  // Plain text by contract; stray markdown bold is dropped, as the trace does.
  const paras = text
    .replace(/\*\*/g, "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) return <p className="text-sm text-ink-500">No answer text came back. The sources below are what the graph found.</p>;
  return (
    <div className="flex max-w-prose flex-col gap-3">
      {paras.map((p, i) => (
        <p key={i} className="whitespace-pre-line break-words text-ink-900">
          {cited(p, sources, onCite)}
        </p>
      ))}
    </div>
  );
}

function ModeBadge({ answer }: { answer: BrainAnswer }) {
  const live = answer.mode === "live";
  return (
    <span className={`label inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 ${live ? "bg-signal-strong text-signal-ink" : "border border-warn bg-warn-wash text-ink-900"}`}>
      {live ? <span aria-hidden="true" className="size-1.5 rounded-full bg-signal-ink" /> : null}
      {live ? `Live · ${answer.model?.split(":").pop() || "model"}` : answer.mode === "recorded" ? `Recorded · ${recordedDay(answer.recordedAt)}` : "Scripted · no model"}
    </span>
  );
}

function SourceItem({ s, n, lit, colors }: { s: BrainSource; n: number; lit: boolean; colors: Colors }) {
  const meta = byline(s);
  return (
    <li
      id={sourceId(n)}
      tabIndex={-1}
      className={`flex scroll-mt-20 gap-3 rounded-md border bg-panel p-3 transition ${lit ? "border-signal shadow-lift ring-1 ring-signal duration-150" : "border-line duration-700"}`}
    >
      <span className="tabular w-5 shrink-0 font-mono text-sm font-semibold leading-6 text-ink-500">{n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <OriginTag origin={s.origin} />
          <span className="label rounded-sm bg-sunk px-1.5 text-ink-700">{kindOf(s.kind)}</span>
          <span className="break-all font-mono text-xs text-ink-500">{s.id}</span>
          <StatusPill status={s.status} className="ml-auto" />
        </div>
        <p className="break-words text-sm font-semibold text-ink-900">{s.title}</p>
        {meta ? <p className="text-xs text-ink-500">{meta}</p> : null}
        {s.snippet ? <p className="line-clamp-3 break-words text-sm text-ink-700">{s.snippet}</p> : null}
        <ReceiptBlock s={s} />
        <About labels={s.about} colors={colors} />
      </div>
    </li>
  );
}

/** Every graph tool call behind the answer, with the Cypher it ran. */
function Steps({ steps }: { steps: BrainStep[] }) {
  const queries = steps.reduce((n, s) => n + s.trace.length, 0);
  return (
    <details className="group rounded-md border border-line bg-panel">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-3 hover:bg-sunk/60">
        <span aria-hidden="true" className="inline-block text-ink-500 transition-transform duration-150 group-open:rotate-90">
          ›
        </span>
        <span className="font-display text-lg font-semibold">How it was answered</span>
        <span className="tabular ml-auto font-mono text-xs text-ink-500">
          {count(steps.length, "step")} · {count(queries, "query", "queries")}
        </span>
      </summary>
      <ol className="flex flex-col gap-5 border-t border-line px-4 py-4">
        {steps.map((s, i) => {
          const title = TITLES[s.tool];
          return (
            <li key={i} className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular font-mono text-xs text-ink-500">{String(i + 1).padStart(2, "0")}</span>
                {title ? (
                  <span className="font-display text-base font-semibold leading-tight text-ink-900">{title}</span>
                ) : (
                  <code className="break-all font-mono text-sm font-semibold text-ink-900">{s.tool}</code>
                )}
                {OUTCOMES.has(s.outcome) ? <OutcomeChip outcome={s.outcome} /> : <span className="label text-ink-500">{String(s.outcome)}</span>}
                {title ? <code className="ml-auto truncate font-mono text-xs text-ink-500">{s.tool}</code> : null}
              </div>
              {s.summary ? <p className="break-words text-sm leading-relaxed text-ink-700">{readable(s.summary)}</p> : null}
              {s.trace.map((t, j) => (
                <div key={j} className="min-w-0">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
                    <span className="font-semibold text-ink-900">{t.label}</span>
                    <span className="tabular font-mono">
                      {t.ms} ms · {count(t.rows, "row")}
                    </span>
                  </p>
                  <CypherBlock code={t.cypher} className="mt-1" />
                </div>
              ))}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/** Mounted per question, so its clock starts at zero each time. */
function Pending({ question }: { question: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-sm text-ink-700">
        <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-signal" />
        Reading the graph…
        {/* Hidden from screen readers, so the live region does not announce every second. */}
        <span aria-hidden="true" className="tabular ml-auto font-mono text-xs text-ink-500">
          {secs} s
        </span>
      </p>
      <h3 className="break-words font-display text-xl font-semibold leading-tight">{question}</h3>
      <p className="text-sm text-ink-500">The brain picks graph tools and cites the nodes they return. With a live model this can take up to 30 seconds.</p>
      <div aria-hidden="true" className="flex max-w-prose flex-col gap-2 pt-1">
        <span className="h-3 w-full animate-pulse rounded-sm bg-sunk" />
        <span className="h-3 w-11/12 animate-pulse rounded-sm bg-sunk" />
        <span className="h-3 w-2/3 animate-pulse rounded-sm bg-sunk" />
      </div>
    </div>
  );
}

/**
 * ?q asks on arrival, and again whenever the palette links here with another question. A leaf inside Suspense,
 * since search params are only known in the browser: the rest of the page stays prerendered.
 */
function AskFromUrl({ onAsk }: { onAsk: (q: string) => void }) {
  const q = useSearchParams().get("q")?.trim().slice(0, MAX) ?? "";
  useEffect(() => {
    if (q.length < MIN) return;
    // Deferred, so a Strict Mode remount cancels the timer instead of asking twice.
    const timer = setTimeout(() => onAsk(q), 0);
    return () => clearTimeout(timer);
  }, [q, onAsk]);
  return null;
}

function TeamItem({ t, colors }: { t: BrainTeam; colors: Colors }) {
  const places = t.owns.filter((o) => o.kind !== "playbook");
  const playbooks = t.owns.filter((o) => o.kind === "playbook");
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-panel p-3">
      <div className="flex flex-col gap-0.5">
        <h4 className="font-display text-lg font-semibold leading-tight">{t.name}</h4>
        {t.mission ? <p className="text-sm text-ink-700">{t.mission}</p> : null}
      </div>
      {t.people.length ? (
        <ul className="flex flex-col gap-0.5 text-sm" aria-label={`People on ${t.name}`}>
          {t.people.map((p) => (
            <li key={p.id}>
              <span className="text-ink-900">{p.name}</span>
              <span className="text-ink-500">, {p.role}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {places.length ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="label text-ink-500">Owns</span>
          <ul className="flex flex-wrap gap-1.5" aria-label={`${t.name} owns`}>
            {places.map((o) => (
              <li key={`${o.kind}${o.id}`}>
                <Owned o={o} colors={colors} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {playbooks.length ? (
        <ul className="flex flex-col gap-1" aria-label={`${t.name} playbooks`}>
          {playbooks.map((o) => (
            <li key={o.id} className="flex items-baseline gap-2 text-sm text-ink-700">
              <span className="label shrink-0 text-ink-500">Playbook</span>
              <span className="min-w-0">{o.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

type Refresh = { status: "idle" } | { status: "pending" } | { status: "done"; text: string } | { status: "error"; error: string };

/**
 * The shared graph of real MTA records: as of when each source was read, what it holds, the newest outages, and a
 * control to read the live feeds again now.
 */
function AgencyPanel({ agency, colors, onRefreshed, offline }: { agency: AgencySummary | null; colors: Colors; onRefreshed: (a: AgencySummary) => void; offline: boolean }) {
  const [state, setState] = useState<Refresh>({ status: "idle" });
  const pending = state.status === "pending";
  const refresh = async () => {
    if (pending) return;
    setState({ status: "pending" });
    const res = await call<AgencyRefreshReply>("/api/brain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh: true }) });
    if (!res.ok) {
      setState({ status: "error", error: res.error });
      return;
    }
    const r = res.data;
    const fresh = toAgency(r.agency);
    if (fresh) onRefreshed(fresh);
    setState({
      status: "done",
      text:
        r.from === "skipped"
          ? "Another refresh was already running; the records shown are from it."
          : `Read the MTA's live feeds in ${took(r.ms)}: ${count(r.opened, "new outage")}, ${count(r.resolved, "outage")} resolved, ${count(r.alertsStarted, "new alert")}.`,
    });
  };
  if (!agency) {
    return (
      <section aria-labelledby="brain-mta" className="flex flex-col gap-2 rounded-md border border-dashed border-line-strong p-4">
        <h3 id="brain-mta" className="font-display text-xl font-semibold">
          Real MTA records
        </h3>
        <p className="text-sm text-ink-700">The shared graph of the MTA&apos;s elevator, outage and alert records could not be read just now. Questions about them will say so.</p>
      </section>
    );
  }
  const c = agency.counts;
  const asOf = agency.asOf.outagesMs ?? agency.asOf.alertsMs;
  return (
    <section aria-labelledby="brain-mta" className="flex flex-col gap-4 rounded-md border border-signal bg-panel p-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="brain-mta" className="font-display text-xl font-semibold">
            Real MTA records
          </h3>
          <OriginTag origin="mta" />
        </div>
        <p className="text-sm text-ink-700">
          One shared graph, read from the MTA&apos;s public feeds and data.ny.gov. An outage that leaves the feed is marked resolved, never deleted.
        </p>
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-700">Outages and alerts as of</dt>
        <dd className="tabular text-right font-mono text-xs leading-5 text-ink-900">{asOf ? moment(asOf) : "not read yet"}</dd>
        <dt className="text-ink-700">Asset inventory, alert archive, complaints and projects as of</dt>
        <dd className="tabular text-right font-mono text-xs leading-5 text-ink-900">{agency.asOf.assetsMs ? moment(agency.asOf.assetsMs) : "not read yet"}</dd>
        <dt className="text-ink-700">Read from</dt>
        <dd className="text-right text-xs leading-5 text-ink-900">{agency.from === "snapshot" ? "the committed snapshot" : agency.from === "feed" ? "the live feeds" : "unknown"}</dd>
      </dl>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
        <Stat label="Units" value={fmt(c.equipment)} />
        <Stat label="Out now" value={fmt(c.outagesOpen)} tone={c.outagesOpen ? "crit" : "ink"} />
        <Stat label="Planned" value={fmt(c.outagesPlanned)} />
        <Stat label="Resolved" value={fmt(c.outagesResolved)} />
        <Stat label="Alerts" value={fmt(c.alerts)} />
        <Stat label="Projects" value={fmt(c.projects)} />
      </dl>
      {offline ? (
        <p className="text-sm text-ink-700">Reading the feeds again needs the live graph database, which is unreachable right now.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            aria-disabled={pending}
            className={`rounded-md border border-ink-900 px-3 py-1.5 font-display text-base font-semibold text-ink-900 transition-colors duration-150 ${pending ? "cursor-not-allowed opacity-60" : "hover:bg-sunk"}`}
          >
            {pending ? "Reading the feeds…" : "Refresh from the MTA"}
          </button>
          {agency.lastRefresh ? <span className="text-xs text-ink-500">Last refresh {moment(agency.lastRefresh.atMs)}</span> : null}
        </div>
      )}
      <p aria-live="polite" className="text-sm empty:hidden">
        {state.status === "done" ? <span className="text-ink-700">{state.text}</span> : state.status === "error" ? <span className="text-crit">{state.error}</span> : null}
      </p>
      {agency.outages.length ? (
        <div className="flex flex-col gap-2">
          <h4 className="label text-ink-500">Newest outages</h4>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {agency.outages.map((o) => (
              <li key={o.id} className="flex flex-col gap-1 px-3 py-2">
                <span className="break-words text-sm text-ink-900">{o.title}</span>
                {o.snippet ? <span className="text-xs text-ink-500">{o.snippet}</span> : null}
                <About labels={o.about} colors={colors} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="group text-sm">
        <summary className="cursor-pointer text-ink-700 hover:text-ink-900">Sources ({agency.sources.length})</summary>
        <ul className="mt-2 flex flex-col gap-1">
          {agency.sources.map((s) => (
            <li key={s.id} className="break-words">
              <a href={s.page} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:text-ink-900">
                {s.name}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function DirectorySkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-8">
      <p className="sr-only">Loading the directory…</p>
      <div aria-hidden="true" className="grid grid-cols-3 gap-x-4 gap-y-4">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="h-12 animate-pulse rounded-md bg-sunk" />
        ))}
      </div>
      <div aria-hidden="true" className="flex flex-col gap-2">
        <span className="h-6 w-24 animate-pulse rounded-sm bg-sunk" />
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-36 animate-pulse rounded-md bg-sunk" />
        ))}
      </div>
      <div aria-hidden="true" className="flex flex-col gap-2">
        <span className="h-6 w-32 animate-pulse rounded-sm bg-sunk" />
        <span className="h-44 animate-pulse rounded-md bg-sunk" />
      </div>
    </div>
  );
}

function Directory({ data, colors, pending, onAskWhy }: { data: BrainDirectory; colors: Colors; pending: boolean; onAskWhy: (d: BrainSource) => void }) {
  const c = data.counts;
  return (
    <>
      <dl className="grid grid-cols-3 gap-x-4 gap-y-4">
        <Stat label="People" value={fmt(c.people)} />
        <Stat label="Teams" value={fmt(c.teams)} />
        <Stat label="Documents" value={fmt(c.documents)} />
        <Stat label="Tickets" value={fmt(c.tickets)} />
        <Stat label="Chats" value={fmt(c.messages)} />
        <Stat label="Decisions" value={fmt(c.decisions)} />
      </dl>

      <section aria-labelledby="brain-teams" className="flex flex-col gap-3">
        <h3 id="brain-teams" className="font-display text-xl font-semibold">
          Teams
        </h3>
        {data.teams.length ? (
          <ul className="flex flex-col gap-2">
            {data.teams.map((t) => (
              <TeamItem key={t.id} t={t} colors={colors} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-500">No teams in this graph yet.</p>
        )}
      </section>

      <section aria-labelledby="brain-tickets" className="flex flex-col gap-3">
        <h3 id="brain-tickets" className="font-display text-xl font-semibold">
          Open tickets
        </h3>
        {data.openTickets.length ? (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {data.openTickets.map((t) => {
              const meta = [t.by, t.team].filter(Boolean).join(" · ");
              return (
                <li key={t.id} className="flex flex-col gap-1 px-3 py-2.5">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="break-all font-mono text-xs text-ink-500">{t.id}</span>
                    {t.atMs ? <span className="tabular ml-auto font-mono text-xs text-ink-500">{day(t.atMs)}</span> : null}
                  </span>
                  <span className="break-words text-sm text-ink-900">{t.title}</span>
                  {meta ? <span className="text-xs text-ink-500">{meta}</span> : null}
                  <About labels={t.about} colors={colors} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-ink-500">No open tickets.</p>
        )}
      </section>

      <section aria-labelledby="brain-decisions" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 id="brain-decisions" className="font-display text-xl font-semibold">
            Decisions
          </h3>
          <p className="text-sm text-ink-700">Pick one to ask why it was made.</p>
        </div>
        {data.decisions.length ? (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {data.decisions.map((d) => {
              const meta = [d.by, d.team, d.atMs ? dayKept(d.atMs) : null].filter(Boolean).join(" · ");
              return (
                // The whole row is the button's target (its ::after covers the row); the button itself reads "Ask why we decided: …".
                <li
                  key={d.id}
                  className={`relative flex flex-col items-start gap-1 px-3 py-2.5 transition-colors duration-150 ${pending ? "cursor-not-allowed opacity-60" : "hover:bg-sunk/60"}`}
                >
                  <span className="flex w-full flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-xs text-ink-500">{d.id}</span>
                    <StatusPill status={d.status} className="ml-auto" />
                  </span>
                  <span className="break-words text-sm font-semibold text-ink-900">{d.title}</span>
                  {meta ? <span className="text-xs text-ink-500">{meta}</span> : null}
                  <button
                    type="button"
                    onClick={() => onAskWhy(d)}
                    aria-disabled={pending}
                    className={`label rounded-sm text-signal-strong after:absolute after:inset-0 ${pending ? "cursor-not-allowed" : ""}`}
                  >
                    Ask why<span className="sr-only normal-case"> we decided: {d.title}</span>
                    <span aria-hidden="true"> →</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-ink-500">No decisions recorded yet.</p>
        )}
      </section>
    </>
  );
}

type Dir = { status: "loading" } | { status: "ready"; data: BrainDirectory } | { status: "error"; error: string };
type Run =
  | { status: "idle" }
  | { status: "pending"; id: number; question: string }
  | { status: "done"; id: number; answer: BrainAnswer }
  | { status: "error"; id: number; question: string; error: string };

/** Scrolls the answer up into view when it starts below the fold or under the header (a chip or a decision asked). */
function bringIntoView(el: HTMLElement | null) {
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  if (top < 64 || top > window.innerHeight * 0.6) el.scrollIntoView({ block: "start", behavior: motion() });
}

/**
 * The agency brain: ask a question, read the answer with numbered sources from the graph, and open the tool calls
 * and Cypher behind it. The directory beside it is the org side of the same graph.
 */
export function BrainRoom({ routeColors }: { routeColors: Colors }) {
  const [dir, setDir] = useState<Dir>({ status: "loading" });
  const [dirLoads, setDirLoads] = useState(0);
  const [question, setQuestion] = useState("");
  const [run, setRun] = useState<Run>({ status: "idle" });
  const [lit, setLit] = useState<{ n: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const asked = useRef<string | null>(null);
  const seq = useRef(0);
  const answerBox = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    call<BrainDirectory>("/api/brain").then((res) => {
      if (live) setDir(res.ok ? { status: "ready", data: toDirectory(res.data) } : { status: "error", error: res.error });
    });
    return () => {
      live = false;
    };
  }, [dirLoads]);

  // After an answer or an intake the directory and the remembered conversation change: reload them without a skeleton.
  const refresh = useCallback(() => {
    void call<BrainDirectory>("/api/brain").then((res) => {
      if (res.ok) setDir({ status: "ready", data: toDirectory(res.data) });
    });
  }, []);

  // A cited source stays lit for a moment after the jump; a new click (a new object) restarts the clock.
  useEffect(() => {
    if (!lit) return;
    const timer = setTimeout(() => setLit(null), 1600);
    return () => clearTimeout(timer);
  }, [lit]);

  const ask = useCallback(async (raw: string, reveal = false) => {
    const q = raw.trim().slice(0, MAX);
    if (q.length < MIN) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    asked.current = q;
    const id = ++seq.current;
    setQuestion(q);
    setLit(null);
    setRun({ status: "pending", id, question: q });
    // The address names the question on screen: it can be shared, and the palette can link to another one.
    const url = new URL(window.location.href);
    if (url.searchParams.get("q") !== q) {
      url.searchParams.set("q", q);
      window.history.replaceState(null, "", url);
    }
    if (reveal) bringIntoView(answerBox.current);
    const res = await call<BrainAnswer>("/api/brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
      signal: ctrl.signal,
    });
    if (ctrl.signal.aborted) return;
    setRun(res.ok ? { status: "done", id, answer: toAnswer(res.data, q) } : { status: "error", id, question: q, error: res.error });
    if (res.ok) refresh();
  }, [refresh]);

  // The address already names the question on screen once it has been asked, so only a new ?q asks.
  const askFromUrl = useCallback((q: string) => {
    if (q !== asked.current) void ask(q);
  }, [ask]);

  const cite = useCallback((n: number) => {
    const el = document.getElementById(sourceId(n));
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: motion() });
    el.focus({ preventScroll: true });
    setLit({ n });
  }, []);

  const pending = run.status === "pending";
  const tooShort = question.trim().length < MIN;
  const blocked = pending || tooShort;
  const submit = () => {
    if (!blocked) void ask(question);
  };
  const askWhy = (d: BrainSource) => {
    if (pending) return;
    const title = d.title.length > 360 ? `${d.title.slice(0, 359)}…` : d.title;
    void ask(`Why did we decide: "${title}"?`, true);
  };
  const answer = run.status === "done" ? run.answer : null;
  const suggestions = dir.status === "ready" ? dir.data.suggestions : [];
  const offline = dir.status === "ready" && Boolean(dir.data.recorded);

  return (
    <div className="grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:gap-10">
      <div className="flex min-w-0 flex-col gap-10">
        <section aria-labelledby="brain-ask" className="flex flex-col gap-4">
          <h2 id="brain-ask" className="font-display text-2xl font-bold">
            Ask the brain
          </h2>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label htmlFor="brain-question" className="label text-ink-500">
              Your question
            </label>
            <textarea
              id="brain-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                // Enter asks; Shift+Enter is a new line; an IME composing a word keeps its Enter.
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                submit();
              }}
              rows={2}
              maxLength={MAX}
              aria-describedby="brain-question-hint"
              placeholder="Who owns it, who knows it, or why was it decided?"
              className="resize-none rounded-md border border-line bg-panel px-3 py-2 text-base text-ink-900 placeholder:text-ink-500 focus:border-signal"
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <button
                type="submit"
                aria-disabled={blocked}
                className={`shrink-0 whitespace-nowrap rounded-md bg-ink-900 px-4 py-2 font-display text-lg font-semibold tracking-wide text-paper transition-transform duration-150 ease-out ${
                  blocked ? "cursor-not-allowed opacity-50" : "hover:-translate-y-px"
                }`}
              >
                {pending ? "Asking…" : "Ask"}
              </button>
              <p id="brain-question-hint" className="min-w-0 flex-1 text-xs text-ink-500">
                Enter asks; Shift+Enter starts a new line.
              </p>
              {question.length > MAX - 60 ? (
                <span className="tabular font-mono text-xs text-ink-500">
                  {question.length}/{MAX}
                </span>
              ) : null}
            </div>
          </form>
          {dir.status === "loading" ? (
            <div aria-hidden="true" className="flex flex-wrap gap-2">
              <span className="h-8 w-60 max-w-full animate-pulse rounded-md bg-sunk" />
              <span className="h-8 w-72 max-w-full animate-pulse rounded-md bg-sunk" />
              <span className="h-8 w-56 max-w-full animate-pulse rounded-md bg-sunk" />
            </div>
          ) : suggestions.length ? (
            <div className="flex flex-col gap-2">
              <p id="brain-try" className="label text-ink-500">
                Try one
              </p>
              <ul aria-labelledby="brain-try" className="flex flex-wrap gap-2">
                {suggestions.map((s, i) => (
                  <li key={`${i}${s}`} className="max-w-full">
                    <button
                      type="button"
                      onClick={() => {
                        if (!pending) void ask(s, true);
                      }}
                      aria-disabled={pending}
                      className={`max-w-full rounded-md border border-line bg-panel px-3 py-1.5 text-left text-sm text-ink-700 transition-colors duration-150 ${
                        pending ? "cursor-not-allowed opacity-60" : "hover:border-line-strong hover:text-ink-900"
                      }`}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section ref={answerBox} aria-labelledby="brain-answer" className="flex scroll-mt-16 flex-col gap-6">
          <div className="overflow-hidden rounded-md border border-line bg-panel">
            <h2 id="brain-answer" className="sign-band label px-3 py-1.5">
              Answer
            </h2>
            <div aria-live="polite" className="p-4">
              {run.status === "pending" ? (
                <Pending key={run.id} question={run.question} />
              ) : run.status === "error" ? (
                <div className="flex flex-col gap-3">
                  <h3 className="break-words font-display text-xl font-semibold leading-tight">{run.question}</h3>
                  <p className="rounded-md border border-crit bg-crit-wash px-3 py-2 text-sm text-ink-900">
                    <span className="label mr-2 text-crit">Could not answer</span>
                    {run.error}
                  </p>
                  <button
                    type="button"
                    onClick={() => void ask(run.question)}
                    className="w-fit rounded-md border border-ink-900 px-3 py-1.5 font-display text-base font-semibold text-ink-900 transition-colors duration-150 hover:bg-sunk"
                  >
                    Ask again
                  </button>
                </div>
              ) : answer ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col items-start gap-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <ModeBadge answer={answer} />
                      <span className="tabular font-mono text-xs text-ink-500">
                        {took(answer.ms)} · {count(answer.sources.length, "source")}
                      </span>
                    </div>
                    {answer.note ? <p className="text-xs text-ink-500">{answer.note}</p> : null}
                    {answer.followUp ? (
                      <p className="text-xs text-ink-700">
                        Read as a follow-up about <span className="font-mono font-semibold text-ink-900">{answer.followUp.label}</span>, from what the previous answer cited.
                      </p>
                    ) : null}
                  </div>
                  <h3 className="break-words font-display text-xl font-semibold leading-tight">{answer.question}</h3>
                  <AnswerText text={answer.answer} sources={answer.sources} onCite={cite} />
                </div>
              ) : (
                <p className="max-w-prose text-sm text-ink-700">
                  Answers show here with numbered sources: the MTA records (each with its receipt: the published text, its source and when it was
                  read) and the sample agency&apos;s documents, tickets, chats and decisions that each line came from. Pick a question above or ask your
                  own; a follow-up like &ldquo;when will it be back?&rdquo; is read with the previous answer.
                </p>
              )}
            </div>
          </div>

          {answer ? (
            <section aria-labelledby="brain-sources" className="flex flex-col gap-3">
              <h3 id="brain-sources" className="font-display text-xl font-semibold">
                Sources
              </h3>
              {answer.sources.length ? (
                <ol className="flex flex-col gap-2">
                  {answer.sources.map((s, i) => (
                    <SourceItem key={`${i}${s.id}`} s={s} n={i + 1} lit={lit?.n === i + 1} colors={routeColors} />
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-ink-500">This answer cites no sources.</p>
              )}
            </section>
          ) : null}

          {answer?.steps.length ? <Steps steps={answer.steps} /> : null}
        </section>

        <Intake colors={routeColors} onAdded={refresh} onAskChanged={() => void ask("What changed in the last 1 days?", true)} offline={offline} />

        {dir.status === "ready" ? <History turns={dir.data.history} pending={pending} onAsk={(q) => void ask(q, true)} /> : null}

        <Suspense fallback={null}>
          <AskFromUrl onAsk={askFromUrl} />
        </Suspense>
      </div>

      <aside aria-labelledby="brain-directory" className="flex min-w-0 flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h2 id="brain-directory" className="font-display text-2xl font-bold">
            Directory
          </h2>
          <p className="text-sm text-ink-700">
            The MTA&apos;s real records, then the sample agency: who is on which team, what each team owns, what is still open and what was decided.
          </p>
        </header>
        {dir.status === "loading" ? (
          <DirectorySkeleton />
        ) : dir.status === "error" ? (
          <div className="flex flex-col gap-3 rounded-md border border-dashed border-line-strong p-4">
            <p className="font-display text-xl font-semibold leading-tight">The graph database is unreachable right now.</p>
            <p className="break-words text-sm text-ink-700">{dir.error}</p>
            <button
              type="button"
              onClick={() => {
                setDir({ status: "loading" });
                setDirLoads((n) => n + 1);
              }}
              className="w-fit rounded-md border border-ink-900 px-3 py-1.5 font-display text-base font-semibold text-ink-900 transition-colors duration-150 hover:bg-sunk"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            {dir.data.recorded ? (
              <div role="status" className="flex flex-col gap-1 rounded-md border border-warn bg-warn-wash p-4">
                <p className="font-display text-lg font-semibold leading-tight text-ink-900">The graph database is unreachable right now.</p>
                <p className="text-sm text-ink-700">
                  This is the directory as recorded on {recordedDay(dir.data.recorded.at)}, and the suggested questions answer from that recording,
                  labeled as such. Other questions need the live graph.
                </p>
              </div>
            ) : null}
            <AgencyPanel
              agency={dir.data.agency}
              colors={routeColors}
              offline={offline}
              onRefreshed={(agency) => setDir((d) => (d.status === "ready" ? { status: "ready", data: { ...d.data, agency } } : d))}
            />
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-xl font-semibold">The sample agency</h3>
                <OriginTag origin="sample" />
              </div>
              <p className="text-sm text-ink-700">Invented people, teams, documents, tickets, chats and decisions, wired to the real stations and lines. Not MTA staff.</p>
            </div>
            <Directory data={dir.data} colors={routeColors} pending={pending} onAskWhy={askWhy} />
          </>
        )}
      </aside>
    </div>
  );
}
