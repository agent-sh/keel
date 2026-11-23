import { expect, test } from "bun:test";
import { ProviderError } from "../providers/http.ts";
import { classOfText, errorClass } from "./classes.ts";
import { join } from "node:path";
import { messageSizes, scaleZones, zoneBytes, zoneCache } from "./zones.ts";

const msg = (role: "user" | "assistant", text: string) => ({ role, content: [{ type: "text" as const, text }] });

test("the history the previous request carried is frozen; what is new is the tail", () => {
  const tools = [{ name: "Read", description: "read a file", input_schema: {} }];
  const first = zoneBytes({ tools, system: "sys", messages: [msg("user", "hi")] }, []);
  expect(first.bytes.history).toBe(0); // a first request is all tail
  const second = zoneBytes({ tools, system: "sys", messages: [msg("user", "hi"), msg("assistant", "hello"), msg("user", "more")] }, first.marks);
  expect(second.bytes.history).toBe(first.sizes[0]!);
  expect(second.bytes.tail).toBe(second.sizes[1]! + second.sizes[2]!);
  // A rewritten first message (a compaction) is not frozen.
  const third = zoneBytes({ tools, system: "sys", messages: [msg("user", "summary of it all"), msg("user", "next")] }, second.marks);
  expect(third.bytes.history).toBe(0);
  // An image counts as a fixed size, not its base64.
  const img = zoneBytes({ tools, system: "", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(500_000) } }] } as any] }, []);
  expect(img.bytes.tail).toBeLessThan(7_000);
  // A first message edited to another text of the same length is not frozen either.
  const a = zoneBytes({ tools, system: "", messages: [msg("user", "Depot A"), msg("assistant", "ok")] }, []);
  const b = zoneBytes({ tools, system: "", messages: [msg("user", "Depot B"), msg("assistant", "ok"), msg("user", "Continue")] }, a.marks);
  expect(b.bytes.history).toBe(0);
  const c = zoneBytes({ tools, system: "", messages: [msg("user", "Depot A"), msg("assistant", "ok"), msg("user", "Continue")] }, a.marks);
  expect(c.bytes.history).toBe(a.sizes[0]! + a.sizes[1]!);
});

test("no zone gets a negative share, and an empty zone gets nothing", () => {
  for (let prompt = 1; prompt < 40; prompt++)
    for (const bytes of [{ tools: 1, system: 1, history: 0, tail: 0 }, { tools: 3, system: 2, history: 0, tail: 1 }, { tools: 5, system: 5, history: 5, tail: 0 }]) {
      const z = scaleZones(bytes, prompt);
      expect(z.tools + z.system + z.history + z.tail).toBe(prompt);
      for (const k of ["tools", "system", "history", "tail"] as const) {
        expect(z[k]).toBeGreaterThanOrEqual(0);
        if (!bytes[k]) expect(z[k]).toBe(0);
      }
    }
});

test("zones add up to the provider's count, and the cache is laid over them from the front", () => {
  const z = scaleZones({ tools: 400, system: 400, history: 800, tail: 401 }, 1000);
  expect(z.tools + z.system + z.history + z.tail).toBe(1000);
  const c = zoneCache({ tools: 200, system: 200, history: 400, tail: 200 }, { cache_read: 700, cache_write: 250, input: 50 });
  expect(c.tools).toEqual({ tokens: 200, read: 200, written: 0, fresh: 0 });
  expect(c.history).toEqual({ tokens: 400, read: 300, written: 100, fresh: 0 });
  expect(c.tail).toEqual({ tokens: 200, read: 0, written: 150, fresh: 50 });
});

