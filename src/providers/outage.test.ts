// A provider that cannot be reached: which failures are that, the wait's
// numbers, and the one wait every session of a provider shares.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorClass } from "../admin/classes.ts";
import { retryable } from "../engine/retry.ts";
import { classify, notReached, ProviderError } from "./http.ts";
import { OUTAGE, Outages, outageDelayMs, staggerGapMs, type Outage } from "./outage.ts";
import { gatewayDown, neverSent, unreachable } from "./unreachable.ts";

const thrown = (message: string, code?: string) => Object.assign(new TypeError(message), code ? { code } : {});

test("a request that never got an answer is unreachable; one that was answered is not", () => {
  // What the runtime's fetch throws, as a driver passes it on.
  const dns = notReached("Bedrock", thrown("getaddrinfo EAI_AGAIN bedrock-runtime.example", "EAI_AGAIN"));
  const closed = notReached("Bedrock", thrown("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()", "ECONNRESET"));
  const refused = notReached("Local", thrown("Unable to connect. Is the computer able to access the url?", "ConnectionRefused"));
  const tls = notReached("Local", thrown("self signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT"));
  for (const e of [dns, closed, refused, tls]) {
    expect(e.kind).toBe("unreachable");
    expect(unreachable(e)).toBe(true);
    expect(retryable(e)).toBe(true);
    expect(errorClass(e)).toBe("unreachable");
  }
  // The runtime's code goes with words that do not say it.
  expect(refused.message).toBe("Local: Unable to connect. Is the computer able to access the url? (ConnectionRefused)");
  expect(dns.message).toBe("Bedrock: getaddrinfo EAI_AGAIN bedrock-runtime.example");
  // A failure that is not a driver's (a plugin's, an agent's): by its words.
  expect(unreachable(new Error("connect ECONNREFUSED 127.0.0.1:11434"))).toBe(true);
  expect(unreachable(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe(true);
  expect(unreachable(Object.assign(new Error("Connection error."), { name: "APIConnectionError" }))).toBe(true);
  expect(unreachable(new ProviderError("network", "plugin x: connect ETIMEDOUT 10.0.0.1:443"))).toBe(true);

  // A stream that began and broke, or went silent: the counted retries, not the wait.
  const broke = new ProviderError("network", "Bedrock: the stream broke: The socket connection was closed unexpectedly");
  const silent = new ProviderError("network", "Bedrock: no data from the model for 300 s; the stream was cut");
  const ws = new ProviderError("network", "ChatGPT: the socket closed during the answer");
  for (const e of [broke, silent, ws]) {
    expect(unreachable(e)).toBe(false);
    expect(retryable(e)).toBe(true);
    expect(errorClass(e)).toBe("stream_drop");
  }
  // What the provider itself answered, and what waiting never heals.
  expect(unreachable(new ProviderError("rate", "429", 429))).toBe(false);
  expect(unreachable(new ProviderError("auth", "expired token: connection refused by policy", 401))).toBe(false);
  expect(unreachable(new ProviderError("invalid", "bad request", 400))).toBe(false);
  expect(unreachable(new ProviderError("context", "prompt is too long", 400))).toBe(false);
  expect(unreachable(new ProviderError("cancelled", "cancelled"))).toBe(false);
  expect(unreachable(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
  expect(unreachable(new TypeError("cannot read properties of undefined"))).toBe(false);
  expect(unreachable({ status: 500, message: "connection reset by upstream" })).toBe(false);
});

// The page loads the failure classes, and with them this file: it may use nothing a browser lacks.
test("the classification imports nothing and reads nothing of the machine", () => {
  const src = readFileSync(join(import.meta.dir, "unreachable.ts"), "utf8");
  expect(src).not.toMatch(/^import /m);
  expect(src).not.toMatch(/\bprocess\.|\bBun\.|require\(/);
  const classes = readFileSync(join(import.meta.dir, "../admin/classes.ts"), "utf8");
  expect(classes).not.toMatch(/^import .*providers\/outage\.ts/m);
});

test("a gateway's own 502, 503 or 504 is unreachable; the provider's own 5xx is not", () => {
  const h = new Headers();
  const broker = classify("Bedrock", 502, h, JSON.stringify({ message: "the Bedrock broker could not reach bedrock-runtime.us-east-1.amazonaws.com: EAI_AGAIN" }));
  expect(broker.kind).toBe("unreachable");
  expect(broker.status).toBe(502);
  expect(unreachable(broker)).toBe(true);
  expect(errorClass(broker)).toBe("unreachable");
  expect(classify("X", 502, h, "<html><body><h1>502 Bad Gateway</h1></body></html>").kind).toBe("unreachable");
  expect(classify("X", 504, h, "").kind).toBe("unreachable");
  expect(classify("X", 503, h, "upstream connect error or disconnect/reset before headers. reset reason: connection failure").kind).toBe("unreachable");
  // The provider's own words.
  expect(classify("X", 503, h, JSON.stringify({ error: { message: "The server is overloaded or not ready yet." } })).kind).toBe("overloaded");
  expect(classify("X", 502, h, JSON.stringify({ error: { type: "api_error", message: "Internal server error" } })).kind).toBe("server");
  expect(classify("X", 529, h, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).kind).toBe("overloaded");
  expect(classify("X", 500, h, "").kind).toBe("server");
  expect(gatewayDown(500, "getaddrinfo EAI_AGAIN")).toBe(false);
  // The class of a failure read back from the words that were stored.
  expect(errorClass({ message: "Bedrock: HTTP 502: the Bedrock broker could not reach bedrock-runtime: EAI_AGAIN" })).toBe("unreachable");
  expect(errorClass({ message: "Bedrock: the stream broke: The socket connection was closed unexpectedly" })).toBe("stream_drop");
});

test("only a request that never left the machine is safe for a call that must not go twice", () => {
  expect(neverSent(thrown("getaddrinfo EAI_AGAIN auth.example", "EAI_AGAIN"))).toBe(true);
  expect(neverSent(thrown("Unable to connect. Is the computer able to access the url?", "ConnectionRefused"))).toBe(true);
  // A reset may come after the request was read.
  expect(neverSent(thrown("The socket connection was closed unexpectedly.", "ECONNRESET"))).toBe(false);
  expect(neverSent(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }))).toBe(false);
});

test("quick tries first, then one every 15 to 30 s; waiting requests go within a few seconds", () => {
  expect([0, 1, 2, 3].map((n) => outageDelayMs(n))).toEqual([1_000, 2_000, 4_000, 8_000]);
  expect(outageDelayMs(4, () => 0)).toBe(15_000);
  expect(outageDelayMs(4, () => 1)).toBe(30_000);
  for (let i = 0; i < 50; i++) {
    const d = outageDelayMs(4 + i);
    expect(d).toBeGreaterThanOrEqual(15_000);
    expect(d).toBeLessThanOrEqual(30_000);
  }
  expect(staggerGapMs(1)).toBe(0);
  expect(staggerGapMs(12)).toBe(250);
  // However many wait, the last goes within the spread.
  expect(staggerGapMs(101) * 100).toBeLessThanOrEqual(OUTAGE.spreadMs);
  expect(OUTAGE.maxMs).toBe(7 * 86_400_000);
});

// Milliseconds instead of seconds: the same steps, a thousand times faster.
const FAST = { quickMs: [10, 10, 10, 10], slowMinMs: 20, slowMaxMs: 30, probeMs: 200, canaryMs: 60, staggerMs: 10, spreadMs: 100, maxMs: 60_000, carryMs: 60_000 };
const gone = () => notReached("P", thrown("getaddrinfo EAI_AGAIN p.example", "EAI_AGAIN"));
const never = new AbortController().signal;

test("twelve sessions of one provider share one wait: one probe at a time, none sends, all go when it answers", async () => {
  let up = false;
  let probes = 0;
  const events: string[] = [];
  const o = new Outages({ timing: FAST, probe: async () => { probes++; if (!up) throw gone(); } });
  o.listen({
    open: (x) => events.push(`open ${x.sessions.length}`),
    close: (x, _ms, answered) => events.push(`close ${answered}`),
  });
  const went: number[] = [];
  const t0 = Date.now();
  const waits = Array.from({ length: 12 }, (_, i) => o.wait("p", gone(), never, { session: `s${i}` }).then(() => void went.push(Date.now() - t0)));
  expect(o.of("s3")?.provider).toBe("p");
  expect(o.list()).toHaveLength(1);
  await Bun.sleep(150);
  // The provider is still gone: nobody was let through, and the probes are the wait's own, not twelve sessions'.
  expect(went).toHaveLength(0);
  expect(probes).toBeGreaterThanOrEqual(4);
  expect(probes).toBeLessThanOrEqual(9);
  expect(events).toEqual(["open 12"]); // said once, after the second failed try
  up = true;
  // The next probe passes and one request goes; the rest wait for its answer.
  while (!went.length) await Bun.sleep(5);
  await Bun.sleep(20);
  expect(went).toHaveLength(1);
  o.answered("p");
  await Promise.all(waits);
  expect(went).toHaveLength(12);
  // Spread out, not at one instant, and all within the spread.
  const after = went.slice(1).sort((a, b) => a - b);
  expect(after.at(-1)! - after[0]!).toBeGreaterThanOrEqual(40);
  expect(after.at(-1)! - after[0]!).toBeLessThanOrEqual(400);
  expect(events).toEqual(["open 12", "close true"]);
  expect(o.of("s3")).toBeUndefined();
  expect(o.list()).toHaveLength(0);
});

test("a blip says nothing; a request let through that fails keeps the others waiting", async () => {
  const events: string[] = [];
  // No probe (an endpoint with no listing): the first waiting request is the try.
  const o = new Outages({ timing: FAST });
  o.listen({ open: () => events.push("open"), close: () => events.push("close") });
  const a = o.wait("p", gone(), never, { session: "a" });
  await a; // let through after the first quick wait
  o.answered("p");
  expect(events).toEqual([]); // one failure and one good retry: not an outage

  let bWent = false;
  const b = o.wait("p", gone(), never, { session: "b" }).then(() => { bWent = true; });
  const a2 = o.wait("p", gone(), never, { session: "a" });
  await Promise.race([a2, b]); // one of the two is let through
  const first = bWent ? "b" : "a";
  await Bun.sleep(5);
  // It fails again: it waits again, and the other one was never let through meanwhile.
  const again = o.wait("p", gone(), never, { session: first });
  expect(o.list()[0]!.tries).toBe(1);
  await Promise.race([again, a2, b]);
  o.answered("p");
  await Promise.all([again, a2, b]);
  expect(o.list()).toHaveLength(0);
});

test("a stop leaves the wait at once; the last one to leave ends it; the ceiling fails with the failure itself", async () => {
  const closed: boolean[] = [];
  const o = new Outages({ timing: FAST, probe: async () => { throw gone(); } });
  o.listen({ close: (_x, _ms, answered) => closed.push(answered) });
  const stop = new AbortController();
  const w = o.wait("p", gone(), stop.signal, { session: "a" });
  const t0 = Date.now();
  await Bun.sleep(40); // confirmed by now
  stop.abort();
  await expect(w).rejects.toMatchObject({ name: "AbortError" });
  expect(Date.now() - t0).toBeLessThan(80);
  expect(o.of("a")).toBeUndefined();
  expect(o.list()).toHaveLength(0);
  expect(closed).toEqual([false]);
  await expect(o.wait("p", gone(), stop.signal)).rejects.toMatchObject({ name: "AbortError" });

  // The ceiling: a wait that has lasted this long ends with what the request failed with.
  let now = 1_000_000;
  const old = new Outages({ timing: { ...FAST, maxMs: 500 }, probe: async () => { throw gone(); }, now: () => now });
  const failure = gone();
  const held = old.wait("p", failure, never, { session: "a" });
  now += 600;
  await expect(held).rejects.toBe(failure);
  expect(old.list()).toHaveLength(0);
});

test("an outage open when the daemon stopped keeps its start in the next one, and ends when the provider answers", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "keel-outage-")), "provider-outages.json");
  const first = new Outages({ timing: FAST, file, probe: async () => { throw gone(); } });
  const closed: boolean[] = [];
  first.listen({ close: (_x, _ms, answered) => closed.push(answered) });
  const stop = new AbortController();
  const w = first.wait("p", gone(), stop.signal, { session: "a" }).catch(() => {});
  await Bun.sleep(60);
  const since = first.of("a")!.since;
  expect(first.of("a")!.confirmed).toBe(true);
  first.stop(); // the daemon stops with the outage open: the turn is parked, not ended
  stop.abort();
  await w;
  expect(closed).toEqual([]); // a parked turn has not stopped waiting: the outage is not said to be over
  const next = new Outages({ timing: FAST, file });
  const seen: Outage[] = [];
  const ended: number[] = [];
  next.listen({ open: (x) => seen.push(x), close: (_x, ms) => ended.push(ms) });
  const again = next.wait("p", gone(), never, { session: "a" });
  expect(next.of("a")!.since).toBe(since);
  expect(next.of("a")!.confirmed).toBe(true);
  await again;
  next.answered("p");
  expect(seen).toEqual([]); // said by the daemon before; not said twice
  expect(ended).toHaveLength(1);
  expect(ended[0]!).toBeGreaterThanOrEqual(60);
});

