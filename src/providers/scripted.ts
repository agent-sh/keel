// A scripted stand-in provider for the e2e of the paths a real model cannot be
// made to take on demand: a 429 with retry-after, a 529, a stream that breaks,
// a reply cut at the output limit inside a tool call, pause_turn, a refusal and
// a request too long for the window, refused billing, and a tool long enough
// for a daemon restart to cut. Test-only: it is listed only when the
// daemon starts with KEEL_SCRIPTED_PROVIDER=1.
//
// The owner's prompt picks the scenario with a word `script:<name>`. What a
// request gets depends only on the request and how often that exact request
// was sent before, so a retry sees the next step of the same scenario.
import { appendFileSync } from "node:fs";
import type { Message } from "../core/types.ts";
import { classify, ProviderError } from "./http.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderResult } from "./types.ts";

export const SCRIPTED_ENV = "KEEL_SCRIPTED_PROVIDER";
export const scriptedEnabled = () => process.env[SCRIPTED_ENV] === "1";

// A small window, so a few long replies reach the compaction threshold.
const WINDOW = 8_000;
const OUTPUT = 2_000;
// The strict stand-in counts like a real provider: the whole request (system,
// tools and messages) at 2.5 bytes a token, the ratio of long tool-heavy
// sessions, and refuses one over its window in a provider's own words. Its
// window holds the system prompt and the tools a few times over.
const STRICT = "stand-in-strict";
const STRICT_WINDOW = 80_000;
const STRICT_BYTES = 2.5;

const textOf = (m: Message | undefined) =>
  (m?.content as any[] | undefined)?.filter((b) => b.type === "text").map((b) => b.text).join("\n") ?? "";
const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

