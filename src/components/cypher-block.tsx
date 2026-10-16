const KEYWORDS =
  /\b(MATCH|OPTIONAL|WHERE|RETURN|WITH|UNWIND|AS|CALL|YIELD|CREATE|MERGE|SET|DELETE|ORDER BY|LIMIT|AND|OR|NOT|IN|DISTINCT|CASE|WHEN|THEN|ELSE|END|GRAPH\.COPY|GRAPH\.DELETE)\b/g;

/** Read-only Cypher with keywords set apart. Plain text in the DOM, so it copies and wraps cleanly. */
export function CypherBlock({ code, className = "" }: { code: string; className?: string }) {
  const parts = code.split(KEYWORDS);
  return (
    <pre tabIndex={0} aria-label="Cypher query" className={`scroll-x-cue overflow-x-auto rounded-md bg-sunk p-3 font-mono text-[0.8125rem] leading-relaxed text-ink-700 ${className}`}>
      <code>
        {parts.map((part, i) =>
          i % 2 === 1 ? (
            <span key={i} className="font-semibold text-ink-900">
              {part}
            </span>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </code>
    </pre>
  );
}
