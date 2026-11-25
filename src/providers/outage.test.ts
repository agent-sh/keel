// A provider that cannot be reached: which failures are that, the wait's
// numbers, and the one wait every session of a provider shares.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorClass } from "../admin/classes.ts";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { Engine } from "../engine/turn.ts";
import { Providers } from "./registry.ts";
import type { Provider } from "./types.ts";
import { retryable } from "../engine/retry.ts";
import { classify, fetchFailure, ProviderError } from "./http.ts";
import { OUTAGE, Outages, outageDelayMs, staggerGapMs, type Outage } from "./outage.ts";
import { gatewayDown, neverSent, unreachable } from "./unreachable.ts";

const brokerBody = JSON.stringify({ message: "the broker could not reach runtime.example.invalid: EAI_AGAIN" });
const thrown = (message: string, code?: string) => Object.assign(new TypeError(message), code ? { code } : {});

test("only a proved pre-send fetch failure is unreachable", () => {
  // What the runtime's fetch throws, as a driver passes it on.
  const dns = fetchFailure("Bedrock", thrown("getaddrinfo EAI_AGAIN bedrock-runtime.example", "EAI_AGAIN"));
  const closed = fetchFailure("Bedrock", thrown("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()", "ECONNRESET"));
  const refused = fetchFailure("Local", thrown("Unable to connect. Is the computer able to access the url?", "ConnectionRefused"));
  const tls = fetchFailure("Local", thrown("self signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT"));
  for (const e of [dns, refused]) {
    expect(e.kind).toBe("unreachable");
    expect(unreachable(e)).toBe(true);
    expect(retryable(e)).toBe(true);
    expect(errorClass(e)).toBe("unreachable");
  }
  // The runtime's code goes with words that do not say it.
  expect(refused.message).toBe("Local: Unable to connect. Is the computer able to access the url? (ConnectionRefused)");
  expect(dns.message).toBe("Bedrock: getaddrinfo EAI_AGAIN bedrock-runtime.example");
  // Words from a plugin or a raw SDK error do not prove where the request failed.
  expect(unreachable(new Error("connect ECONNREFUSED 127.0.0.1:11434"))).toBe(false);
  expect(unreachable(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe(false);
  const sdk = Object.assign(new Error("Connection error."), { name: "APIConnectionError" });
  expect(unreachable(sdk)).toBe(false);
  expect(retryable(sdk)).toBe(true);
  expect(unreachable(new ProviderError("network", "plugin x: connect ETIMEDOUT 10.0.0.1:443"))).toBe(false);

  // A stream that began and broke, or went silent: the counted retries, not the wait.
  const broke = new ProviderError("network", "Bedrock: the stream broke: The socket connection was closed unexpectedly");
  const silent = new ProviderError("network", "Bedrock: no data from the model for 300 s; the stream was cut");
  const ws = new ProviderError("network", "ChatGPT: the socket closed during the answer");
  for (const e of [closed, broke, silent, ws, tls]) {
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

test("only an explicit upstream connect failure is an outage; ambiguous gateway errors keep counted retries", () => {
  const h = new Headers();
  const broker = classify("Bedrock", 502, h, brokerBody);
  expect(broker.kind).toBe("unreachable");
  expect(broker.status).toBe(502);
  expect(unreachable(broker)).toBe(true);
  expect(errorClass(broker)).toBe("unreachable");
  expect(classify("X", 502, h, "<html><body><h1>502 Bad Gateway</h1></body></html>").kind).toBe("server");
  expect(classify("X", 504, h, "").kind).toBe("server");
  expect(classify("X", 502, h, '{"message":"the broker could not reach runtime.example.invalid: read ECONNRESET"}').kind).toBe("server");
  expect(classify("X", 502, h, '{"message":"response terminated","debug":"the broker could not reach runtime.example.invalid: EAI_AGAIN"}').kind).toBe("server");
  // (A gateway's 503 in its own words is a server fault: the bounded retries, not the wait an overloaded model gets.)
  expect(classify("X", 503, h, "upstream connect error or disconnect/reset before headers. reset reason: connection failure").kind).toBe("server");
  // The provider's own words.
  expect(classify("X", 503, h, JSON.stringify({ error: { message: "The server is overloaded or not ready yet." } })).kind).toBe("overloaded");
  expect(classify("X", 502, h, JSON.stringify({ error: { type: "api_error", message: "Internal server error: connection error" } })).kind).toBe("server");
  expect(classify("X", 502, h, JSON.stringify({ error: JSON.parse(brokerBody) })).kind).toBe("server");
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

test("five-second checks in the first ten minutes, then one every 15 to 30 s", () => {
  expect([0, 1, 2, 3].map((n) => outageDelayMs(n))).toEqual([1_000, 2_000, 4_000, 5_000]);
  expect(outageDelayMs(4, () => 0)).toBe(5_000);
  expect(outageDelayMs(4, () => 0, OUTAGE, OUTAGE.fastForMs)).toBe(15_000);
  expect(outageDelayMs(4, () => 1, OUTAGE, OUTAGE.fastForMs)).toBe(30_000);
  for (let i = 0; i < 50; i++) {
    const d = outageDelayMs(4 + i, Math.random, OUTAGE, OUTAGE.fastForMs);
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
const FAST = { quickMs: [10, 10, 10, 10], fastMs: 25, slowMinMs: 20, slowMaxMs: 30, probeMs: 200, canaryMs: 60, staggerMs: 10, spreadMs: 100, maxMs: 60_000, carryMs: 60_000 };
const gone = () => fetchFailure("P", thrown("getaddrinfo EAI_AGAIN p.example", "EAI_AGAIN"));
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
  expect(o.list()[0]!.tries).toBe(2);
  await Promise.race([again, a2, b]);
  o.answered("p");
  await Promise.all([again, a2, b]);
  expect(o.list()).toHaveLength(0);
});

test("a stop leaves the wait at once; the last one to leave ends it; the ceiling fails with the failure itself", async () => {
  const closed: boolean[] = [];
  let probes = 0;
  const o = new Outages({ timing: FAST, probe: async () => { probes++; throw gone(); } });
  // The wait says it is confirmed when it opens: that is the signal to stop on, not a time.
  const confirmed = Promise.withResolvers<void>();
  o.listen({ open: () => confirmed.resolve(), close: (_x, _ms, answered) => closed.push(answered) });
  const stop = new AbortController();
  const w = o.wait("p", gone(), stop.signal, { session: "a" });
  await confirmed.promise;
  expect(await Promise.race([w.then(() => "left", () => "left"), Promise.resolve("waiting")])).toBe("waiting");
  const before = probes;
  stop.abort();
  await expect(w).rejects.toMatchObject({ name: "AbortError" });
  // Gone with the abort itself: no further probe was made for it, and nothing of it is left to wait for.
  expect(probes).toBe(before);
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
  first.tellParent(first.of("a")!, "parent", 12);
  first.stop(); // the daemon stops with the outage open: the turn is parked, not ended
  stop.abort();
  await w;
  expect(closed).toEqual([]); // a parked turn has not stopped waiting: the outage is not said to be over
  const next = new Outages({ timing: FAST, file });
  const seen: Outage[] = [];
  const ended: number[] = [];
  next.listen({ open: (x) => seen.push(x), close: (_x, ms, _answered, parents) => {
    expect(parents).toEqual([["parent", 12]]);
    ended.push(ms);
  } });
  expect(next.carriedWait("a")?.at).toBe(since);
  const again = next.wait("p", gone(), never, { session: "a" });
  expect(next.of("a")!.since).toBe(since);
  expect(next.of("a")!.confirmed).toBe(true);
  await again;
  next.answered("p");
  expect(seen).toEqual([]); // said by the daemon before; not said twice
  expect(ended).toHaveLength(1);
  expect(ended[0]!).toBeGreaterThanOrEqual(60);
});

test("a flapping provider keeps its schedule, then gets quick checks after a quiet period", async () => {
  let now = 1000;
  const o = new Outages({ timing: { ...FAST, flapMs: 1000, quickMs: [1, 2], fastMs: 12 }, now: () => now });
  const one = async (tries: number) => {
    const waiting = o.wait("p", gone(), never, { session: "s" });
    expect(o.of("s")?.tries).toBe(tries);
    await waiting;
    o.answered("p");
    now += 10;
  };
  await one(0);
  await one(1);
  await one(2);
  now += 1001;
  await one(0);
  o.stop();
});

test("only an API response takes a waiting turn through a captive portal", async () => {
  const { getJson, streamEvents } = await import("./http.ts");
  let mode = "html", followed = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname === "/login") { followed++; return new Response("not an API"); }
    const page = " \n<!doctype html><title>Sign in</title>";
    if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "/login" } });
    if (mode === "auth") return new Response(page, { status: 401 });
    if (mode === "json-auth") return Response.json({ error: { message: "sign in" } }, { status: 401 });
    if (mode === "api") return Response.json({ models: [] });
    if (mode === "not-json") return new Response("not a listing");
    return new Response(page, { headers: { "content-type": mode === "html" ? "text/html" : "text/plain" } });
  } });
  const url = `http://127.0.0.1:${server.port}/`;
  const list = () => getJson("stub", url, {});
  const outages = new Outages({ timing: FAST, probe: list });
  const ctl = new AbortController();
  let answered = 0, released = 0;
  const turns = Array.from({ length: 3 }, (_, n) => outages.wait("p", gone(), ctl.signal, { session: String(n) }).then(() => released++, () => {}));
  try {
    for (const shape of ["html", "unlabelled", "redirect", "auth", "json-auth", "not-json"]) {
      mode = shape;
      const stream = streamEvents({ label: "stub", url, body: {}, headers: {}, signal: ctl.signal, onAnswer: () => answered++ });
      const result = await stream.next().catch((e) => e);
      if (shape === "json-auth") expect(result).toMatchObject({ kind: "auth" });
      else if (shape !== "not-json") expect(result).toMatchObject({ kind: "unreachable" });
      await expect(list()).rejects.toThrow();
      await Bun.sleep(30);
      expect(released).toBe(0);
    }
    expect(answered).toBe(0);
    expect(followed).toBe(0);
    mode = "api";
    await Promise.race(turns);
    expect(released).toBe(1);
    outages.answered("p");
    await Promise.all(turns);
    expect(released).toBe(3);
  } finally {
    ctl.abort();
    outages.stop();
    server.stop(true);
  }
});

// The same through the driver, on real sockets: what the runtime's fetch throws is classed where it is thrown.
test("the driver separates a refused connection and explicit broker DNS failure from a closed socket or broken stream", async () => {
  const { streamEvents } = await import("./http.ts");
  const run = async (url: string) => {
    try { for await (const _ of streamEvents({ label: "stub", url, headers: {}, body: {}, signal: never })) void _; return null; } catch (e) { return e as ProviderError; }
  };
  const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = free.port;
  free.stop(true);
  const refused = await run(`http://127.0.0.1:${port}/`);
  expect(refused?.kind).toBe("unreachable");
  const closer = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { s.end(); }, data() {} } });
  const closed = await run(`http://127.0.0.1:${closer.port}/`);
  closer.stop(true);
  expect(closed?.kind).toBe("network");
  expect(unreachable(closed)).toBe(false);
  // A 200 whose stream then breaks: the answer began.
  const half = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(s) { s.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\nd\r\ndata: hello\n\n\r\n"); setTimeout(() => s.end(), 30); } } });
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
  const broker = Bun.serve({ port: 0, fetch: () => new Response(brokerBody, { status: 502, headers: { "content-type": "application/json" } }) });
  const gate = await (async () => {
    try { for await (const _ of streamEvents({ label: "stub", url: `http://127.0.0.1:${broker.port}/`, headers: {}, body: {}, signal: never, onAnswer: () => { answered = true; } })) void _; return null; } catch (e) { return e as ProviderError; }
  })();
  broker.stop(true);
  expect(gate?.kind).toBe("unreachable");
  expect(gate?.status).toBe(502);
  expect(answered).toBe(false);
});

