/** Grades a free-text answer against an expected value from the eval set (data/eval/questions.json). */
export type Expect =
  /** Within max(1, tolerance × value) of the value, or within `abs` when it is given (counts such as transfers). */
  | { kind: "number"; value: number; tolerance: number; abs?: number }
  | { kind: "yesno"; value: "yes" | "no" }
  | { kind: "contains"; any: string[] }
  /** A calendar date (YYYY-MM-DD), in any of the ways people write one. */
  | { kind: "date"; iso: string }
  /** Exactly these line names, no more and no fewer, out of every line in the network. */
  | { kind: "set"; items: string[]; universe: string[] }
  | { kind: "decline" };

const DECLINE =
  /\b(unknown|not (in|part of|on) the (graph|network|subway|map|memory)|no (such|station|route|line) (called|named)?|(doesn'?t|does not) exist|isn'?t (a|an) (real|subway|station|route)|not a (real|subway|valid)|fictional|could(n'?t| not) (find|resolve)|can(no|')t (find|resolve)|not found|unknown_entity|no station|no route|no (open |subway )?(path|connection)|not connected|unreachable|(doesn'?t|does not|never) (serve|run|stop|go)|no (record|finding|memory|such (incident|outage))|nothing (is )?(remembered|recorded)|not (recorded|remembered))\b/i;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The part after the last "Answer:" marker, or the whole text. */
export function finalAnswer(text: string): string {
  const matches = [...text.matchAll(/answer\s*:\s*(.+)/gi)];
  return (matches.length ? matches[matches.length - 1][1] : text).trim();
}

export function firstNumber(text: string): number | null {
  const m = text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Whether the answer says "nothing" in words: a count of zero. */
const ZERO = /\b(none|zero|no (transfers?|changes?|riders?)|nobody|direct)\b/i;

/** Every spelling of the date the grader accepts: Oct 14, October 14, 14 October, 10/14, 2026-10-14. */
export function dateForms(iso: string): RegExp[] {
  const [y, m, d] = iso.split("-").map(Number);
  const month = MONTHS[m - 1];
  const short = month.slice(0, 3);
  return [
    new RegExp(`\\b(${month}|${short}\\.?)\\s+${d}(st|nd|rd|th)?\\b`, "i"),
    new RegExp(`\\b${d}(st|nd|rd|th)?\\s+(of\\s+)?(${month}|${short})\\b`, "i"),
    new RegExp(`\\b0?${m}/0?${d}(/(${y}|${y % 100}))?\\b`),
    new RegExp(`\\b${y}-0?${m}-0?${d}\\b`),
  ];
}

/** Line names mentioned in an answer: whole tokens from the network's own list (letters only in capitals). */
export function linesIn(text: string, universe: string[]): Set<string> {
  const known = new Set(universe);
  // "3 lines: A, C, E" is a count, not the 3 train.
  const cleaned = text.replace(/\b\d+\s+(lines|routes|trains|services|of them)\b/gi, " ");
  const found = new Set<string>();
  for (const token of cleaned.split(/[^A-Za-z0-9]+/)) {
    if (!token) continue;
    const id = /^\d+$/.test(token) ? token : token === token.toUpperCase() ? token : null;
    if (id && known.has(id)) found.add(id);
  }
  return found;
}

export function grade(text: string, expect: Expect): boolean {
  const answer = finalAnswer(text);
  switch (expect.kind) {
    case "number": {
      const n = firstNumber(answer) ?? (expect.value === 0 && ZERO.test(answer) ? 0 : null);
      const allowed = expect.abs ?? Math.max(1, expect.tolerance * expect.value);
      return n !== null && Math.abs(n - expect.value) <= allowed;
    }
    case "yesno": {
      const m = answer.toLowerCase().match(/\b(yes|no)\b/);
      return m?.[1] === expect.value;
    }
    case "contains":
      return expect.any.some((s) => answer.toLowerCase().includes(s.toLowerCase()));
    case "date":
      return dateForms(expect.iso).some((re) => re.test(answer));
    case "set": {
      const found = linesIn(answer, expect.universe);
      return found.size === expect.items.length && expect.items.every((i) => found.has(i));
    }
    case "decline":
      return DECLINE.test(answer) || DECLINE.test(text);
  }
}

/** Whether an answer declines (says a name or relation is not in the graph) whatever was expected. */
export function declines(text: string): boolean {
  return DECLINE.test(finalAnswer(text));
}
