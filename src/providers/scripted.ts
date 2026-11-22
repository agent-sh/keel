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
//
// Some scenarios stand in for a model that reads or follows a prompt:
// `script:find` (text the request carries outside the owner's prompts),
// `script:color` (the newest picture), `script:count` (a long reply that
// streams for a while) and `script:say` (the reply is the words given).
//
// An outage of the whole provider (src/providers/outage.ts), for every session
// and for the listing a probe asks for:
//   script:outage <kind> <ms>        the provider cannot be reached for <ms>
//                                    from this prompt's first request on
//   script:outage-at <n> <kind> <ms> on a later line of any prompt: the same,
//                                    from its request number <n> on (0 is the
//                                    first; 1 follows the first tool result)
//   script:outage-mid <kind> <ms>    half a reply streams, the stream breaks,
//                                    and the provider is gone for <ms>
//   script:outage-count              how many requests and listings the last
//                                    outage refused
//   script:outage-end                the provider is back now
// <kind>: dns (EAI_AGAIN), gateway (a broker's 502 naming a DNS failure), refused, tls.
// Kept in the state folder, so an outage survives a restart and starts once per prompt.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { Message } from "../core/types.ts";
import { imageSize } from "../engine/images.ts";
import { classify, fetchFailure, ProviderError } from "./http.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderResult } from "./types.ts";

export const SCRIPTED_ENV = "KEEL_SCRIPTED_PROVIDER";
export const scriptedEnabled = () => process.env[SCRIPTED_ENV] === "1";