for (const restart of [false, true]) test(`a broker wait does not refill counted retries (${restart ? "park and resume" : "same turn"})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-retry-budget-"));
  const store = new Store(dir);
  const model = { model: "fixture", context: 100_000, output: 1000, tools: false };
  let asked = 0;
  const waits: unknown[] = [];
  const p: Provider = {
    id: "local", family: "other", available: () => true, list: async () => [model],
    stream: async (req, delta) => {
      const h = new Headers({ "retry-after-ms": "1" });
      switch (++asked) {
        case 2: throw classify("stub", 502, h, brokerBody);
        case 3:
          req.onAnswer?.();
          delta({ kind: "text", index: 0, text: "partial" });
          // Even a claimed pre-send error is not one after the reply began.
          throw gone();
        case 12: throw new ProviderError("invalid", "went past the retry budget");
        default: throw classify("stub", 504, h, "Gateway timeout");
      }
    },
  };
  const providers = new Providers(dir, { providers: [p] });
  providers.catalog.load = async () => {}; // No external catalog or model requests.
  let waiting!: () => void;
  const entered = new Promise<void>((resolve) => { waiting = resolve; });
  providers.outages.wait = async (_provider, error, signal) => {
    waits.push(error);
    waiting();
    if (restart) await new Promise((_, reject) => signal.addEventListener("abort", reject, { once: true }));
  };
  try {
    const errors = { capture: (_: string, e: Error) => ({ message: e.message }) };
    const makeEngine = () => new Engine(store, new Bus(), providers, errors as any, join(dir, "spill"));
    let engine = makeEngine();
    const s = store.createSession({ title: "Fixture", model: `${p.id}:${model.model}`, workspace: dir });
    engine.send(s.id, "hello");
    if (restart) {
      await entered;
      await engine.park();
      engine = makeEngine();
      engine.resume(s.id);
    }
    await engine.idle(s.id);
    expect(waits).toEqual([expect.objectContaining({ kind: "unreachable", status: 502 })]);
    expect(asked).toBe(11); // Ten counted failures and one proved pre-send failure.
    expect(store.events(s.id).find((e) => e.kind === "error")?.data).toMatchObject({ kind: "server", status: 504 });
  } finally {
    providers.shutdown();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const openssl = Bun.which("openssl");
test.skipIf(!openssl)("a self-signed loopback certificate keeps the counted retry path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-loopback-tls-"));
  const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
  try {
    const made = Bun.spawnSync([openssl!, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "ignore" });
    expect(made.exitCode).toBe(0);
    let sent = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) }, fetch() { sent++; return new Response("unexpected request"); } });
    try {
      const { streamEvents } = await import("./http.ts");
      const reply = streamEvents({ label: "stub", url: `https://127.0.0.1:${server.port}/`, body: {}, headers: {}, signal: never });
      const err = await reply.next().catch((e) => e);
      expect(err).toMatchObject({ kind: "network" });
      expect(unreachable(err)).toBe(false);
      expect(retryable(err)).toBe(true);
      expect(sent).toBe(0);
    } finally {
      server.stop(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sse = ['event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}', 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}', 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}', 'event: message_stop\ndata: {"type":"message_stop"}'].join("\n\n") + "\n\n";

test("healthy first headers can take 12 or 30 seconds without a second model request", async () => {
  const { httpEvents, runEvents, ctxFor } = await import("./drive.ts");
  const { anthropicWire } = await import("./wires/anthropic.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-slow-first-"));
  const store = new Store(dir);
  const bus = new Bus();
  const model = { model: "fixture", context: 100_000, output: 1000, tools: false };
  const requests = new Map<number, number>();
  const ctl = new AbortController();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
    const delay = Number(new URL(req.url).pathname.slice(1));
    requests.set(delay, (requests.get(delay) ?? 0) + 1);
    await Promise.race([Bun.sleep(delay), new Promise((ok) => ctl.signal.addEventListener("abort", ok, { once: true }))]);
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  } });
  const delays = new Map<string, number>();
  const provider: Provider = {
    id: "local", family: "other", available: () => true, list: async () => [model],
    stream: (req, delta) => runEvents(anthropicWire, req, ctxFor("local", req, []), delta, httpEvents({
      label: "stub", url: `http://127.0.0.1:${server.port}/${delays.get(req.sessionKey!)}`, headers: {}, idleMs: 40_000,
    }, req)),
  };
  const providers = new Providers(dir, { providers: [provider] });
  providers.catalog.load = async () => {};
  const engine = new Engine(store, bus, providers, new ErrorTracker(store, bus), join(dir, "spill"));
  try {
    // A healthy provider should not enter the outage path even once.
    let unexpected!: () => void;
    const waiting = new Promise<"wait">((resolve) => { unexpected = () => resolve("wait"); });
    providers.outages.listen({ waiting: (_id, o) => { if (o) unexpected(); } });
    const sessions = [12_000, 30_000].map((delay) => {
      const s = store.createSession({ title: "Fixture", model: `${provider.id}:${model.model}`, workspace: dir });
      delays.set(s.id, delay);
      engine.send(s.id, "hello");
      return s.id;
    });
    expect(await Promise.race([waiting, Promise.all(sessions.map((id) => engine.idle(id))).then(() => "done")])).toBe("done");
    expect([...requests].sort()).toEqual([[12_000, 1], [30_000, 1]]);
    for (const id of sessions) expect(store.events(id).find((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
  } finally {
    await engine.drain(0);
    ctl.abort();
    providers.shutdown();
    server.stop(true);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);

test("307 and 308 preserve API requests on the same origin, not across hosts", async () => {
  const { streamEvents, getJson } = await import("./http.ts");
  const requests: { method: string; auth: string | null; body: string }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/307" || u.pathname === "/308") return new Response(null, { status: Number(u.pathname.slice(1)), headers: { location: "/api" } });
    if (u.pathname === "/external") return new Response(null, { status: 307, headers: { location: `http://localhost:${u.port}/api` } });
    requests.push({ method: req.method, auth: req.headers.get("authorization"), body: await req.text() });
    return req.method === "GET" ? Response.json({ models: [] }) : new Response(sse);
  } });
  const url = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: "Bearer fixture" };
  const post = async (path: string) => {
    const events = [];
    for await (const e of streamEvents({ label: "stub", url: url + path, headers, body: { test: true }, signal: never })) events.push(e);
    return events;
  };
  try {
    for (const path of ["/307", "/308"]) {
      expect(await getJson("stub", url + path, headers)).toEqual({ models: [] });
      expect(await post(path)).not.toHaveLength(0);
    }
    await expect(post("/external")).rejects.toMatchObject({ kind: "unreachable", status: 307 });
    expect(requests).toEqual(["GET", "POST", "GET", "POST"].map((method) => ({ method, auth: headers.authorization, body: method === "GET" ? "" : '{"test":true}' })));
  } finally { server.stop(true); }
});

