/**
 * The one SSE reader both streaming providers share (M5/E1).
 *
 * Server-sent events are line-framed: a payload is the text after `data:` on
 * one or more lines, and an event ends at a blank line. Gateways also emit
 * keep-alive comments (`: ping`) and may close without a trailing blank line,
 * so the reader tolerates both — an unparsable payload is the caller's
 * problem (each provider skips chunks it cannot parse), but a lost tail is
 * not: the final flush yields whatever the last partial frame carried.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  for (;;) {
    const { value: chunk, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(chunk, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const payload = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (payload !== "") yield payload;
      sep = buffer.indexOf("\n\n");
    }
  }
  const tail = buffer
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (tail !== "") yield tail;
}
