import { expect, test } from "bun:test";
import { ProviderError, streamEvents } from "./http.ts";

// A stream that sends one event and then nothing is cut after the idle
// timeout as a retryable network failure, not left hanging.
test("a stalled stream is cut as a retryable failure", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: {\"a\":1}\n\n")); } }), {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  try {
    const seen: string[] = [];
    const err = await (async () => {
      for await (const ev of streamEvents({ label: "stub", url: `http://127.0.0.1:${server.port}/`, headers: {}, body: {}, signal: new AbortController().signal, idleMs: 150 })) seen.push(ev.data);
    })().then(() => null, (e) => e);
    expect(seen).toEqual(['{"a":1}']);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as Error).message).toContain("no data from the model");
  } finally {
    server.stop(true);
  }
}, 3000);
