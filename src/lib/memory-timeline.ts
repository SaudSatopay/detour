/**
 * Geometry for the "Memory over time" chart on /memory: a time scale from the earliest fact or incident to
 * today, one row per finding grouped by the routes it is about, supersedes links between rows, incident
 * markers and episode ticks. Pure: no DOM, no clock; the caller passes `nowMs` and the plot width.
 */

const DAY = 86_400_000;
const NY = "America/New_York";

/** Fixed vertical rhythm, shared with the HTML row labels so they line up with the SVG. */
export const TIMELINE = {
  rowH: 40,
  groupH: 26,
  laneH: 18,
  episodeH: 30,
  axisH: 30,
  padL: 16,
  padR: 72,
  minWidth: 640,
} as const;

export interface TimelineFact {
  id: string;
  text: string;
  kind: string;
  validFromMs: number;
  validToMs: number | null;
  example: boolean | null;
  about: string[];
  agent: string | null;
  supersedes: string | null;
}

export interface TimelineIncident {
  id: string;
  title: string;
  openedMs: number;
  example?: boolean | null;
  /** Still open: the incident the agents are working now. */
  open?: boolean;
}

interface TimelineInput {
  findings: TimelineFact[];
  incidents: TimelineIncident[];
  episodes: { atMs: number }[];
  nowMs: number;
  /** Width available for the plot, in px. Narrower widths are raised to `TIMELINE.minWidth`. */
  width: number;
}

export interface TimelineRow {
  id: string;
  fact: TimelineFact;
  group: string;
  /** Stations the fact is about, readable; empty when it is about whole routes. */
  label: string;
  /** Top of the row and its vertical center. */
  y: number;
  cy: number;
  x1: number;
  x2: number;
  open: boolean;
  /** Pointer and keyboard target: the bar, widened to at least 24 px. */
  hit: { x: number; w: number };
  /** The incident this fact was written during, when there is one. */
  incident: TimelineIncident | null;
}

interface TimelineLink {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  d: string;
  labelX: number;
  labelY: number;
}

interface TimelineIncidentMark {
  incident: TimelineIncident;
  x: number;
  label: string;
  lane: number;
  anchor: "start" | "end";
  labelY: number;
}

// Dates read in the subway's time zone, the same on the server and in every browser.
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: NY });
const shortFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: NY });
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: NY });
const partsFmt = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23", timeZone: NY });

export const formatDay = (ms: number) => dayFmt.format(ms);
const formatShort = (ms: number) => shortFmt.format(ms);

function nyParts(ms: number) {
  const p = Object.fromEntries(partsFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month) - 1, day: Number(p.day), hour: Number(p.hour) };
}

/** Midnight on the first of a month in New York, as epoch ms (EDT or EST, whichever applies). */
function nyMonthStart(year: number, month: number): number {
  const guess = Date.UTC(year, month, 1, 4); // midnight under EDT; 23:00 the day before under EST
  return nyParts(guess).hour === 0 ? guess : guess + 3_600_000;
}

/** Route ids are one or two characters (L, A, 7, GS) or SIR; station names have spaces. */
const isRoute = (s: string) => /^[A-Z0-9]{1,2}$|^SIR$/.test(s);
const routeOrder = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function routesLabel(routes: string[]): string {
  if (routes.length === 1) return `${routes[0]} train`;
  return `${routes.slice(0, -1).join(", ")} and ${routes.at(-1)} trains`;
}

function subject(f: TimelineFact) {
  const routes = [...new Set(f.about.filter(isRoute))].sort(routeOrder);
  const places = f.about.filter((s) => !isRoute(s));
  if (routes.length) return { key: `r:${routes.join(",")}`, label: routesLabel(routes), places };
  if (places.length) return { key: `s:${places[0]}`, label: places[0], places: places.slice(1) };
  return { key: "network", label: "Whole network", places };
}

/** "Smoke condition, Canarsie Tube" reads as "Canarsie Tube smoke". */
function shortTitle(title: string): string {
  const m = /^(\w+) condition, (.+)$/i.exec(title);
  return m ? `${m[2]} ${m[1].toLowerCase()}` : title;
}