// The same through the driver, on real sockets: what the runtime's fetch throws is classed where it is thrown.
test("the driver classes a refused connection and a socket closed before a response byte as unreachable, a broken stream as not", async () => {
  const { streamEvents } = await import("./http.ts");
  const run = async (url: string) => {
    try { for await (const _ of streamEvents({ label: "stub", url, headers: {}, body: {}, signal: never })) void _; return null; } catch (e) { return e as ProviderError; }
  };
  const refused = await run("http://127.0.0.1:9/");
  expect(refused?.kind).toBe("unreachable");
  const closer = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { s.end(); }, data() {} } });
  const closed = await run(`http://127.0.0.1:${closer.port}/`);
  closer.stop(true);
  expect(closed?.kind).toBe("unreachable");
  expect(unreachable(closed)).toBe(true);
  // A 200 whose stream then breaks: the answer began.
  const half = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(s) { s.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n"); setTimeout(() => s.end(), 30); } } });
  let began = false;
  const broke = await (async () => {
    try { for await (const _ of streamEvents({ label: "stub", url: `http://127.0.0.1:${half.port}/`, headers: {}, body: {}, signal: never, onAnswer: () => { began = true; } })) void _; return null; } catch (e) { return e as ProviderError; }
  })();
  half.stop(true);
  expect(began).toBe(true);
  expect(broke?.kind).toBe("network");
  expect(unreachable(broke)).toBe(false);
  // A broker's own 502: unreachable, and not an answer of the provider.
  let answered = false;
  const broker = Bun.serve({ port: 0, fetch: () => Response.json({ message: "the broker could not reach the runtime: getaddrinfo EAI_AGAIN" }, { status: 502 }) });
  const gate = await (async () => {
    try { for await (const _ of streamEvents({ label: "stub", url: `http://127.0.0.1:${broker.port}/`, headers: {}, body: {}, signal: never, onAnswer: () => { answered = true; } })) void _; return null; } catch (e) { return e as ProviderError; }
  })();
  broker.stop(true);
  expect(gate?.kind).toBe("unreachable");
  expect(gate?.status).toBe(502);
  expect(answered).toBe(false);
});

