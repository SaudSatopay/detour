/** Reads a streamed newline-delimited JSON response, calling onEvent for each line as it arrives. */
export async function readNdjson<E>(response: Response, onEvent: (event: E) => void): Promise<void> {
  if (!response.body) throw new Error("The server sent no stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as E);
      nl = buffer.indexOf("\n");
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) onEvent(JSON.parse(rest) as E);
}