/** The accessible name of a bar: the fact, its window, and whether it still holds. */
export function factName(f: TimelineFact): string {
  const text = f.text.trim().replace(/[.;:,]+$/, "");
  return f.validToMs === null || f.validToMs === undefined
    ? `${text}, valid since ${formatDay(f.validFromMs)}, still true`
    : `${text}, valid ${formatDay(f.validFromMs)} to ${formatDay(f.validToMs)}, closed`;
}

// A finding written within this long after an incident opened is read as learned in that incident.
const INCIDENT_WINDOW = 18 * 3_600_000;

function incidentFor(f: TimelineFact, incidents: TimelineIncident[]): TimelineIncident | null {
  let best: TimelineIncident | null = null;
  for (const i of incidents) {
    const lag = f.validFromMs - i.openedMs;
    if (lag >= 0 && lag <= INCIDENT_WINDOW && (!best || i.openedMs > best.openedMs)) best = i;
  }
  return best;
}

const LABEL_CHAR = 6.6; // average px per character of the 12 px label type

export function layoutTimeline({ findings, incidents, episodes, nowMs, width: available }: TimelineInput) {
  const T = TIMELINE;
  const width = Math.max(T.minWidth, Math.round(available));
  const times = [...findings.map((f) => f.validFromMs), ...incidents.map((i) => i.openedMs)].filter((t) => t <= nowMs);
  const earliest = times.length ? Math.min(...times) : nowMs - 30 * DAY;
  const margin = Math.max(5 * DAY, (nowMs - earliest) * 0.04);
  const startMs = earliest - margin;
  const endMs = nowMs;
  const plotW = width - T.padL - T.padR;
  const x = (ms: number) => T.padL + ((Math.min(ms, endMs) - startMs) / (endMs - startMs)) * plotW;
  const todayX = x(nowMs);

  // Incident labels sit in lanes above the rows, stacked when they would collide.
  const laneEnds: number[] = [];
  const marks = [...incidents]
    .filter((i) => i.openedMs <= nowMs)
    .sort((a, b) => a.openedMs - b.openedMs)
    .map((incident) => {
      const ix = x(incident.openedMs);
      const label = `${formatShort(incident.openedMs)} · ${shortTitle(incident.title)}${incident.open ? " (open)" : ""}`;
      const w = label.length * LABEL_CHAR + 8;
      const anchor: "start" | "end" = ix + w > width - 4 ? "end" : "start";
      const [from, to] = anchor === "start" ? [ix, ix + w] : [ix - w, ix];
      let lane = laneEnds.findIndex((end) => end + 8 <= from);
      if (lane === -1) lane = laneEnds.push(to) - 1;
      else laneEnds[lane] = to;
      return { incident, x: ix, label, lane, anchor };
    });
  const top = marks.length ? 6 + laneEnds.length * T.laneH + 8 : 8;
  const incidentMarks: TimelineIncidentMark[] = marks.map((m) => ({ ...m, labelY: 6 + m.lane * T.laneH + 12 }));

  // Group by subject; groups and rows run oldest first, and a replacement sits right under the fact it closed.
  const byGroup = new Map<string, { key: string; label: string; facts: TimelineFact[] }>();
  const subjects = new Map<string, ReturnType<typeof subject>>();
  for (const f of findings) {
    const s = subject(f);
    subjects.set(f.id, s);
    const g = byGroup.get(s.key) ?? { key: s.key, label: s.label, facts: [] };
    g.facts.push(f);
    byGroup.set(s.key, g);
  }
  const first = (g: { facts: TimelineFact[] }) => Math.min(...g.facts.map((f) => f.validFromMs));
  const groupsOrdered = [...byGroup.values()].sort((a, b) => first(a) - first(b) || b.facts.length - a.facts.length || a.label.localeCompare(b.label));

  const rows: TimelineRow[] = [];
  const groups: { key: string; label: string; y: number; rows: string[] }[] = [];
  let y = top;
  for (const g of groupsOrdered) {
    const sorted = [...g.facts].sort((a, b) => a.validFromMs - b.validFromMs || a.id.localeCompare(b.id));
    const inGroup = new Set(sorted.map((f) => f.id));
    const successors = new Map<string, TimelineFact[]>();
    for (const f of sorted) if (f.supersedes && inGroup.has(f.supersedes)) successors.set(f.supersedes, [...(successors.get(f.supersedes) ?? []), f]);
    const order: TimelineFact[] = [];
    const place = (f: TimelineFact) => {
      order.push(f);
      for (const s of successors.get(f.id) ?? []) place(s);
    };
    for (const f of sorted) if (!(f.supersedes && inGroup.has(f.supersedes))) place(f);

    groups.push({ key: g.key, label: g.label, y, rows: order.map((f) => f.id) });
    y += T.groupH;
    for (const f of order) {
      const open = f.validToMs === null || f.validToMs === undefined;
      const x1 = x(Math.max(f.validFromMs, startMs));
      const x2 = open ? todayX : Math.max(x1, x(f.validToMs!));
      const hitW = Math.max(24, x2 - x1 + 12);
      const hitX = Math.min(Math.max(0, (x1 + x2) / 2 - hitW / 2), width - hitW);
      rows.push({
        id: f.id,
        fact: f,
        group: g.key,
        label: subjects.get(f.id)!.places.join(", "),
        y,
        cy: y + T.rowH / 2,
        x1,
        x2,
        open,
        hit: { x: hitX, w: hitW },
        incident: incidentFor(f, incidents),
      });
      y += T.rowH;
    }
  }
  const bodyBottom = y;

  // Supersedes: from where the old fact closed to where its replacement starts.
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const links: TimelineLink[] = [];
  for (const r of rows) {
    const old = r.fact.supersedes ? rowById.get(r.fact.supersedes) : undefined;
    if (!old) continue;
    const [x1, y1, x2, y2] = [old.open ? r.x1 : old.x2, old.cy, r.x1, r.cy];
    // Far apart: an S from the cap into the new bar's start. Close together (a fact replaced the moment it
    // closed): a hook that bulges right, so it stays visible instead of folding onto itself.
    const near = Math.abs(x2 - x1) < 40;
    const k = Math.abs(x2 - x1) / 2;
    const dy = (y2 - y1) * 0.3;
    const [c1x, c1y, c2x, c2y] = near ? [Math.max(x1, x2) + 22, y1 + dy, Math.max(x1, x2) + 22, y2 - dy] : [x1 + k, y1, x2 - k, y2];
    const f = (n: number) => n.toFixed(1);
    links.push({
      from: old.id,
      to: r.id,
      x1,
      y1,
      x2,
      y2,
      d: `M${f(x1)} ${f(y1)} C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(x2)} ${f(y2)}`,
      // The curve's midpoint (t = 0.5 on the cubic).
      labelX: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
      labelY: (y1 + 3 * c1y + 3 * c2y + y2) / 8,
    });
  }

  const episodeTicks = episodes.filter((e) => e.atMs >= startMs && e.atMs <= nowMs).map((e) => ({ x: x(e.atMs) }));
  const episodeLane = episodeTicks.length ? { y: bodyBottom, h: T.episodeH } : null;
  const axisY = bodyBottom + (episodeLane ? T.episodeH : 0);

  // Month ticks on the 1st in New York; the label nearest Today is dropped so "Today" stays legible.
  const ticks: { ms: number; x: number; label: string | null }[] = [];
  const s = nyParts(startMs);
  for (let m = s.month + 1, yr = s.year; ; m++) {
    if (m > 11) {
      m = 0;
      yr++;
    }
    const ms = nyMonthStart(yr, m);
    if (ms > endMs) break;
    const tx = x(ms);
    const label = ticks.length === 0 || m === 0 ? `${monthFmt.format(ms)} ${yr}` : monthFmt.format(ms);
    ticks.push({ ms, x: tx, label: todayX - tx < 64 ? null : label });
  }

  return {
    width,
    height: axisY + T.axisH,
    startMs,
    endMs,
    x,
    top,
    bodyBottom,
    axisY,
    today: { x: todayX, label: `Today, ${formatShort(nowMs)}` },
    ticks,
    groups,
    rows,
    links,
    incidents: incidentMarks,
    episodes: episodeTicks,
    episodeLane,
  };
}
