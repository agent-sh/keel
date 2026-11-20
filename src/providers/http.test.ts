import { expect, test } from "bun:test";
import { classify, ProviderError, streamEvents } from "./http.ts";

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

// A request over the model's window is refused in each provider's own words;
// all of them must read as an overflow (the turn compacts and goes on).
test("each provider's over-the-window refusal is a context error", () => {
  const kind = (message: string) => classify("p", 400, new Headers(), JSON.stringify({ error: { message } })).kind;
  expect(kind("prompt is too long: 215000 tokens > 200000 maximum")).toBe("context");
  expect(kind("This model's maximum context length is 128000 tokens.")).toBe("context");
  expect(kind("The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1371861.")).toBe("context");
  expect(kind("the request exceeds the available context size, try increasing it")).toBe("context");
  expect(kind("Invalid value for tool_choice.")).toBe("invalid");
  expect(kind("max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens")).toBe("invalid");
});

// A model the plan does not include comes back as a 429 on some plans: it is
// not a rate limit, and a turn switched onto it fails at once instead of retrying.
test("a model outside the plan is not a rate limit", () => {
  const e = classify("p", 429, new Headers(), JSON.stringify({ error: { message: "Your current subscription plan does not yet include access to GLM-5.3-FlashX" } }));
  expect(e.kind).toBe("invalid");
  expect(e.retryable).toBe(false);
  expect(classify("p", 429, new Headers(), JSON.stringify({ error: { message: "Rate limit reached for requests" } })).kind).toBe("rate");
});
