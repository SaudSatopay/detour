/** Grades a free-text answer against an expected value from the eval set (data/eval/questions.json). */
export type Expect =
  | { kind: "number"; value: number; tolerance: number }
  | { kind: "yesno"; value: "yes" | "no" }
  | { kind: "contains"; any: string[] }
  | { kind: "decline" };

const DECLINE =
  /\b(unknown|not (in|part of|on) the (graph|network|subway|map)|no (such|station|route|line) (called|named)?|(doesn'?t|does not) exist|isn'?t (a|an) (real|subway|station|route)|not a (real|subway|valid)|fictional|could(n'?t| not) (find|resolve)|can(no|')t (find|resolve)|not found|unknown_entity|no station|no route)\b/i;

/** The part after the last "Answer:" marker, or the whole text. */
export function finalAnswer(text: string): string {
  const matches = [...text.matchAll(/answer\s*:\s*(.+)/gi)];
  return (matches.length ? matches[matches.length - 1][1] : text).trim();
}

export function firstNumber(text: string): number | null {
  const m = text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function grade(text: string, expect: Expect): boolean {
  const answer = finalAnswer(text);
  switch (expect.kind) {
    case "number": {
      const n = firstNumber(answer);
      return n !== null && Math.abs(n - expect.value) <= Math.max(1, expect.tolerance * expect.value);
    }
    case "yesno": {
      const m = answer.toLowerCase().match(/\b(yes|no)\b/);
      return m?.[1] === expect.value;
    }
    case "contains":
      return expect.any.some((s) => answer.toLowerCase().includes(s.toLowerCase()));
    case "decline":
      return DECLINE.test(answer) || DECLINE.test(text);
  }
}
