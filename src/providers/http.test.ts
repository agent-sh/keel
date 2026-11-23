import { expect, test } from "bun:test";
import { allPages, classify, getJson, MAX_PAGES, ProviderError, streamEvents } from "./http.ts";
import { type Wire, wireScope } from "./wiretap.ts";
import { requestTooLarge } from "./image-limits.ts";

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

// The wire record's size of the body is what went on the wire: UTF-8 bytes.
test("the wire record counts the request body in bytes", async () => {
  let got = 0;
  const server = Bun.serve({ port: 0, fetch: async (r) => { got = (await r.arrayBuffer()).byteLength; return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }); } });
  try {
    const tap: Wire = {};
    await wireScope.run(tap, async () => {
      for await (const _ of streamEvents({ label: "stub", url: `http://127.0.0.1:${server.port}/`, headers: {}, body: { text: "h\u00e9llo \u20ac" }, signal: new AbortController().signal })) {}
    });
    expect(got).toBe(JSON.stringify({ text: "hello E" }).length + 3);
    expect(tap.body_bytes).toBe(got);
  } finally {
    server.stop(true);
  }
});

// A host with a request size limit answers a larger request with a server
// error, not a 413: it is refused before it is sent, as too large, so the turn
// leaves its images out instead of sending it ten times.
test("a request over the host's size limit is not sent and reads as too large", async () => {
  let got = 0;
  const server = Bun.serve({ port: 0, fetch: () => { got++; return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }); } });
  try {
    const open = (maxBodyBytes: number) => (async () => { for await (const _ of streamEvents({ label: "Host", url: `http://127.0.0.1:${server.port}/`, headers: {}, body: { text: "x".repeat(2000) }, signal: new AbortController().signal, maxBodyBytes })) {} })();
    const e = await open(1000).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind: "invalid", status: 413 });
    expect(requestTooLarge(e)).toBe(true);
    expect(got).toBe(0);
    await open(10_000);
    expect(got).toBe(1);
  } finally {
    server.stop(true);
  }
});

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

// A paged listing that does not end: the built-in Anthropic and Gemini
// listings say so and fail, as a configured endpoint's does, instead of
// stopping quietly at a page count with a list that looks whole. A stand-in
// server plays the pages (the real listings never do this on demand).
test("a built-in listing whose pages repeat or never end fails and says so", async () => {
  const { AnthropicProvider } = await import("./anthropic.ts");
  let mode: "ends" | "repeats" | "endless" = "ends";
  let asked = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      asked++;
      const u = new URL(req.url);
      const gemini = u.pathname.startsWith("/v1beta");
      const at = Number(u.searchParams.get(gemini ? "pageToken" : "after_id")?.replace("p", "") ?? 0);
      const more = mode === "endless" || (mode === "ends" ? at < 2 : true);
      const next = `p${mode === "repeats" ? (at + 1) % 2 : at + 1}`;
      return Response.json(gemini
        ? { models: [{ name: `models/gemini-test-${at}`, supportedGenerationMethods: ["generateContent"], displayName: `G ${at}` }], ...(more ? { nextPageToken: next } : {}) }
        : { data: [{ id: `claude-test-${at}`, display_name: `C ${at}` }], has_more: more, last_id: more ? next : null });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const before = { g: process.env.GEMINI_BASE_URL, k: process.env.GEMINI_API_KEY };
  process.env.GEMINI_BASE_URL = base;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const { GeminiProvider } = await import("./keyed.ts");
    const lists = { "Anthropic API": () => new AnthropicProvider("anthropic", { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base }).list(), "Gemini API": () => new GeminiProvider().list() };
    for (const [label, list] of Object.entries(lists)) {
      mode = "ends";
      expect((await list()).map((m) => m.model)).toEqual([0, 1, 2].map((n) => `${label === "Gemini API" ? "gemini" : "claude"}-test-${n}`));
      mode = "repeats";
      asked = 0;
      await expect(list()).rejects.toThrow(`${label}: the model listing does not end (page 3 names a page cursor it gave before); 3 models were read and the list is not complete`);
      expect(asked).toBe(3);
      mode = "endless";
      asked = 0;
      await expect(list()).rejects.toThrow(`${label}: the model listing does not end (it has more than ${MAX_PAGES} pages); ${MAX_PAGES} models were read and the list is not complete`);
      expect(asked).toBe(MAX_PAGES);
    }
  } finally {
    server.stop(true);
    for (const [k, v] of [["GEMINI_BASE_URL", before.g], ["GEMINI_API_KEY", before.k]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// One deadline for a whole paged listing: slow pages add up to it, and a page
// that hangs is cut at it, with what was read named as not the whole list.
test("a paged listing has one deadline over all its pages", async () => {
  let hang = false;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const at = Number(new URL(req.url).searchParams.get("after") ?? 0);
      if (hang && at === 1) await Bun.sleep(5_000);
      else await Bun.sleep(350);
      return Response.json({ data: [`m${at}`], next: `${at + 1}` });
    },
  });
  const page = async (cursor: string, until: number) => {
    const d = await getJson("Slow", `http://127.0.0.1:${server.port}/?after=${cursor || 0}`, {}, [], until);
    return { rows: d.data as string[], next: d.next };
  };
  try {
    // Each page is quick enough on its own; together they pass the listing's time.
    let t0 = Date.now();
    await expect(allPages("Slow", page, 1_000)).rejects.toThrow(/^Slow: the model listing took more than 1 s \(it was on page [34]\); [23] models were read and the list is not complete$/);
    expect(Date.now() - t0).toBeLessThan(1_600);
    // A page that hangs is cut when the listing's time is up, not after its own.
    hang = true;
    t0 = Date.now();
    await expect(allPages("Slow", page, 1_000)).rejects.toThrow("Slow: the model listing took more than 1 s (it was on page 2); 1 models were read and the list is not complete");
    expect(Date.now() - t0).toBeLessThan(1_600);
  } finally {
    server.stop(true);
  }
});

test("a credential that could not be read in time is a passing failure; a refused one is not", () => {
  const of = (status: number, message: string) => classify("p", status, new Headers(), JSON.stringify({ error: { message } }));
  const late = of(403, "the credential cannot be read (the secret store did not answer in time; it may be locked)");
  expect([late.kind, late.retryable]).toEqual(["network", true]);
  expect(of(401, "credential helper timed out").retryable).toBe(true);
  for (const refused of [of(403, "The security token included in the request is invalid."), of(401, "invalid x-api-key"), of(403, "access denied")]) {
    expect([refused.kind, refused.retryable]).toEqual(["auth", false]);
  }
});