test("a listing timeout is recovered by its own provider, not another one", async () => {
  const { getJson } = await import("./http.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-listing-recovery-"));
  const store = new Store(dir);
  const errors = new ErrorTracker(store, new Bus());
  let ready = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    if (!ready) await Bun.sleep(80);
    return Response.json([]);
  } });
  const p: Provider = { id: "slow", family: "other", available: () => true, stream: async () => { throw new Error("unused"); },
    list: () => getJson("stub", `http://127.0.0.1:${server.port}/`, {}, [], Date.now() + (ready ? 1000 : 20)),
  };
  const providers = new Providers(dir, {
    providers: [p, { ...p, id: "other", list: async () => [] }],
    capture: (source, error, ctx, at) => errors.capture(source, error, ctx, at),
    recover: (group) => errors.recoverGroup("provider", group),
  });
  providers.catalog.load = async () => {};
  try {
    await providers.refresh("slow");
    const row = errors.list().find((e) => e.message.includes("listing timed out"));
    expect(row).toBeDefined();
    expect(row?.recovered_ts).toBeUndefined();
    await providers.refresh("other");
    expect(errors.get(row!.id)?.recovered_ts).toBeUndefined();
    ready = true;
    await providers.refresh("slow");
    expect(errors.get(row!.id)?.recovered_ts).toBeGreaterThanOrEqual(row!.ts);
    expect(errors.get(row!.id)?.read_ts).toBeTruthy();
  } finally {
    providers.shutdown();
    server.stop(true);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a waiting Bedrock turn follows its broker to a new loopback port", async () => {
  const { AnthropicProvider } = await import("./anthropic.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-broker-move-"));
  const file = join(dir, "broker.env");
  const before = process.env.KEEL_PROVIDER_ENV_FILE;
  process.env.KEEL_PROVIDER_ENV_FILE = file;
  const key = "ANTHROPIC_BEDROCK_BASE_URL";
  const model = "global.anthropic.claude-fixture";
  const calls: string[] = [];
  const serve = (name: string) => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.method === "GET") return Response.json({ inferenceProfileSummaries: [{ status: "ACTIVE", inferenceProfileId: model }] });
    // Re-reading the file must not change the credentials of the running provider.
    calls.push(`${name}:${req.headers.get("authorization") ?? "none"}`);
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  } });
  const a = serve("old");
  const b = serve("new");
  const portA = a.port!, portB = b.port!;
  const base = (port: number) => `http://127.0.0.1:${port}`;
  const write = (port: number) => writeFileSync(file, `${key}='${base(port)}'\nAWS_BEARER_TOKEN_BEDROCK=unused-fixture-value\nOPENAI_BASE_URL=http://127.0.0.1:1\n`);
  const store = new Store(dir);
  const bus = new Bus();
  const errors = new ErrorTracker(store, bus);
  const driver = new AnthropicProvider("bedrock", { [key]: base(portA), CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1" });
  const providers = new Providers(dir, { providers: [driver], capture: (source: "provider", err: unknown, ctx?: unknown, at?: Parameters<ErrorTracker["capture"]>[3]) => errors.capture(source, err, ctx, at) });
  // Local fixture only, including model discovery.
  providers.catalog.load = async () => {};
  const engine = new Engine(store, bus, providers, errors, join(dir, "spill"));
  const session = store.createSession({ title: "Fixture", model: `${driver.id}:${model}`, workspace: dir });
  let entered!: () => void;
  const waiting = new Promise<void>((ok) => { entered = ok; });
  providers.outages.listen({ open: () => entered() });
  try {
    write(portA);
    engine.send(session.id, "first");
    await engine.idle(session.id);
    expect(calls).toEqual(["old:none"]);
    a.stop(true);
    engine.send(session.id, "second");
    await Promise.race([waiting, Bun.sleep(5_000).then(() => { throw new Error("no outage after the first probes"); })]);
    expect(engine.outageOf(session.id)?.provider).toBe(driver.id);
    const t0 = Date.now();
    write(portB);
    await Promise.race([engine.idle(session.id), Bun.sleep(11_000).then(() => { throw new Error("turn still calls the retired port"); })]);
    expect(calls).toEqual(["old:none", "new:none"]);
    expect(store.events(session.id).filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["end_turn", "end_turn"]);
    const rows = errors.list().filter((e) => e.message.includes("the broker moved"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ message: `the broker moved from port ${portA} to port ${portB}`, count: 1, context: { provider: driver.id } });
    expect(rows[0]!.recovered_ts).toBeGreaterThanOrEqual(t0);
    expect(process.env[key]).not.toBe(base(portB));
    console.info(`loopback broker switch: ${Date.now() - t0} ms from write to completed turn`);
  } finally {
    await engine.drain(0);
    providers.shutdown();
    a.stop(true);
    b.stop(true);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
    if (before === undefined) delete process.env.KEEL_PROVIDER_ENV_FILE;
    else process.env.KEEL_PROVIDER_ENV_FILE = before;
  }
}, 20_000);

// A broker that signs for Keel renews an expired credential itself: the request goes once more, and only for that refusal.
test("a broker's expired credential is retried once after it had time to renew; any other refusal is not", async () => {
  const { AnthropicProvider } = await import("./anthropic.ts");
  let calls = 0;
  let refuse: (n: number) => Response | null = () => null;
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
