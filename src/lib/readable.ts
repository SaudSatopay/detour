/**
 * Tool summaries are written for the trace and the graph; this makes them read like sentences for people:
 * no graph ids in brackets, no "route L" echo of a route the reader already named, no "time(s)".
 */
export const readable = (text: string) =>
  text
    .replace(/ \[\d{1,4}\]/g, "")
    .replace(/\b([A-Z0-9]{1,2}) → route \1\b/g, "the $1 line")
    .replace(/\b1 time\(s\)/g, "once")
    .replace(/time\(s\)/g, "times");