export class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly label = "Scripted (test)";
  readonly family = "other" as const;
  private seen = new Map<string, number>();
  private paused = new Map<string, string>();

  available() {
    return scriptedEnabled();
  }

  async list(): Promise<ListedModel[]> {
    const price = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
    return [
      { model: "stand-in", name: "Scripted stand-in", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" } },
      { model: "stand-in-backup", name: "Scripted backup", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" } },
      // Says it reads no images: the composer holds a new screenshot for it.
      { model: STRICT, name: "Scripted strict window", context: STRICT_WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" } },
      { model: "stand-in-text", name: "Scripted text only", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" }, images: false },
    ];
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult> {
    const msgs = req.messages;
    // For specs that compare what was sent across daemon restarts: one line per request.
    if (process.env.KEEL_SCRIPTED_LOG) appendFileSync(process.env.KEEL_SCRIPTED_LOG, JSON.stringify({ ts: Date.now(), session: req.sessionKey, purpose: req.purpose ?? "turn", system: req.system, tools: req.tools.map((t) => t.name), messages: msgs.length }) + "\n");
    const last = msgs.at(-1);
    const lastText = textOf(last);
    // A retry is the same request: system, messages, tools, model and effort, byte for byte.
    const key = String(Bun.hash(JSON.stringify([req.sessionKey, req.model, req.effort, req.system, msgs, req.tools.map((t) => t.name)])));
    const attempt = this.seen.get(key) ?? 0;
    this.seen.set(key, attempt + 1);
    // Everything but the newest message counts as read from cache.
    const usage = { input: tokens(last), cache_read: tokens(msgs.slice(0, -1)) + tokens(req.system) / 8, cache_write: 0, output: 0 };
    usage.cache_read = Math.round(usage.cache_read);
    if (req.model === STRICT) {
      const count = (v: unknown) => Math.ceil(Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v)) / STRICT_BYTES);
      const total = count(req.system) + count(req.tools.map((t: any) => [t.name, t.description, t.input_schema])) + count(msgs);
      if (total > STRICT_WINDOW) throw classify("Scripted", 400, new Headers(), JSON.stringify({ error: { code: 400, message: `The input token count exceeds the maximum number of tokens allowed (${STRICT_WINDOW}); input token count: ${total}.`, status: "INVALID_ARGUMENT" } }));
      usage.input = count(last);
      usage.cache_read = total - usage.input;
    }

    const reply = async (text: string, stop = "end_turn", extra: any[] = []): Promise<ProviderResult> => {
      for (const part of text.match(/.{1,40}/gs) ?? []) {
        onDelta({ kind: "text", index: 0, text: part });
        await Bun.sleep(5);
      }
      usage.output = tokens(text);
      return { blocks: [{ type: "text", text }, ...extra], usage, stop, model: req.model };
    };

    // A history read as a transcript in parts: the summary names the part it reached.
    const part = lastText.match(/^\[harness\] The context is being compacted, .* in (\d+) parts, oldest first; this is part (\d+)\./);
    if (part) return reply(`Goal: the owner is checking a history longer than the window. State: read part ${part[2]} of ${part[1]} of the transcript${lastText.includes("<summary>") ? ", after the summary of the parts before it" : ""}.`);
    if (lastText.includes("[harness] The context is being compacted")) {
      return reply("Goal: the owner is checking how the harness handles provider failures. State: the scripted scenario ran; next, answer the newest prompt.");
    }
    if (req.model === "stand-in-backup") return reply("The backup model took the request.");

    // The owner's newest prompt: the newest user text that is neither a harness
    // note nor a tagged context block (in a summary: the last owner words it kept).
    const own = (m: Message) => (m.content as any[]).filter((b) => b.type === "text").map((b) => {
      const kept = [...String(b.text).matchAll(/<message>\n([\s\S]*?)\n<\/message>/g)].at(-1)?.[1];
      return kept ?? (/^(\[harness\]|<)/.test(b.text) ? "" : b.text);
    }).filter(Boolean).at(-1);
    const owner = [...msgs].reverse().filter((m) => m.role === "user").map(own).find((t) => t !== undefined) ?? "";
    const scenario = owner.match(/script:([a-z-]+)/)?.[1] ?? "";
    const compacted = msgs.some((m) => textOf(m).startsWith("[harness] This conversation was compacted"));

    switch (scenario) {
      case "billing":
        // An account state, not a passing failure: turns are refused until the owner acts.
        throw new ProviderError("quota", "Scripted: your credit balance is too low to make this request. Add credits at https://example.com/billing.", 402);
      case "calls": {
        // `script:calls [{"name":...,"input":...}, ...]`: one call per round, in
        // order, then a reply naming the last result. For specs that need tool
        // calls a real model cannot be made to send exactly.
        const calls = callsAfter(owner);
        const at = msgs.findLastIndex((m) => m.role === "user" && textOf(m).includes("script:calls"));
        const done = msgs.slice(at + 1).filter((m) => m.role === "assistant").length;
        const next = calls[done];
        if (next) return reply(`Step ${done + 1} of ${calls.length}.`, "tool_use", [{ type: "tool_use", id: `call-${msgs.length}-${done}`, name: String(next.name), input: next.input ?? {} }]);
        const lastResult = (last?.content as any[] | undefined)?.find((b) => b.type === "tool_result");
        const said = typeof lastResult?.content === "string" ? lastResult.content : (lastResult?.content as any[] | undefined)?.map((b: any) => b.text ?? "").join("\n") ?? "";
        return reply(`Done with ${calls.length} call${calls.length === 1 ? "" : "s"}.${said ? ` Last result: ${said.slice(0, 300)}` : ""}`);
      }
      case "batch": {
        // `script:batch [{"name":...,"input":...}, ...]`: every call in one reply
        // (a parallel batch), then a reply quoting each result it got back.
        const at = msgs.findLastIndex((m) => m.role === "user" && textOf(m).includes("script:batch"));
        if (!msgs.slice(at + 1).some((m) => m.role === "assistant")) {
          return reply("Running a batch.", "tool_use", callsAfter(owner, "script:batch").map((c, i) => ({ type: "tool_use", id: `batch-${msgs.length}-${i}`, name: String(c.name), input: c.input ?? {} })));
        }
        const got = msgs.slice(at + 1).flatMap((m) => (m.role === "user" ? (m.content as any[]).filter((b) => b.type === "tool_result") : []));
        const said = (b: any) => (typeof b.content === "string" ? b.content : (b.content as any[]).map((c: any) => c.text ?? "").join("\n"));
        return reply(`Batch done. ${got.map((b) => `[${said(b).slice(0, 200)}]`).join(" ")}`);
      }
      case "liar":
        // A worker that says it finished without doing anything, and a judge
        // that believes it: what the independent goal check exists for.
        if (lastText.includes("[harness] Goal check")) return reply('{"verdict": "met", "reason": "The reply says goal.txt holds the word ready."}');
        return reply("Done: goal.txt holds the word ready.");
      case "rate-limit-long":
        throw new ProviderError("rate", "Scripted: 429 rate limited, retry after 15 min", 429, 15 * 60_000);
      case "rate-limit":
        if (attempt === 0) throw new ProviderError("rate", "Scripted: 429 rate limited, retry after 4 s", 429, 4_000);
        return reply("Answered after the rate limit passed.");
      case "overloaded":
        if (attempt < 2) throw new ProviderError("overloaded", "Scripted: 529 overloaded", 529);
        return reply("Answered after the overload passed.");
      case "drop":
        if (attempt === 0) {
          for (const part of ["This half reply ", "is dropped with the stream"]) {
            onDelta({ kind: "text", index: 0, text: part });
            await Bun.sleep(300);
          }
          throw new ProviderError("network", "Scripted: the stream broke");
        }
        return reply("The whole reply, after the dropped stream.");
      case "cut":
        if (lastText.includes("[harness] Your last reply was cut off")) return reply("Part two, continued after the cut.");
        // A whole call, then one the limit cut (its input still parses): only the first runs.
        return reply("Part one of a long answer.", "max_tokens", [
          { type: "tool_use", id: `whole-${msgs.length}`, name: "Bash", input: { command: "echo first-ran" } },
          { type: "tool_use", id: `cut-${msgs.length}`, name: "Bash", input: { command: "echo cut-ran" } },
        ]);
      case "pause": {
        // The continuation is the paused request plus the paused reply, as it was.
        const sent = JSON.stringify(msgs.slice(0, -1));
        if (last?.role === "assistant") {
          const ok = this.paused.get(req.sessionKey ?? "") === sent && textOf(last) === "Paused at a server tool.";
          return reply(ok ? "Resumed after the pause." : "The continuation did not carry the paused reply.");
        }
        this.paused.set(req.sessionKey ?? "", JSON.stringify(msgs));
        return reply("Paused at a server tool.", "pause_turn");
      }
      case "refuse": {
        // `script:refuse <word>`: the partial reply carries the word (a search test looks for it).
        const word = owner.match(/script:refuse\s+(\S+)/)?.[1];
        const r = await reply(word ? `I will not ${word}` : "I will not");
        return { ...r, stop: "refusal", stop_details: { category: "cyber", explanation: "Scripted refusal for the test." } };
      }
      case "overflow":
        if (!compacted) throw new ProviderError("context", "Scripted: prompt is too long: 9000 tokens > 8000 maximum", 400);
        return reply("Answered after compacting to fit.");
      case "deaf":
        // A stream that does not honor the stop for 12 s (a driver or hook that
        // ignores its signal): a delete waits that long for the turn to end.
        await Bun.sleep(12_000);
        return reply("Answered after not listening.");
      case "slow":
        await Bun.sleep(3_000); // no bytes for a while
        return reply("Answered after a slow start.");
      case "quiet":
        // The provider answers at once, then only keeps the connection alive
        // (a thinking model that shows nothing) for a while.
        req.onHeaders?.(new Headers());
        await Bun.sleep(3_000);
        return reply("Answered after a quiet start.");
      case "long-tool":
        // A tool that runs long enough for a restart to cut it.
        if (lastText.includes("[harness] The daemon restarted")) return reply("Continued after the restart.");
        if (last?.role === "user" && (last.content as any[]).some((b) => b.type === "tool_result")) return reply("Finished after the tool.");
        return reply("Running a long command.", "tool_use", [{ type: "tool_use", id: `long-${msgs.length}`, name: "Bash", input: { command: "sleep 30; echo slept" } }]);
      case "render": {
        // A reply that uses what the transcript renders: a table, code that
        // finishes while the rest streams, math, a file link. Slow enough to
        // read the draft while it streams.
        const text = RENDER_REPLY;
        for (const part of text.match(/.{1,24}/gs) ?? []) {
          onDelta({ kind: "text", index: 0, text: part });
          await Bun.sleep(40);
        }
        usage.output = tokens(text);
        return { blocks: [{ type: "text", text }], usage, stop: "end_turn", model: req.model };
      }
      case "grow":
        // About a thousand tokens a turn: the context crosses the preparing share, then the limit.
        return reply(`Growing. ${"dolor sit amet ".repeat(280)}`.trim());
      case "fill":
        return reply(`Filling the context. ${"lorem ipsum dolor sit amet ".repeat(1_100)}`.trim());
      default:
        return reply(compacted ? "Scripted reply, after a compaction." : "Scripted reply.");
    }
  }
}

// The JSON list that follows `script:calls` (or `word`) in a text.
function callsAfter(text: string, word = "script:calls"): { name: unknown; input?: unknown }[] {
  const i = text.indexOf(word);
  const start = text.indexOf("[", i);
  if (i < 0 || start < 0) return [];
  for (let end = text.indexOf("]", start); end >= 0; end = text.indexOf("]", end + 1)) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(v) ? v : [];
    } catch {}
  }
  return [];
}

const RENDER_REPLY = `## The parser, moved

The change is in \`notes/plan.md:2\` and **keeps the public surface**. It runs in $O(n)$ time.

\`\`\`ts
export function parse(input: string): string[] {
  return input.split("\\n").filter(Boolean);
}
\`\`\`

| File | Change |
| --- | ---: |
| \`src/parse.ts\` | +42 |
| \`src/store.ts\` | -40 |

$$
T(n) = 2T\\left(\\frac{n}{2}\\right) + O(n)
$$

The prices stay text: $5 and $10, and so does $HOME.

${"The rest of the note says what to check before the merge, line by line, so the reply keeps streaming for a while. ".repeat(6)}`;

