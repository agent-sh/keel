// A warm request keeps the cache entry the session's next request looks up.
// Its breakpoint sits where the last turn request put its own (the last user
// block before the warm words), so it reads that entry at its breakpoint and
// keeps it; the next request walks back from its own breakpoint and finds it.
// A breakpoint on the warm words instead writes an entry no later request
// looks up, and the one the next request needs lapses behind it. Checked with
// the prompt cache stand-in of test/prompt-cache.ts, under both readings of
// what a read keeps, for a tool step and for a parked session.
import { expect, test } from "bun:test";
import type { Message } from "../core/types.ts";
import type { ProviderRequest } from "../providers/types.ts";
import { anthropicWire } from "../providers/wires/anthropic.ts";
import { PromptCache } from "../../test/prompt-cache.ts";
import { WARM_TEXT, withWarm } from "./cache-plans.ts";

const MIN = 60_000;
const ctx = { origin: "anthropic:m", sessionKey: "s", efforts: [] };
const req = (messages: Message[], purpose: ProviderRequest["purpose"] = "turn"): ProviderRequest => ({
  model: "m", system: `You are a careful agent.\n${"Rules of the house. ".repeat(200)}`, messages, purpose, effort: "high", cacheLife: "short",
  tools: [{ name: "Bash", description: "Run a command.", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
  signal: new AbortController().signal,
});
const body = (messages: Message[], purpose?: ProviderRequest["purpose"]) => anthropicWire.body(req(messages, purpose), ctx) as any;
const text = (t: string) => ({ type: "text" as const, text: t });
const marked = (b: any) => b.messages.flatMap((m: any, i: number) => m.content.flatMap((c: any, j: number) => (c.cache_control ? [[i, j, c.type, c.text ?? c.tool_use_id]] : [])));

// A conversation whose last request was sent and answered.
const asked: Message[] = [
  { role: "user", content: [text(`Build the project.\n${"Notes on the build. ".repeat(400)}`)] },
  { role: "assistant", content: [text("Reading the notes first."), { type: "tool_use", id: "c1", name: "Bash", input: { command: "cat NOTES" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Notes on the notes. ".repeat(300) }] },
];
const step: Message = { role: "assistant", content: [text("Now the long build."), { type: "tool_use", id: "c2", name: "Bash", input: { command: "make" } }] };
const reply: Message = { role: "assistant", content: [text("Started the build; I will look again when it ends.")] };

test("a warm request's breakpoint is the last request's, before its own words", () => {
  const last = body(asked);
  for (const kind of ["tool", "park"] as const) {
    const warm = body(withWarm(kind === "tool" ? asked : [...asked, reply], kind), "warm");
    // The same block as the last turn request's, byte for byte; the warm words after it carry none.
    expect(marked(warm)).toEqual(marked(last));
    expect(marked(last)).toEqual([[2, 0, "tool_result", "c1"]]);
    const words = warm.messages.at(-1).content.at(-1);
    expect(words).toEqual({ type: "text", text: WARM_TEXT });
    // Tools and system keep their own breakpoints: four at most in all.
    expect(warm.tools.filter((t: any) => t.cache_control)).toHaveLength(1);
    expect(warm.system.filter((s: any) => s.cache_control)).toHaveLength(1);
  }
});

// The session's last request at 0, warm requests before the 5 minutes pass, and the next request after
// the wait: a tool step's (its call and result after the last request), or a parked session's (its reply
// and the next prompt).
for (const refresh of ["breakpoint", "any"] as const) {
  for (const kind of ["tool", "park"] as const) {
    test(`a ${kind} wait kept warm is read by the next request (a read keeps ${refresh === "any" ? "every entry it used" : "the entry at its breakpoint"})`, () => {
      const cache = new PromptCache({ refresh });
      const first = cache.send(body(asked), 0);
      expect(first.cache_read).toBe(0);
      const kept = first.cache_write + first.input;
      const history = kind === "tool" ? asked : [...asked, reply];
      const warms = [4 * MIN, 8 * MIN].map((at) => cache.send(body(withWarm(history, kind), "warm"), at));
      const next: Message[] = kind === "tool"
        ? [...asked, step, { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "Built." }] }]
        : [...asked, reply, { role: "user", content: [text("The build ended. What failed?")] }];
      const after = cache.send(body(next), 10 * MIN);
      expect(after.cache_read).toBe(kept);
      // Each warm request read the whole prefix and wrote nothing: its own words are plain input.
      for (const w of warms) expect([w.cache_read, w.cache_write]).toEqual([kept, 0]);
    });
  }
}

// Under the stricter reading one warm request is enough to show it: the next request a minute after the
// lifetime would have passed.
test("one warm request keeps the entry the next request reads", () => {
  const cache = new PromptCache({ refresh: "breakpoint" });
  const kept = ((u) => u.cache_write + u.input)(cache.send(body(asked), 0));
  cache.send(body(withWarm(asked, "tool"), "warm"), 4 * MIN);
  const after = cache.send(body([...asked, step, { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "Built." }] }]), 6 * MIN);
  expect(after.cache_read).toBe(kept);
});
