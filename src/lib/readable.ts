/** "a, b and c". */
const sentenceList = (parts: string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/**
 * Tool summaries are written for the trace and the graph; this makes them read like sentences for people:
 * no graph ids in brackets, a name said once when it resolved to itself, "the L line" for a route the reader
 * already named, spaced route lists and no "time(s)".
 */
export const readable = (text: string) =>
  text
    .replace(/ \[\d{1,4}\]/g, "")
    // "Bedford Av → Bedford Av (L)": the name asked for is the station's own.
    .replace(/(^|: |; )([^;:→]+?) → \2(?= \()/g, "$1$2")
    .replace(/\b([A-Z0-9]{1,2}) → route \1\b/g, "the $1 line")
    .replace(/\(([A-Z0-9]{1,2}(?:,[A-Z0-9]{1,2})+)\)/g, (_, routes: string) => `(${routes.split(",").join(", ")})`)
    .replace(/\bResolved: ([^.]*)\./g, (_, found: string) => `Found ${sentenceList(found.split("; "))}.`)
    .replace(/\b1 time\(s\)/g, "once")
    .replace(/time\(s\)/g, "times");