// A broker that signs for Keel renews an expired credential itself: the request goes once more, and only for that refusal.
test("a broker's expired credential is retried once after it had time to renew; any other refusal is not", async () => {
  const { AnthropicProvider } = await import("./anthropic.ts");
  let calls = 0;
  let refuse: (n: number) => Response | null = () => null;
  const sse = ['event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}', 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}', 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}', 'event: message_stop\ndata: {"type":"message_stop"}'].join("\n\n") + "\n\n";
  const server = Bun.serve({ port: 0, fetch: () => refuse(++calls) ?? new Response(sse, { headers: { "content-type": "text/event-stream" } }) });
  try {
    const p = new AnthropicProvider("bedrock", { ANTHROPIC_BEDROCK_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1" });
    const ask = () => p.stream({ model: "global.anthropic.claude-test", system: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], signal: never }, () => {});
    refuse = (n) => (n === 1 ? Response.json({ message: "The security token included in the request is expired" }, { status: 403 }) : null);
    const res = await ask();
    expect(res.blocks).toMatchObject([{ type: "text", text: "ok" }]);
    expect(calls).toBe(2);
    // Expired again after the one resend: the refusal stands.
    calls = 0;
    refuse = () => Response.json({ message: "The security token included in the request is expired" }, { status: 403 });
    await expect(ask()).rejects.toMatchObject({ kind: "auth", status: 403 });
    expect(calls).toBe(2);
    // A refusal that names no expiry is not sent again.
    calls = 0;
    refuse = () => Response.json({ message: "User is not authorized to perform bedrock:InvokeModel" }, { status: 403 });
    await expect(ask()).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
  }
}, 15_000);
