// A scripted stand-in provider for the e2e of the paths a real model cannot be
// made to take on demand: a 429 with retry-after, a 529, a stream that breaks,
// a reply cut at the output limit inside a tool call, pause_turn, a refusal and
// a request too long for the window. Test-only: it is listed only when the
// daemon starts with KEEL_SCRIPTED_PROVIDER=1.
//
// The owner's prompt picks the scenario with a word `script:<name>`. What a
// request gets depends only on the request and how often that exact request
// was sent before, so a retry sees the next step of the same scenario.
import type { Message } from "../core/types.ts";
import { ProviderError } from "./http.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderResult } from "./types.ts";

export const SCRIPTED_ENV = "KEEL_SCRIPTED_PROVIDER";
export const scriptedEnabled = () => process.env[SCRIPTED_ENV] === "1";

// A small window, so a few long replies reach the compaction threshold.
const WINDOW = 8_000;
const OUTPUT = 2_000;

const textOf = (m: Message | undefined) =>
  (m?.content as any[] | undefined)?.filter((b) => b.type === "text").map((b) => b.text).join("\n") ?? "";
const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

export class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly label = "Scripted (test)";
  readonly family = "other" as const;
  private seen = new Map<string, number>();

  available() {
    return scriptedEnabled();
  }

  async list(): Promise<ListedModel[]> {
    const price = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
    return [
      { model: "stand-in", name: "Scripted stand-in", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" } },
      { model: "stand-in-backup", name: "Scripted backup", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" } },
    ];
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult> {
    const msgs = req.messages;
    const last = msgs.at(-1);
    const lastText = textOf(last);
    const key = `${req.sessionKey}:${req.model}:${msgs.length}:${lastText.slice(0, 200)}`;
    const attempt = this.seen.get(key) ?? 0;
    this.seen.set(key, attempt + 1);
    // Everything but the newest message counts as read from cache.
    const usage = { input: tokens(last), cache_read: tokens(msgs.slice(0, -1)) + tokens(req.system) / 8, cache_write: 0, output: 0 };
    usage.cache_read = Math.round(usage.cache_read);

    const reply = async (text: string, stop = "end_turn", extra: any[] = []): Promise<ProviderResult> => {
      for (const part of text.match(/.{1,40}/gs) ?? []) {
        onDelta({ kind: "text", index: 0, text: part });
        await Bun.sleep(5);
      }
      usage.output = tokens(text);
      return { blocks: [{ type: "text", text }, ...extra], usage, stop, model: req.model };
    };

    if (lastText.startsWith("[harness] The context is being compacted")) {
      return reply("Goal: the owner is checking how the harness handles provider failures. State: the scripted scenario ran; next, answer the newest prompt.");
    }
    if (req.model === "stand-in-backup") return reply("The backup model took the request.");

    // The owner's newest prompt (in a summary: the last of the owner's words it kept).
    const newest = [...msgs].reverse().find((m) => m.role === "user" && !textOf(m).startsWith("[harness] Your last reply"));
    const owner = [...textOf(newest).matchAll(/<message>\n([\s\S]*?)\n<\/message>/g)].at(-1)?.[1] ?? textOf(newest);
    const scenario = owner.match(/script:([a-z-]+)/)?.[1] ?? "";
    const compacted = msgs.some((m) => textOf(m).startsWith("[harness] This conversation was compacted"));

    switch (scenario) {
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
        if (lastText.startsWith("[harness] Your last reply was cut off")) return reply("Part two, continued after the cut.");
        return reply("Part one of a long answer.", "max_tokens", [{ type: "tool_use", id: `cut-${msgs.length}`, name: "Bash", input: { command: "echo half" } }]);
      case "pause":
        if (last?.role === "assistant") return reply("Resumed after the pause.");
        return reply("Paused at a server tool.", "pause_turn");
      case "refuse": {
        const r = await reply("I will not");
        return { ...r, stop: "refusal", stop_details: { category: "cyber", explanation: "Scripted refusal for the test." } };
      }
      case "overflow":
        if (!compacted) throw new ProviderError("context", "Scripted: prompt is too long: 9000 tokens > 8000 maximum", 400);
        return reply("Answered after compacting to fit.");
      case "fill":
        return reply(`Filling the context. ${"lorem ipsum dolor sit amet ".repeat(1_100)}`.trim());
      default:
        return reply(compacted ? "Scripted reply, after a compaction." : "Scripted reply.");
    }
  }
}