test("failures fall into classes by the driver's kind, the status, then the words", () => {
  expect(errorClass(new ProviderError("rate", "slow down", 429))).toBe("rate_limit");
  expect(errorClass(new ProviderError("network", "the stream went silent"))).toBe("stream_drop");
  expect(errorClass(new ProviderError("context", "prompt is too long", 400))).toBe("context_overflow");
  expect(errorClass(new ProviderError("cancelled", "cancelled"))).toBeNull();
  expect(errorClass(Object.assign(new Error("nope"), { status: 401 }))).toBe("auth");
  expect(errorClass(Object.assign(new Error("Overloaded"), { status: 529 }))).toBe("overloaded");
  expect(errorClass(Object.assign(new Error("input is too long for the context window"), { status: 400 }))).toBe("context_overflow");
  // A reset without an answer is still ambiguous: the request may have reached the provider.
  expect(errorClass(new Error("read ECONNRESET"))).toBe("stream_drop");
  expect(errorClass(new Error("the stream broke: read ECONNRESET"))).toBe("stream_drop");
  expect(errorClass(new Error("something odd"))).toBe("other");
  // A connection that never opened is not a stream that dropped: the box says the provider could not be reached.
  expect(errorClass(new ProviderError("network", "Lab: Unable to connect. Is the computer able to access the url?"))).toBe("unreachable");
  expect(errorClass(new ProviderError("network", "Bedrock: getaddrinfo EAI_AGAIN bedrock-runtime.example"))).toBe("unreachable");
  expect(classOfText("Lab (local fake): Unable to connect. Is the computer able to access the url? (the provider asked to wait until 20:08 UTC+02:00, longer than a turn waits)")).toBe("unreachable");
  expect(errorClass(new ProviderError("network", "Lab: the stream broke: The socket connection was closed unexpectedly."))).toBe("stream_drop");
  expect(classOfText("HTTP 429: Scripted: 429 rate limited, retry after 1 min")).toBe("rate_limit");
  // A provider names itself before the status ("Amazon Bedrock: HTTP 503: ..."): the status is still read.
  expect(classOfText("Amazon Bedrock: HTTP 503: Bedrock is unable to process your request.")).toBe("server");
  expect(classOfText("Amazon Bedrock: HTTP 429: Too many requests")).toBe("rate_limit");
  // The caller's own stop is decided by its signal, not here: an abort the
  // driver tagged, or one of no known origin, is a failure of the call.
  expect(errorClass(Object.assign(new Error("deadline"), { name: "AbortError", kind: "network" }))).toBe("stream_drop");
  expect(errorClass(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe("stream_drop");
  expect(errorClass(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe("stream_drop");
});

// A Claude request of this build's tools on the Anthropic wire (recorded in
// test/fixtures/zones/claude-request.json: the eager and deferred built-ins,
// one deferred MCP tool, and a history where a tool search loaded WebFetch).
// The tools zone is what the wire puts in the prompt: its tools without
// defer_loading. The definition the search loaded counts once, with the
// message that holds the tool_reference.
test("deferred tools are in no zone until a tool search loads them", async () => {
  const { anthropicBody } = await import("../providers/wires/anthropic.ts");
  const req = await Bun.file(join(import.meta.dir, "../../test/fixtures/zones/claude-request.json")).json();
  const def = (t: any) => ({ name: t.name, description: t.description, input_schema: t.input_schema });
  const bytes = (v: unknown) => JSON.stringify(v).length;
  const body = anthropicBody({ ...req, signal: new AbortController().signal }, { origin: "anthropic:claude-model", sessionKey: "k", efforts: [] });
  const inPrompt = body.tools.filter((t: any) => !t.defer_loading).map(def);
  expect(inPrompt.length).toBeLessThan(req.tools.length);
  const z = zoneBytes(req, []);
  expect(z.bytes.tools).toBe(bytes(inPrompt));
  // The loaded definition is in the history, with the search's answer, once.
  const webFetch = req.tools.find((t: any) => t.name === "WebFetch");
  expect(z.sizes).toEqual(messageSizes(req.messages).map((n, i) => (i === 2 ? n + bytes(def(webFetch)) : n)));
  // A later request with the same history counts it in the frozen part.
  const next = zoneBytes({ ...req, messages: [...req.messages, msg("assistant", "Version 2 adds a faster index.")] }, z.marks);
  expect(next.bytes.history).toBe(z.sizes.reduce((n, x) => n + x, 0));
  console.log(`tools zone: ${bytes(req.tools.map(def))} bytes counted before, ${z.bytes.tools} after (the request carries ${req.tools.length - inPrompt.length} tools deferred)`);
});