// The lenient stand-ins count little of what they are sent (no tools, an
// eighth of the system prompt) and refuse nothing by size. Their window holds
// the system prompt and tools as the engine counts them, with room for a
// conversation, as a real model's does (and stays under the strict one's, so
// the strict stand-in is still the largest scripted model); a spec that wants
// a context to reach its compaction line after a few long replies sets the
// session's compact_at.
const WINDOW = 64_000;
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
// The wait is 15 minutes unless a spec's daemon names a shorter one (with KEEL_RETRY_WAIT_MAX_MS below it).
const LONG_WAIT_MS = Number(process.env.KEEL_SCRIPTED_RATE_WAIT_MS) || 15 * 60_000;
// `script:rate-limit-long <ms>` and `script:rate-limit-always <ms>` name the wait themselves: a spec
// that acts during a wait (calls it off, goes on at once, restarts the daemon) asks for one it
// cannot outlast, and one that watches the turn come back asks for a short one.
const longRateLimit = (prompt = "") => {
  const ms = Number(prompt.match(/script:rate-limit-(?:long|always)[ \t]+(\d+)\b/)?.[1]) || LONG_WAIT_MS;
  return new ProviderError("rate", `Scripted: 429 rate limited, retry after ${ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`}`, 429, ms);
};

// What a driver throws for each way of not reaching the provider, in the runtime's own words.
const OUTAGE_KINDS = ["dns", "gateway", "refused", "tls"] as const;
type OutageKind = (typeof OUTAGE_KINDS)[number];
function outageError(kind: OutageKind): ProviderError {
  const thrown = (message: string, code: string) => fetchFailure("Scripted", Object.assign(new TypeError(message), { code }));
  if (kind === "gateway") return classify("Scripted", 502, new Headers(), JSON.stringify({ message: "the broker could not reach runtime.example.invalid: EAI_AGAIN" }));
  if (kind === "refused") return thrown("Unable to connect. Is the computer able to access the url?", "ConnectionRefused");
  if (kind === "tls") return thrown("self signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT");
  return thrown("getaddrinfo EAI_AGAIN scripted.example.invalid", "EAI_AGAIN");
}
type OutageState = { kind: OutageKind; until: number; started: string[]; requests: number; listings: number };

export class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly label = "Scripted (test)";
  readonly family = "other" as const;
  private seen = new Map<string, number>();
  // The tools and system of each session's last request, per model (KEEL_SCRIPTED_CACHE=prefix).
  private prefixes = new Map<string, string>();
  private paused = new Map<string, string>();
  // What the strict stand-in counted per session: its requests, the largest
  // one in tokens, and those over its window, which it refused. `script:counted
  // <session id>` on any scripted model replies with it, so a spec can show
  // that no oversized request reached the provider.
  private counted = new Map<string, { requests: number; largest: number; refused: number }>();

  // `stateDir`: where an outage is kept across a daemon restart.
  constructor(private stateDir?: string) {
    try { if (stateDir) this.outage = JSON.parse(readFileSync(join(stateDir, "scripted-outage.json"), "utf8")); } catch {}
  }

  available() {
    return scriptedEnabled();
  }

  private outage: OutageState = { kind: "dns", until: 0, started: [], requests: 0, listings: 0 };
  private saveOutage() {
    try { if (this.stateDir) writeFileSync(join(this.stateDir, "scripted-outage.json"), JSON.stringify(this.outage)); } catch {}
  }
  // The failure of a request or a listing made while the provider is gone, counted.
  private down(what: "requests" | "listings"): ProviderError | undefined {
    if (Date.now() >= this.outage.until) return undefined;
    this.outage[what]++;
    this.saveOutage();
    return outageError(this.outage.kind);
  }
  // Starts the outage a prompt asks for, once per prompt (a restart or a later request does not start it again).
  private begin(key: string, kind: string, ms: number): boolean {
    if (this.outage.started.includes(key)) return false;
    this.outage = { kind: (OUTAGE_KINDS as readonly string[]).includes(kind) ? (kind as OutageKind) : "dns", until: Date.now() + Math.min(ms, 600_000), started: [...this.outage.started.slice(-200), key], requests: 0, listings: 0 };
    this.saveOutage();
    return true;
  }

  async list(): Promise<ListedModel[]> {
    const gone = this.down("listings");
    if (gone) throw gone;
    const price = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
    return [
      // Reads PDFs (`script:find` looks inside one); says nothing about images.
      { model: "stand-in", name: "Scripted stand-in", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" }, pdf: true },
      { model: "stand-in-backup", name: "Scripted backup", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" } },
      // Says it reads no images: the composer holds a new screenshot for it.
      { model: STRICT, name: "Scripted strict window", context: STRICT_WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" } },
      { model: "stand-in-text", name: "Scripted text only", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" }, images: false },
    ];
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult> {
    const msgs = req.messages;
    // For specs that compare what was sent across daemon restarts: one line per
    // request, with a fingerprint of the tool definitions as they were sent.
    if (process.env.KEEL_SCRIPTED_LOG) appendFileSync(process.env.KEEL_SCRIPTED_LOG, JSON.stringify({ ts: Date.now(), session: req.sessionKey, purpose: req.purpose ?? "turn", system: req.system, tools: req.tools.map((t) => t.name), tools_hash: Bun.hash(JSON.stringify(req.tools.map((t) => [t.name, t.description, t.input_schema, t.freeform ?? null, !!t.defer]))).toString(36), messages: msgs.length }) + "\n");
    const last = msgs.at(-1);
    const lastText = textOf(last);
    // `script:outage-end` as the newest message: the provider is back at once (a spec ends what it began).
    if (/^script:outage-end\b/.test(lastText) && this.outage.until) { this.outage.until = 0; this.saveOutage(); }
    const gone = this.down("requests");
    if (gone) throw gone;
    // A retry is the same request: system, messages, tools, model and effort, byte for byte.
    const key = String(Bun.hash(JSON.stringify([req.sessionKey, req.model, req.effort, req.system, msgs, req.tools.map((t) => t.name)])));
    const attempt = this.seen.get(key) ?? 0;
    this.seen.set(key, attempt + 1);
    // Everything but the newest message counts as read from cache.
    const usage = { input: tokens(last), cache_read: tokens(msgs.slice(0, -1)) + tokens(req.system) / 8, cache_write: 0, output: 0 };
    usage.cache_read = Math.round(usage.cache_read);
    // KEEL_SCRIPTED_CACHE=prefix: the cache is keyed by the prefix, as a real
    // one is. A request whose tools or system differ from the session's last
    // one on this model reads nothing and writes its whole prompt.
    if (process.env.KEEL_SCRIPTED_CACHE === "prefix" && req.purpose !== "reader") {
      const at = `${req.sessionKey}\u0000${req.model}`;
      const prefix = String(Bun.hash(JSON.stringify([req.tools.filter((t) => !t.defer).map((t) => [t.name, t.description, t.input_schema]), req.system])));
      const had = this.prefixes.get(at);
      this.prefixes.set(at, prefix);
      if (had !== undefined && had !== prefix) { usage.cache_write = usage.cache_read; usage.cache_read = 0; }
    }
    if (req.model === STRICT) {
      const count = (v: unknown) => Math.ceil(Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v)) / STRICT_BYTES);
      const total = count(req.system) + count(req.tools.map((t: any) => [t.name, t.description, t.input_schema])) + count(msgs);
      const seen = this.counted.get(req.sessionKey ?? "") ?? { requests: 0, largest: 0, refused: 0 };
      this.counted.set(req.sessionKey ?? "", { requests: seen.requests + 1, largest: Math.max(seen.largest, total), refused: seen.refused + (total > STRICT_WINDOW ? 1 : 0) });
      if (total > STRICT_WINDOW) throw classify("Scripted", 400, new Headers(), JSON.stringify({ error: { code: 400, message: `The input token count exceeds the maximum number of tokens allowed (${STRICT_WINDOW}); input token count: ${total}.`, status: "INVALID_ARGUMENT" } }));
      usage.input = count(last);
      usage.cache_read = total - usage.input;
    }

    // A reply streamed `size` characters every `ms`.
    const paced = async (text: string, size: number, ms: number, stop = "end_turn", extra: any[] = []): Promise<ProviderResult> => {
      // The pause comes first: the first token is never in the request's own millisecond.
      for (const part of text.match(new RegExp(`.{1,${size}}`, "gs")) ?? []) {
        await Bun.sleep(ms);
        onDelta({ kind: "text", index: 0, text: part });
      }
      usage.output = tokens(text);
      return { blocks: [{ type: "text", text }, ...extra], usage, stop, model: req.model };
    };
    // `script:pace <ms>` on a later line of the prompt: a reply's parts come that far apart (5 ms
    // without it, at most 200), for a spec that acts while a reply streams.
    let pace = 5;
    const reply = (text: string, stop = "end_turn", extra: any[] = []) => paced(text, 40, pace, stop, extra);

    // Permission fixture: decide from the proposed action, not other actions
    // named in the owner message. The real judge path still parses the reply.
    if (req.sessionKey?.startsWith("judge-")) {
      const action = lastText.split("\n\nThe action:").at(-1) ?? "";
      if (action.includes("judge-allow.txt")) return reply('{"decision":"allow","risk":"low","reason":"The scratch marker is in scope."}');
      if (action.includes("judge-deny.txt") || action.includes("git clean -fn")) return reply('{"decision":"deny","risk":"high","reason":"The fixture refuses this action."}');
      if (action.includes("judge-unavailable.txt")) return reply('{"decision":"allow"}');
    }

    // A reader whose request says `script:quote`: it quotes the first line it
    // was given at that line and the second at a line four further on, and the
    // compile step hands the findings on as they are.
    if (req.purpose === "reader" && lastText.includes("script:quote")) {
      if (lastText.startsWith("Readers each")) return reply([...lastText.matchAll(/<findings [^>]*>\n([\s\S]*?)\n<\/findings>/g)].map((m) => m[1]).join("\n"));
      const f = /<file path="([^"]+)"[^>]*>\n(\d+)\t([^\n]*)\n\d+\t([^\n]*)/.exec(lastText);
      if (f) return reply(`- "${f[3]}" (${f[1]}:${f[2]})\n- "${f[4]}" (${f[1]}:${Number(f[2]) + 4})`);
    }

    // The owner's newest prompt: the newest user text that is neither a harness
    // note nor a tagged context block (in a summary: the last owner words it kept).
    const own = (m: Message) => (m.content as any[]).filter((b) => b.type === "text").map((b) => {
      const kept = [...String(b.text).matchAll(/<message>\n([\s\S]*?)\n<\/message>/g)].at(-1)?.[1];
      return kept ?? (/^(\[harness\]|<)/.test(b.text) ? "" : b.text);
    }).filter(Boolean).at(-1);
    const owner = [...msgs].reverse().filter((m) => m.role === "user").map(own).find((t) => t !== undefined) ?? "";
    pace = Math.min(200, Math.max(1, Number(owner.match(/\nscript:pace[ \t]+(\d+)/)?.[1] ?? 5)));
    // Refusals over images. The word is in the owner's newest prompt, or in a
    // compaction's focus (so the summary request is the one refused):
    //   script:image-limit N  a request with an image over N px a side is
    //                         refused, stating N as the Anthropic wire does
    //   script:image-bad      one with an image that does not decode in full
    //                         is refused, naming no image
    //   script:image-none     one with any image is refused, naming no image
    //   script:image-large    one with any image gets a 413 the first time
    //   script:image-always   every request is refused in an image's words
    // Each of them, and script:images, replies with the sizes of the images
    // the request carried, how many were left out as notes, and how often
    // that same request was sent.
    const pics = (msgs as any[]).flatMap((m) => (m.role !== "user" ? [] : m.content.flatMap((b: any) => (b.type === "image" ? [b] : b.type === "tool_result" && Array.isArray(b.content) ? b.content.filter((c: any) => c.type === "image") : []))));
    const rule = (req.purpose === "summary" ? lastText : owner).match(/script:image-(limit|bad|none|large|always)(?:\s+(\d+))?/);
    if (rule && (pics.length || rule[1] === "always")) {
      const refuse = (message: string, status = 400) => classify("Scripted", status, new Headers(), JSON.stringify({ type: "error", error: { type: status === 413 ? "request_too_large" : "invalid_request_error", message } }));
      const at = "messages.0.content.0.image.source.base64.data";
      const limit = Number(rule[2] ?? 0);
      if (rule[1] === "limit" && pics.some((b) => { const z = imageSize(b.data); return !z || z.w > limit || z.h > limit; })) throw refuse(`${at}: At least one of the image dimensions exceed max allowed size for many-image requests: ${limit} pixels`);
      if (rule[1] === "none" || rule[1] === "always") throw refuse(`${at}: Could not process image`);
      if (rule[1] === "large" && attempt === 0) throw refuse("Request exceeds the maximum size", 413);
      if (rule[1] === "bad") {
        for (const b of pics) {
          try { await new Bun.Image(Buffer.from(b.data, "base64")).resize(1, 1).png().bytes(); } catch { throw refuse(`${at}: Could not process image`); }
        }
      }
    }

    if (req.purpose === "summary" && lastText.includes("[harness] The context is being compacted")) {
      // The focus picks what a summary request gets: a reply cut at the output
      // limit (every time, or until it is asked for again, shorter), or, for
      // the first part of a transcript, a summary far longer than planned.
      const cut = lastText.match(/Keep above all: script:summary-cut(-once)?/);
      if (cut && !(cut[1] && lastText.includes("was cut at the output limit"))) return reply("Goal: the owner is checking a summary that the output limit cut in the middle of a", "max_tokens");
      if (lastText.includes("Keep above all: script:summary-long") && /; this is part 1\./.test(lastText)) return reply(`## Story\n${"The first part, retold at length. ".repeat(1_800)}`);
    }
    // A history read as a transcript in parts: the summary names the part it reached.
    const part = lastText.match(/^\[harness\] The context is being compacted, .* in (\d+) parts, oldest first; this is part (\d+)\./);
    if (part) return reply(`Goal: the owner is checking a history longer than the window. State: read part ${part[2]} of ${part[1]} of the transcript${lastText.includes("<summary>") ? ", after the summary of the parts before it" : ""}.`);
    if (lastText.includes("[harness] The context is being compacted")) {
      if (req.purpose === "summary" && lastText.includes("Keep above all: script:compact-error"))
        throw classify("Scripted", 400, new Headers(), JSON.stringify({ error: { message: "fixture image MIME type rejected" } }));
      if (req.purpose === "summary" && lastText.includes("Keep above all: script:rate-limit-long")) throw longRateLimit();
      return reply("Goal: the owner is checking how the harness handles provider failures. State: the scripted scenario ran; next, answer the newest prompt.");
    }
    if (req.model === "stand-in-backup") return reply("The backup model took the request.");

    // `script:replies ["...", "..."]`: these texts, one per reply, in order,
    // the last one from then on. Later prompts that name no script get the
    // next text too, so a spec can see what a follow-up prompt is answered.
    const repliesAt = msgs.findLastIndex((m) => m.role === "user" && textOf(m).includes("script:replies"));
    if (repliesAt >= 0 && !/script:(?!replies)[a-z-]+/.test(owner)) {
      const texts = callsAfter(textOf(msgs[repliesAt]), "script:replies").map(String);
      const said = msgs.slice(repliesAt + 1).filter((m) => m.role === "assistant").length;
      return reply(texts[Math.min(said, texts.length - 1)] ?? "Scripted reply.");
    }
    const scenario = owner.match(/script:([a-z-]+)/)?.[1] ?? "";
    // An outage the prompt asks for, at the request it names. Its start is this request's own failure.
    const ownerAt = msgs.findLastIndex((m) => m.role === "user" && own(m) === owner);
    const round = msgs.slice(ownerAt + 1).filter((m) => m.role === "assistant").length;
    const asked = scenario === "outage" ? owner.match(/script:outage[ \t]+([a-z]+)[ \t]+(\d+)/) : null;
    const later = owner.match(/\nscript:outage-at[ \t]+(\d+)[ \t]+([a-z]+)[ \t]+(\d+)/);
    const due = asked ? { n: 0, kind: asked[1]!, ms: Number(asked[2]) } : later ? { n: Number(later[1]), kind: later[2]!, ms: Number(later[3]) } : undefined;
    if (due && round === due.n && this.begin(String(Bun.hash(`${req.sessionKey}\u0000${owner}`)), due.kind, due.ms)) throw this.down("requests")!;
    const compacted = msgs.some((m) => textOf(m).startsWith("[harness] This conversation was compacted"));

    switch (scenario) {
      case "outage":
        return reply("Answered after the outage.");
      case "outage-end":
        return reply("The provider is back.");
      case "outage-mid": {
        const [, kind = "dns", ms = "5000"] = owner.match(/script:outage-mid[ \t]+([a-z]+)[ \t]+(\d+)/) ?? [];
        if (!this.outage.started.includes(String(Bun.hash(`${req.sessionKey}\u0000${owner}`)))) {
          for (const part of ["This half reply ", "is lost with the provider"]) {
            onDelta({ kind: "text", index: 0, text: part });
            await Bun.sleep(300);
          }
          this.begin(String(Bun.hash(`${req.sessionKey}\u0000${owner}`)), kind, Number(ms));
          throw new ProviderError("network", "Scripted: the stream broke: The socket connection was closed unexpectedly");
        }
        return reply("The whole reply, after the broken stream and the outage.");
      }
      case "outage-count":
        return reply(`The last outage refused ${this.outage.requests} requests and ${this.outage.listings} listings.`);
      case "counted":
        return reply(`counted ${JSON.stringify({ window: STRICT_WINDOW, ...(this.counted.get(owner.match(/script:counted\s+(\S+)/)?.[1] ?? "") ?? { requests: 0, largest: 0, refused: 0 }) })}`);
      case "billing":
        // An account state, not a passing failure: turns are refused until the owner acts.
        throw new ProviderError("quota", "Scripted: your credit balance is too low to make this request. Add credits at https://example.com/billing.", 402);
      case "calls": {
        // `script:calls [{"name":...,"input":...}, ...]`: one call per round, in
        // order, then a reply naming the last result. For specs that need tool
        // calls a real model cannot be made to send exactly.
        const calls = callsAfter(owner);
        const at = msgs.findLastIndex((m) => m.role === "user" && textOf(m).includes("script:calls"));
        // keel__new_context replaced the context: the prompt is inside the
        // summary now and no call is left after it. The turn goes on from the
        // handoff, the summary's last line, as a model following it does.
        const head = textOf(msgs[at]);
        if (head.startsWith("[harness] This conversation was compacted") && calls.some((c) => c.name === "keel__new_context")) {
          return reply(`Went on in a fresh context. ${head.split("\n\n[")[0]!.trim().split("\n").at(-1)}`);
        }
        const done = msgs.slice(at + 1).filter((m) => m.role === "assistant").length;
        const next = calls[done];
        if (next) {
          // `after_ms` on a call: the model takes that long before it makes it, as a real one does (at most 10 s).
          if (typeof next.after_ms === "number") await Bun.sleep(Math.max(0, Math.min(next.after_ms, 10_000)));
          // `say` on a call: the words of the reply that makes it, in place of "Step N of M."
          return reply(typeof next.say === "string" ? next.say : `Step ${done + 1} of ${calls.length}.`, "tool_use", [{ type: "tool_use", id: `call-${msgs.length}-${done}`, name: String(next.name), input: next.input ?? {} }]);
        }
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
      case "memory": {
        // `script:memory`: the reply names the first fact of the newest memory
        // block the request carries (a note with the prompt, or a tool result's
        // block), as a model that used what it was given would.
        const texts = (msgs as any[]).flatMap((m) => (m.content as any[]).flatMap((b) => (b.type === "text" ? [String(b.text)] : b.type === "tool_result" ? [typeof b.content === "string" ? b.content : (b.content as any[]).map((c) => c.text ?? "").join("\n")] : [])));
        const block = [...texts.join("\n").matchAll(/<memory source="tacit" hook="[a-z-]+">\n([\s\S]*?)\n<\/memory>/g)].at(-1)?.[1];
        const name = block?.match(/^- (?:RULE )?([^:\n]+):/m)?.[1];
        return reply(name ? `From memory: ${name}.` : "No memory came with this prompt.");
      }
      case "recall": {
        // `script:recall <word>`: says whether a turn before this prompt holds
        // the word, as a model that read its history would. For specs that
        // check a history made elsewhere (an imported one) reached the model.
        const word = owner.match(/script:recall\s+(\S+)/)?.[1]?.toLowerCase() ?? "";
        const at = msgs.findLastIndex((m) => m.role === "user" && textOf(m).includes("script:recall"));
        const held = !!word && msgs.slice(0, at).some((m) => textOf(m).toLowerCase().includes(word));
        return reply(held ? `The history names ${word}.` : `Nothing before this prompt names ${word}.`);
      }
      case "liar":
        // A worker that says it finished without doing anything, and a judge
        // that believes it: what the independent goal check exists for.
        if (lastText.includes("[harness] Goal check")) return reply('{"verdict": "met", "reason": "The reply says goal.txt holds the word ready."}');
        return reply("Done: goal.txt holds the word ready.");
      case "verify-holds": {
        // `script:verify-holds <pipe> <n>` as a goal's objective: the worker says
        // done, its judge believes it, and the verifier reads the named pipe n
        // times, one call a round (each a step a daemon restart can cut), before
        // its verdict.
        if (lastText.includes("[harness] Goal check")) return reply('{"verdict": "met", "reason": "The reply says it is done."}');
        if (!textOf(msgs[0]).startsWith("You are an independent verifier")) return reply("Done.");
        const [, pipe, n] = owner.match(/script:verify-holds\s+(\S+)\s+(\d+)/) ?? [];
        const round = msgs.filter((m) => m.role === "assistant").length;
        if (round < Number(n)) return reply(`Check ${round + 1} of ${n}.`, "tool_use", [{ type: "tool_use", id: `hold-${msgs.length}`, name: "Bash", input: { command: `cat ${pipe}; echo released` } }]);
        return reply(JSON.stringify({ verdict: "met", reason: "Every check ran.", evidence: [`${n} reads of the pipe were started`] }));
      }
      case "rate-limit-always":
        // A provider that asks for the long wait however often it is asked.
        throw longRateLimit(owner);
      case "rate-limit-long":
        // Refused until the engine comes back by itself when the wait is over.
        if (lastText.includes("[harness] The wait the provider asked for is over")) return reply("Answered after the wait the provider asked for.");
        throw longRateLimit(owner);
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
      case "refuse":
      case "refuse-late": {
        // `script:refuse-late`: overloaded once first, so the failed request is kept and sending it again ends in the refusal.
        if (scenario === "refuse-late" && attempt === 0) throw new ProviderError("overloaded", "Scripted: 529 overloaded", 529);
        // `script:refuse <word>`: the partial reply carries the word (a search test looks for it).
        const word = owner.match(/script:refuse\s+(\S+)/)?.[1];
        const r = await reply(word ? `I will not ${word}` : "I will not");
        return { ...r, stop: "refusal", stop_details: { category: "cyber", explanation: "Scripted refusal for the test." } };
      }
      case "overflow":
        if (!compacted) throw new ProviderError("context", `Scripted: prompt is too long: ${WINDOW + 1_000} tokens > ${WINDOW} maximum`, 400);
        return reply("Answered after compacting to fit.");
      case "deaf":
        // A stream that does not honor the stop for 12 s (a driver or hook that
        // ignores its signal): a delete waits that long for the turn to end.
        await Bun.sleep(12_000);
        return reply("Answered after not listening.");
      case "hold": {
        // `script:hold <path>`: half a reply, then nothing until that file
        // exists (or a minute passed): a draft that stays as it is while a
        // spec cuts the page's socket and looks at what the reconnect shows.
        const gate = owner.match(/script:hold\s+(\S+)/)?.[1];
        const halves = ["The first half, streamed before the hold. ", "The second half, after it."];
        onDelta({ kind: "text", index: 0, text: halves[0]! });
        for (let i = 0; i < 600 && gate && !existsSync(gate) && !req.signal.aborted; i++) await Bun.sleep(100);
        onDelta({ kind: "text", index: 0, text: halves[1]! });
        usage.output = tokens(halves.join(""));
        return { blocks: [{ type: "text", text: halves.join("") }], usage, stop: "end_turn", model: req.model };
      }
      case "block": {
        // `script:block <ms>`: holds the daemon's event loop that long without
        // yielding, as code that reads too much in one go does. Nothing else
        // is answered meanwhile.
        const until = performance.now() + Math.min(Number(owner.match(/script:block\s+(\d+)/)?.[1] ?? 1500), 30_000);
        while (performance.now() < until);
        return reply("Answered after holding the daemon.");
      }
      case "child": {
        // `script:child <ms>`: runs a synchronous child that takes that long
        // (a `sleep`), as code that runs a program without yielding does. The
        // loop is held and the process uses no processor meanwhile.
        const ms = Math.min(Number(owner.match(/script:child\s+(\d+)/)?.[1] ?? 1500), 30_000);
        Bun.spawnSync(["sleep", String(ms / 1000)], { stdout: "ignore", stderr: "ignore" });
        return reply("Answered after a synchronous child.");
      }
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
      case "write-tool":
        // A command that changes a file: a card opens for it where the owner is asked (the long one above only reads, and runs unasked).
        if (last?.role === "user" && (last.content as any[]).some((b) => b.type === "tool_result")) return reply("Finished after the tool.");
        return reply("Writing a file.", "tool_use", [{ type: "tool_use", id: `write-${msgs.length}`, name: "Bash", input: { command: "touch scripted-write.txt" } }]);
      case "render":
        // A reply that uses what the transcript renders: a table, code that
        // finishes while the rest streams, math, a file link. Slow enough to
        // read the draft while it streams.
        return paced(RENDER_REPLY, 24, 40);
      case "count":
        // The numbers from one to four hundred as words: a reply that streams
        // for about ten seconds, for a spec that cuts the page's socket meanwhile.
        return paced(Array.from({ length: 400 }, (_, i) => numberWords(i + 1)).join(", "), 32, 30);
      case "say":
        // `script:say <words>`: the reply is those words, a written \n a line break.
        return reply((owner.match(/script:say[ \t]+([^\n]+)/)?.[1]?.trim() ?? "").replaceAll("\\n", "\n"));
      case "find": {
        // `script:find <word> ...`: for each word, the line of the request that
        // holds it outside the owner's typed prompts (the system prompt, a
        // harness note, an inlined file, a PDF, a tool result). A word the
        // request does not carry is not repeated in the reply.
        const words = (owner.match(/script:find[ \t]+([^\n]+)/)?.[1] ?? "").split(/\s+/).filter(Boolean);
        const lines = [req.system, ...msgs.flatMap((m) => (m.content as any[]).flatMap(carried))].flatMap((t) => t.split("\n"));
        return reply(words.map((w: string) => lines.find((l) => l.includes(w))?.trim().slice(0, 240) ?? "Not in the request.").join("\n"));
      }
      case "color": {
        // The color of the newest picture the request carries, by the
        // strongest channel of its first pixel.
        const picture = msgs.flatMap((m) => (m.content as any[]).filter((b) => b.type === "image")).at(-1);
        return reply(picture ? `The picture is ${colorOf(picture.data)}.` : "The request carries no picture.");
      }
      case "grow":
        // About a thousand tokens a turn: with compact_at set near 7,000 the context crosses the preparing share, then the limit.
        return reply(`Growing. ${"dolor sit amet ".repeat(280)}`.trim());
      case "fill":
        return reply(`Filling the context. ${"lorem ipsum dolor sit amet ".repeat(1_100)}`.trim());
      case "images": case "image-limit": case "image-bad": case "image-none": case "image-large": {
        const left = (msgs as any[]).flatMap((m) => (m.role !== "user" ? [] : m.content.flatMap((b: any) => (b.type === "tool_result" && Array.isArray(b.content) ? b.content : [b])))).filter((b: any) => b.type === "text" && String(b.text).startsWith("[Image left out")).length;
        return reply(`Images: ${pics.map((b) => { const z = imageSize(b.data); return z ? `${z.w}x${z.h}` : "unreadable"; }).join(", ") || "none"}. Left out: ${left}. Attempt ${attempt + 1}.`);
      }
      default:
        return reply(compacted ? "Scripted reply, after a compaction." : "Scripted reply.");
    }
  }
}

// What a block carries besides the owner's typed prompts: text that names no
// scenario, the text inside a PDF, a tool result.
function carried(b: any): string[] {
  if (b.type === "text") return /script:[a-z-]+/.test(b.text) ? [] : [b.text];
  if (b.type === "document") return [Buffer.from(b.data, "base64").toString("latin1")];
  if (b.type === "tool_result") return typeof b.content === "string" ? [b.content] : (b.content as any[]).map((c) => c.text ?? "");
  return [];
}

// The first pixel of a PNG (never filtered against a neighbor), by its strongest channel.
function colorOf(base64: string): string {
  try {
    const png = Buffer.from(base64, "base64");
    const data: Buffer[] = [];
    for (let at = 8; at + 8 <= png.length; at += 12 + png.readUInt32BE(at)) {
      if (png.toString("latin1", at + 4, at + 8) === "IDAT") data.push(png.subarray(at + 8, at + 8 + png.readUInt32BE(at)));
    }
    const [r, g, b] = inflateSync(Buffer.concat(data)).subarray(1, 4);
    return r! >= g! && r! >= b! ? "red" : g! >= b! ? "green" : "blue";
  } catch {
    return "unreadable";
  }
}

const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "- - twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function numberWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : "");
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
}

// The JSON list that follows `script:calls` (or `word`) in a text.
function callsAfter(text: string, word = "script:calls"): { name: unknown; input?: unknown; after_ms?: unknown; say?: unknown }[] {
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

