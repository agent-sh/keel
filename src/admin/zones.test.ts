import { expect, test } from "bun:test";
import { ProviderError } from "../providers/http.ts";
import { errorClass } from "./classes.ts";
import { scaleZones, zoneBytes, zoneCache } from "./zones.ts";

const msg = (role: "user" | "assistant", text: string) => ({ role, content: [{ type: "text" as const, text }] });

test("the history the previous request carried is frozen; what is new is the tail", () => {
  const tools = [{ name: "Read", description: "read a file", input_schema: {} }];
  const first = zoneBytes({ tools, system: "sys", messages: [msg("user", "hi")] }, []);
  expect(first.bytes.history).toBe(0); // a first request is all tail
  const second = zoneBytes({ tools, system: "sys", messages: [msg("user", "hi"), msg("assistant", "hello"), msg("user", "more")] }, first.sizes);
  expect(second.bytes.history).toBe(first.sizes[0]!);
  expect(second.bytes.tail).toBe(second.sizes[1]! + second.sizes[2]!);
  // A rewritten first message (a compaction) is not frozen.
  const third = zoneBytes({ tools, system: "sys", messages: [msg("user", "summary of it all"), msg("user", "next")] }, second.sizes);
  expect(third.bytes.history).toBe(0);
  // An image counts as a fixed size, not its base64.
  const img = zoneBytes({ tools, system: "", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(500_000) } }] } as any] }, []);
  expect(img.bytes.tail).toBeLessThan(7_000);
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
  expect(errorClass(new Error("read ECONNRESET"))).toBe("stream_drop");
  expect(errorClass(new Error("something odd"))).toBe("other");
});
