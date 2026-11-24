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
// streams for a while), `script:say` (the reply is the words given) and
// `script:obey` (it makes the call a page it fetched asks for).
// `script:review` (a reviewer's findings for the BUG: lines of a diff).
//
// An outage of the whole provider (src/providers/outage.ts), for every session
// and for the listing a probe asks for:
//   script:outage <kind> <ms>        the provider cannot be reached for <ms>
//                                    from this prompt's first request on
//   script:outage-at <n> <kind> <ms> on a later line of any prompt: the same,
//                                    from its request number <n> on (0 is the
//                                    first; 1 follows the first tool result)
//   ... <ms> on <provider>           either of them with "on <provider id>" after the
//                                    time: only that provider is out, the others
//                                    (the second scripted provider) answer
//   script:outage-mid <kind> <ms>    half a reply streams, the stream breaks,
//                                    and the provider is gone for <ms>
//   script:outage-count              how many requests and listings the last
//                                    outage refused
//   script:outage-end                the provider is back now
//   script:overloaded <ms> [on <provider id>]
//                                    every request of the provider answers 529 overloaded
//                                    for <ms> from this prompt's first request on (in
//                                    memory: a restart ends it)
// A listing that changes while the daemon runs (for the e2e of a model that lists later):
//   script:list-model <id>           the provider lists one more model, <id>, from the next listing on
//                                    (an id ending in -plain lists no price)
//   script:unlist-model <id>         it lists it no more
// <kind>: dns (EAI_AGAIN), gateway (a broker's 502 naming a DNS failure), refused, tls.
// Kept in the state folder, so an outage survives a restart and starts once per prompt.
//
// An account's rate limit (src/providers/admission.ts), for every request on the model's account:
//   script:account-limit <ms>   the account is spent for <ms> from this prompt's first request on:
//                               every request on it meanwhile is answered 429, with retry-after
//                               and Anthropic's rate-limit headers saying what is left
//   script:account-wait         a reply that says its place among the answers since the limit
//                               ended, and how many requests the account refused
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { Message } from "../core/types.ts";
import { imageSize } from "../engine/images.ts";
import { classify, fetchFailure, ProviderError } from "./http.ts";
import { reportUsage } from "./reported.ts";
import { REWORD_SYSTEM } from "../automation/successor.ts";
import { RULING_SYSTEM, standInMatch } from "../automation/ruling-match.ts";
import { KIND_SYSTEM, LESSON_SYSTEM, standInDraft, standInKind } from "../automation/lesson-draft.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderResult, Wire } from "./types.ts";
import { anthropicBody } from "./wires/anthropic.ts";
import { geminiBody } from "./wires/gemini.ts";
import { responsesBody } from "./wires/responses.ts";
import { BARE_SCHEMA, schemaRefusals } from "./wires/schema-fit.ts";

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
// A stand-in of each model family, for the e2e of the tools that family is
// offered (src/tools/<family>.ts), driven by `script:calls`: each answers as
// `stand-in` does and loads its tools as the family's own wire does.
const FAMILY_STAND_INS = [
  { model: "claude-stand-in", name: "Scripted Claude stand-in", family: "claude", wire: "anthropic_messages" },
  { model: "gpt-stand-in", name: "Scripted GPT stand-in", family: "gpt", wire: "openai_responses" },
  { model: "gemini-stand-in", name: "Scripted Gemini stand-in", family: "gemini", wire: "gemini_generate_content" },
] as const;

const textOf = (m: Message | undefined) =>
  (m?.content as any[] | undefined)?.filter((b) => b.type === "text").map((b) => b.text).join("\n") ?? "";
const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);
// The wait is 15 minutes unless a spec's daemon names a shorter one (with KEEL_RETRY_WAIT_MAX_MS below it).
const LONG_WAIT_MS = Number(process.env.KEEL_SCRIPTED_RATE_WAIT_MS) || 15 * 60_000;
// `script:rate-limit-long <ms>` and `script:rate-limit-always <ms>` name the wait themselves: a spec
// that acts during a wait (calls it off, goes on at once, restarts the daemon) asks for one it
// cannot outlast, and one that watches the turn come back asks for a short one.
// These play one turn's wait and answer the next prompt at once, so they are not the account's state:
// the account's line does not learn them (`requestOnly`, src/providers/admission.ts).
const longRateLimit = (prompt = "") => {
  const ms = Number(prompt.match(/script:rate-limit-(?:long|always)[ \t]+(\d+)\b/)?.[1]) || LONG_WAIT_MS;
  return Object.assign(new ProviderError("rate", `Scripted: 429 rate limited, retry after ${ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`}`, 429, ms), { requestOnly: true });
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

// A second scripted provider (KEEL_SCRIPTED_SECOND=1 with the first): the same models under
// another provider id, for the e2e and measurements of what goes to which provider.
export const SCRIPTED_SECOND = "scripted-b";
export const scriptedSecond = () => scriptedEnabled() && process.env.KEEL_SCRIPTED_SECOND === "1";

export class ScriptedProvider implements Provider {
  readonly family = "other" as const;
  // KEEL_SCRIPTED_CACHE_TTL_MS: a prompt cache that lapses as a real one does
  // (Anthropic's: a request's prefix is kept that long from the request's
  // start, and a read keeps it that long again). A request after the lapse
  // reads nothing and writes its whole prompt. Set, the provider says so
  // (`caching`), so a waiting session's cache plan can keep it.
  private ttl = Number(process.env.KEEL_SCRIPTED_CACHE_TTL_MS) || 0;
  readonly caching = this.ttl ? { life: this.ttl, refresh: "read" as const } : undefined;
  private lives = new Map<string, number>(); // session and model -> when its cached prefix lapses
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
  constructor(private stateDir?: string, readonly id = "scripted", readonly label = "Scripted (test)") {
    try { if (stateDir) this.outage = JSON.parse(readFileSync(join(stateDir, this.outageFile), "utf8")); } catch {}
    try { if (stateDir) this.listed = JSON.parse(readFileSync(join(stateDir, this.listedFile), "utf8")); } catch {}
  }

  // Models `script:list-model` added to the listing, kept across a restart.
  private listed: string[] = [];
  private get listedFile() { return `${this.id}-listed.json`; }

  private get outageFile() { return `${this.id}-outage.json`; }

  available() {
    return scriptedEnabled();
  }

  // The stand-in of each family stands for its vendor's route, with an account of its own; the rest are one.
  accountOf(model: string): string | undefined {
    return FAMILY_STAND_INS.some((f) => f.model === model) ? `${this.id}:${model}` : undefined;
  }

  wireOf(model: string): Wire | undefined {
    return FAMILY_STAND_INS.find((m) => m.model === model)?.wire;
  }

  // `script:overloaded`: until when every request answers overloaded, and the prompts that began it.
  private busy = { until: 0, started: new Set<string>() };
  private outage: OutageState = { kind: "dns", until: 0, started: [], requests: 0, listings: 0 };
  // Each account's rate limit (`script:account-limit`): until when it is spent, the requests it
  // refused, the answers since it ended, and the prompts that started one.
  private limits = new Map<string, { until: number; refused: number; answered: number }>();
  private limitStarted = new Set<string>();
  // A reply's place among the answers on the account since its limit ended.
  private placeWords(account: string): string {
    const lim = this.limits.get(account);
    if (!lim) return "Answered with no limit on the account.";
    lim.answered++;
    return `Answered in place ${lim.answered} after the account's limit; it refused ${lim.refused} request${lim.refused === 1 ? "" : "s"}.`;
  }
  // The 429 an account sends while it is spent, with the headers a real one carries.
  private limitedAnswer(req: ProviderRequest, until: number): ProviderError {
    const ms = Math.max(0, until - Date.now());
    req.onHeaders?.(new Headers({
      "retry-after": String(Math.ceil(ms / 1000)),
      "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-requests-reset": new Date(until).toISOString(),
    }));
    return new ProviderError("rate", `Scripted: HTTP 429: rate_limit_error: This request would exceed the rate limit for your organization; retry after ${Math.ceil(ms / 1000)} s`, 429, ms);
  }
  // The refusals `script:refuse-schema` made, per session and prompt.
  private schemaRefused = new Map<string, number>();
  private saveOutage() {
    try { if (this.stateDir) writeFileSync(join(this.stateDir, this.outageFile), JSON.stringify(this.outage)); } catch {}
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
      // Says it reads images: the composer names it to a draft with a screenshot for a model that does not say so.
      { model: "stand-in-backup", name: "Scripted backup", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" }, images: true },
      // Says nothing about images either.
      { model: STRICT, name: "Scripted strict window", context: STRICT_WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" } },
      // Says it reads no images: the composer holds a new screenshot for it.
      { model: "stand-in-text", name: "Scripted text only", context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" }, images: false },
      ...FAMILY_STAND_INS.map(({ model, name, family }) => ({ model, name, family, context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price, billing: { kind: "per_token" as const } })),
      ...this.listed.map((model) => ({ model, name: `Scripted ${model}`, context: WINDOW, output: OUTPUT, efforts: ["low", "high"], price: model.endsWith("-plain") ? undefined : price, billing: { kind: "per_token" as const } })),
    ];
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void): Promise<ProviderResult> {
    const msgs = req.messages;
    // For specs that compare what was sent across daemon restarts: one line per
    // request, with a fingerprint of the tool definitions as they were sent.
    if (process.env.KEEL_SCRIPTED_LOG) appendFileSync(process.env.KEEL_SCRIPTED_LOG, JSON.stringify({ ts: Date.now(), session: req.sessionKey, purpose: req.purpose ?? "turn", system: req.system, tools: req.tools.map((t) => t.name), tools_hash: Bun.hash(JSON.stringify(req.tools.map((t) => [t.name, t.description, t.input_schema, t.freeform ?? null, !!t.defer]))).toString(36), messages: msgs.length }) + "\n");
    // For specs that check what a request carries (a value kept from every model): each request whole, as sent.
    if (process.env.KEEL_SCRIPTED_BODY_LOG) appendFileSync(process.env.KEEL_SCRIPTED_BODY_LOG, JSON.stringify({ ts: Date.now(), session: req.sessionKey, purpose: req.purpose ?? "turn", system: req.system, messages: msgs }) + "\n");
    const last = msgs.at(-1);
    const lastText = textOf(last);
    // `script:outage-end` as the newest message: the provider is back at once (a spec ends what it began).
    if (/^script:outage-end\b/.test(lastText) && this.outage.until) { this.outage.until = 0; this.saveOutage(); }
    for (const [, verb, model] of lastText.matchAll(/\bscript:(list|unlist)-model[ \t]+([\w.-]+)/g)) {
      this.listed = verb === "list" ? [...new Set([...this.listed, model!])] : this.listed.filter((m) => m !== model);
      try { if (this.stateDir) writeFileSync(join(this.stateDir, this.listedFile), JSON.stringify(this.listed)); } catch {}
    }
    const gone = this.down("requests");
    if (gone) throw gone;
    // An account that is spent refuses every request on it, whatever it asks.
    const account = this.accountOf(req.model) ?? this.id;
    const spent = this.limits.get(account);
    if (spent && spent.until > Date.now()) {
      spent.refused++;
      throw this.limitedAnswer(req, spent.until);
    }
    // A family's stand-in refuses a tool its wire refuses, and a reference to a tool it is not sent, as that provider does.
    const wire = this.wireOf(req.model);
    if (wire) { const refused = schemaRefusal(req, wire); if (refused) throw refused; }
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
    if (process.env.KEEL_SCRIPTED_CACHE === "prefix" && req.purpose !== "reader" && req.purpose !== "title") {
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
    if (this.ttl && req.purpose !== "reader") {
      const at = `${req.sessionKey}\u0000${req.model}`;
      const now = Date.now();
      if ((this.lives.get(at) ?? 0) <= now) { usage.cache_write += usage.cache_read; usage.cache_read = 0; }
      this.lives.set(at, now + this.ttl);
    }
    // A request that keeps the cache warm is read, not answered. It is held to
    // what the streaming endpoints document of max_tokens, as Bedrock's
    // InvokeModelWithResponseStream states it (a required integer; nothing says
    // 0 is taken, and Anthropic refuses 0 with stream: true): a request that
    // asks for less than one token is refused in a validation error's words.
    if (req.purpose === "warm") {
      if (!Number.isInteger(req.maxTokens) || req.maxTokens! < 1) throw classify("Scripted", 400, new Headers(), JSON.stringify({ message: "ValidationException: max_tokens: must be an integer of at least 1 on a streaming request" }));
      usage.output = 1;
      return { blocks: [], usage, stop: "max_tokens", model: req.model };
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
      // A judge whose stream counted the prompt and then said nothing: its time limit ends it.
      if (action.includes("judge-slow.txt")) {
        for (let i = 0; i < 600 && !req.signal.aborted; i++) await Bun.sleep(50);
        throw reportUsage(req.signal.reason ?? Object.assign(new Error("interrupted"), { name: "AbortError" }), usage);
      }
      // A judge that thinks before its verdict, as an adaptive thinking model does: about 1,500
      // tokens of thought at a high effort (or none named), 300 at a low one. A limit that leaves no
      // room after the thought ends the reply there, with no verdict.
      if (action.includes("judge-thinks.txt")) {
        const thought = req.effort === "low" ? 300 : 1_500;
        const thinking = { type: "thinking" as const, thinking: "Weighing the action against the owner's messages.", signature: "scripted" };
        if (req.maxTokens !== undefined && req.maxTokens < thought + 100) return { blocks: [thinking], usage: { ...usage, output: req.maxTokens }, stop: "max_tokens", model: req.model };
        const verdict = await reply('{"decision":"allow","risk":"low","reason":"The owner asked for this file."}');
        return { ...verdict, blocks: [thinking, ...verdict.blocks], usage: { ...verdict.usage, output: verdict.usage.output + thought } };
      }
      // A web request judged as a send: refused, and the reason repeats what the judge was shown of it.
      const sent = /^ tool \S+ \(send\)\n([\s\S]*?)(?:\n\nIts (?:input|options):|$)/.exec(action);
      if (sent) return reply(JSON.stringify({ decision: "deny", risk: "high", reason: `The fixture was shown: ${sent[1]!.split("\n").join(" | ")}`.slice(0, 390) }));
    }

    // A title request (src/engine/title.ts): the words after `script:title` in
    // the newest prompt that has them, else the first prompt's first line as it
    // is (the title the session already has, so a spec that reads it is not moved).
    if (req.purpose === "title") {
      const prompts = [...lastText.matchAll(/<prompt>\n([\s\S]*?)\n<\/prompt>/g)].map((m) => m[1]!);
      const named = prompts.map((p) => p.match(/script:title[ \t]+([^\n]+)/)?.[1]?.trim()).filter(Boolean).at(-1);
      return reply(named ?? (prompts[0] ?? "").split("\n").find((l) => l.trim()) ?? "");
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
    //   script:image-cap N    one with more than N images gets a 413, every time
    //   script:image-always   every request is refused in an image's words
    // Each of them, and script:images, replies with the sizes of the images
    // the request carried, how many were left out as notes, and how often
    // that same request was sent.
    const pics = (msgs as any[]).flatMap((m) => (m.role !== "user" ? [] : m.content.flatMap((b: any) => (b.type === "image" ? [b] : b.type === "tool_result" && Array.isArray(b.content) ? b.content.filter((c: any) => c.type === "image") : []))));
    // `script:byte-cap N`: a request whose messages are over N bytes gets a 413, every time (no image needed).
    // The reply says how many bytes the request that passed was and how many tool results it carried shortened.
    const byteCap = (req.purpose === "summary" ? lastText : owner).match(/script:byte-cap[ \t]+(\d+)/);
    if (byteCap && JSON.stringify(msgs).length > Number(byteCap[1])) throw classify("Scripted", 413, new Headers(), JSON.stringify({ type: "error", error: { type: "request_too_large", message: "Request exceeds the maximum size" } }));
    const rule = (req.purpose === "summary" ? lastText : owner).match(/script:image-(limit|bad|none|large|cap|always)(?:\s+(\d+))?/);
    if (rule && (pics.length || rule[1] === "always")) {
      const refuse = (message: string, status = 400) => classify("Scripted", status, new Headers(), JSON.stringify({ type: "error", error: { type: status === 413 ? "request_too_large" : "invalid_request_error", message } }));
      const at = "messages.0.content.0.image.source.base64.data";
      const limit = Number(rule[2] ?? 0);
      if (rule[1] === "limit" && pics.some((b) => { const z = imageSize(b.data); return !z || z.w > limit || z.h > limit; })) throw refuse(`${at}: At least one of the image dimensions exceed max allowed size for many-image requests: ${limit} pixels`);
      if (rule[1] === "none" || rule[1] === "always") throw refuse(`${at}: Could not process image`);
      if (rule[1] === "cap" && pics.length > limit) throw refuse("Request exceeds the maximum size", 413);
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
    // A declined task's brief restated (src/automation/successor.ts): the scripted model gives it back as it was.
    if (String(req.system ?? "").includes(REWORD_SYSTEM)) return reply(lastText.match(/<brief>\n([\s\S]*)\n<\/brief>/)?.[1] ?? "");
    // A question matched to the owner's standing rulings (src/automation/rulings.ts): by the words they share.
    if (String(req.system ?? "").includes(RULING_SYSTEM)) return reply(standInMatch(lastText));
    // A recurring failure drafted into a lesson (src/automation/lessons.ts): a note from its first example.
    if (String(req.system ?? "").includes(LESSON_SYSTEM)) return reply(standInDraft(lastText));
    if (String(req.system ?? "").includes(KIND_SYSTEM)) return reply(standInKind(lastText));

    // `script:replies ["...", "..."]`: these texts, one per reply, in order,
    // the last one from then on. Later prompts that name no script get the
    // next text too, so a spec can see what a follow-up prompt is answered.
    const repliesAt = msgs.findLastIndex((m) => m.role === "user" && textOf(m).includes("script:replies"));
    if (repliesAt >= 0 && !/script:(?!replies)[a-z-]+/.test(owner)) {
      const texts = callsAfter(textOf(msgs[repliesAt]), "script:replies").map(String);
      const said = msgs.slice(repliesAt + 1).filter((m) => m.role === "assistant").length;
      return reply(texts[Math.min(said, texts.length - 1)] ?? "Scripted reply.");
    }
    // `script:no-credit-fresh MODEL` on a later line: that model's account is out of credit for a fresh
    // context's first request (a successor's capsule, src/automation/successor.ts) and answers the
    // credit refusal there; the context that wrote the line, and other models, are answered as usual.
    const noCredit = owner.match(/\nscript:no-credit-fresh[ \t]+(\S+)/)?.[1];
    if (noCredit && noCredit === req.model && owner.includes("with a fresh context:")) throw new ProviderError("quota", "Scripted: your credit balance is too low to make this request. Add credits at https://example.com/billing.", 402);
    const scenario = owner.match(/script:([a-z-]+)/)?.[1] ?? "";
    // `script:refuse-schema NAME`: the provider refuses the input schema of the tool NAME (by its
    // own name or as an MCP tool's) while it is declared with its parameters, in the words of the
    // model's wire (the Anthropic wire's for a model of none), naming it as that wire does.
    const refuseName = scenario === "refuse-schema" ? owner.match(/script:refuse-schema[ \t]+(\S+)/)?.[1] : undefined;
    const refusedOne = refuseName ? req.tools.find((t) => t.name === refuseName || t.name.endsWith(`__${refuseName}`)) : undefined;
    const refusedKey = `${req.sessionKey}\u0000${owner}`;
    if (refusedOne && !bareSchema(refusedOne.input_schema)) {
      this.schemaRefused.set(refusedKey, (this.schemaRefused.get(refusedKey) ?? 0) + 1);
      throw schemaRefusal(req, wire ?? "anthropic_messages", refusedOne.name)!;
    }
    // An outage the prompt asks for, at the request it names. Its start is this request's own failure.
    const ownerAt = msgs.findLastIndex((m) => m.role === "user" && own(m) === owner);
    const round = msgs.slice(ownerAt + 1).filter((m) => m.role === "assistant").length;
    const asked = scenario === "outage" ? owner.match(/script:outage[ \t]+([a-z]+)[ \t]+(\d+)(?:[ \t]+on[ \t]+([\w-]+))?/) : null;
    const later = owner.match(/\nscript:outage-at[ \t]+(\d+)[ \t]+([a-z]+)[ \t]+(\d+)(?:[ \t]+on[ \t]+([\w-]+))?/);
    const due = asked ? { n: 0, kind: asked[1]!, ms: Number(asked[2]), on: asked[3] } : later ? { n: Number(later[1]), kind: later[2]!, ms: Number(later[3]), on: later[4] } : undefined;
    if (due && (!due.on || due.on === this.id) && round === due.n && this.begin(String(Bun.hash(`${req.sessionKey}\u0000${owner}`)), due.kind, due.ms)) throw this.down("requests")!;
    // An overload the prompt asks for: the provider answers 529 to every request for a while.
    const over = scenario === "overloaded" ? owner.match(/script:overloaded[ \t]+(\d+)(?:[ \t]+on[ \t]+([\w-]+))?/) : null;
    const overKey = String(Bun.hash(`${req.sessionKey}\u0000${owner}`));
    if (over && (!over[2] || over[2] === this.id) && !this.busy.started.has(overKey)) {
      this.busy.started.add(overKey);
      this.busy.until = Date.now() + Math.min(Number(over[1]), 600_000);
    }
    if (Date.now() < this.busy.until) throw new ProviderError("overloaded", "Scripted: 529 overloaded", 529);
    const compacted = msgs.some((m) => textOf(m).startsWith("[harness] This conversation was compacted"));

    switch (scenario) {
      case "outage":
        return reply("Answered after the outage.");
      case "overloaded":
        return reply("Answered after the overload.");
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
      case "auth":
        // A refused credential: the turn fails at once, nothing is tried again.
        throw new ProviderError("auth", "Scripted: HTTP 401: the API key was refused.", 401);
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
        // `script:then-summary` on a later line: once a summary replaced the context (the prompt is
        // inside it now), the model goes on from it and reports what it read there, as one that
        // follows a summary does, instead of starting the calls again.
        if (/\nscript:then-summary\b/.test(owner) && head.startsWith("[harness] This conversation was compacted")) {
          return reply(`Went on from the summary: ${head.match(/State: [^\n]*/)?.[0] ?? head.split("\n")[2] ?? ""}`);
        }
        const done = msgs.slice(at + 1).filter((m) => m.role === "assistant").length;
        // `script:then-calls [...]` on a later line: each input that comes after the calls and is not a
        // tool result (a harness note, a parent's message) is answered with these calls, in order, and a
        // reply naming the last result, as a model that follows what it was sent does.
        if (/\nscript:then-calls[ \t]/.test(owner)) {
          const h = msgs.findLastIndex((m) => m.role === "user" && !(m.content as any[]).some((b) => b.type === "tool_result"));
          if (h > at) {
            const then = callsAfter(owner, "script:then-calls");
            const k = msgs.slice(h + 1).filter((m) => m.role === "assistant").length;
            const c = then[k];
            if (c && typeof c.after_ms === "number") await Bun.sleep(Math.max(0, Math.min(c.after_ms, 10_000)));
            if (c) return reply(typeof c.say === "string" ? c.say : `Then step ${k + 1} of ${then.length}.`, "tool_use", [{ type: "tool_use", id: `then-${msgs.length}-${k}`, name: String(c.name), input: c.input ?? {} }]);
            const got = (last?.content as any[] | undefined)?.find((b) => b.type === "tool_result");
            const said = typeof got?.content === "string" ? got.content : (got?.content as any[] | undefined)?.map((b: any) => b.text ?? "").join("\n") ?? "";
            return reply(`Done with the ${then.length} call${then.length === 1 ? "" : "s"} it asked for.${said ? ` Last result: ${said.slice(0, 300)}` : ""}`);
          }
        }
        // An agent's budget is spent: it writes its report in words, as a model told so does.
        if (lastText.includes("[harness] Your budget for this task is spent")) return reply(`Report at the budget: ${done} of ${calls.length} steps taken.`);
        // `script:then-batch` on a later line: once a result said the reads could go as parallel calls in one
        // step (src/engine/read-run.ts), the calls left go in one reply, as a model that follows it does.
        if (/\nscript:then-batch\b/.test(owner)) {
          const after = msgs.slice(at + 1);
          const made = after.filter((m) => m.role === "assistant").flatMap((m) => m.content as any[]).filter((b) => b.type === "tool_use").length;
          const told = after.some((m) => m.role === "user" && (m.content as any[]).some((b) => b.type === "tool_result" && carried(b).some((t) => t.includes("parallel calls in one step"))));
          const left = calls.slice(made);
          if (told && left.length) return reply(`Reading the ${left.length} left in one step.`, "tool_use", left.map((c, i) => ({ type: "tool_use", id: `batched-${msgs.length}-${i}`, name: String(c.name), input: c.input ?? {} })));
          if (left.length) return reply(`Step ${made + 1} of ${calls.length}.`, "tool_use", [{ type: "tool_use", id: `call-${msgs.length}-${made}`, name: String(left[0]!.name), input: left[0]!.input ?? {} }]);
          return reply(`Done with ${calls.length} reads in ${after.filter((m) => m.role === "assistant").length} steps.`);
        }
        const next = calls[done];
        if (next) {
          // `after_ms` on a call: the model takes that long before it makes it, as a real one does (at most 10 s).
          // `think` on a call: thinking streamed first, as a thinking model's reply has it (kept as its block).
          const thought = typeof next.think === "string" ? next.think : "";
          if (thought) for (const part of thought.match(/.{1,24}/gs) ?? []) { await Bun.sleep(pace); onDelta({ kind: "thinking", index: 0, text: part }); }
          if (typeof next.after_ms === "number") await Bun.sleep(Math.max(0, Math.min(next.after_ms, 10_000)));
          // `say` on a call: the words of the reply that makes it, in place of "Step N of M."
          const said = await reply(typeof next.say === "string" ? next.say : `Step ${done + 1} of ${calls.length}.`, "tool_use", [{ type: "tool_use", id: `call-${msgs.length}-${done}`, name: String(next.name), input: next.input ?? {} }]);
          return thought ? { ...said, blocks: [{ type: "thinking", thinking: thought, signature: "scripted" } as any, ...said.blocks] } : said;
        }
        const lastResult = (last?.content as any[] | undefined)?.find((b) => b.type === "tool_result");
        // `script:then-refuse` on a later line: once the calls ran, the model declines (a refusal after some work).
        if (/\nscript:then-refuse\b/.test(owner)) {
          const r = await reply("I will not go on with this.");
          return { ...r, stop: "refusal", stop_details: { category: "cyber", explanation: "Scripted refusal for the test." } };
        }
        // `script:then-find <word> ...` on a later line: an input that comes after the calls (a wait's
        // wake, or a steer that came with the last call's result) is answered from its own text, as a model
        // that read it does: for each word, its line there, or "Not in the request." (it makes no call to read anything).
        const thenFind = owner.match(/\nscript:then-find[ \t]+([^\n]+)/)?.[1];
        const steered = (last?.content as any[] | undefined)?.some((b) => b.type === "text" && carried(b).length);
        if (thenFind && last?.role === "user" && (!lastResult || steered)) {
          const lines = (last.content as any[]).flatMap(carried).flatMap((t) => t.split("\n"));
          return reply(thenFind.split(/\s+/).filter(Boolean).map((w: string) => lines.find((l: string) => l.includes(w))?.trim().slice(0, 240) ?? "Not in the request.").join("\n"));
        }
        // An image in the result is named by its color, as a model that looked at it would.
        const said = typeof lastResult?.content === "string" ? lastResult.content : (lastResult?.content as any[] | undefined)?.map((b: any) => b.type === "image" ? `an image, ${colorOf(b.data)}` : b.text ?? "").join("\n") ?? "";
        return reply(`Done with ${calls.length} call${calls.length === 1 ? "" : "s"}.${said ? ` Last result: ${said.slice(0, 300)}` : ""}`);
      }
      case "obey": {
        // `script:obey [{"name":...,"input":...}, ...]`: these calls in order, as script:calls makes them, and
        // then the call a tool result asks for on a line `please call: {"name":...,"input":...}`, as a model a
        // page has taken in makes it. A result that asks for nothing ends the turn with a reply quoting it.
        const calls = callsAfter(owner, "script:obey");
        const at = msgs.findLastIndex((m) => m.role === "user" && textOf(m).includes("script:obey"));
        const done = msgs.slice(at + 1).filter((m) => m.role === "assistant").length;
        const next = calls[done];
        if (next) return reply(`Step ${done + 1} of ${calls.length}.`, "tool_use", [{ type: "tool_use", id: `obey-${msgs.length}-${done}`, name: String(next.name), input: next.input ?? {} }]);
        const got = (last?.content as any[] | undefined)?.find((b) => b.type === "tool_result");
        const said = typeof got?.content === "string" ? got.content : (got?.content as any[] | undefined)?.map((b: any) => b.text ?? "").join("\n") ?? "";
        const asked = /^please call: (\{.*\})$/m.exec(said);
        if (asked && !got?.is_error) {
          try {
            const c = JSON.parse(asked[1]!);
            return reply("Doing what the page asks.", "tool_use", [{ type: "tool_use", id: `obey-${msgs.length}-asked`, name: String(c.name), input: c.input ?? {} }]);
          } catch {}
        }
        return reply(`Done. Last result: ${said.slice(0, 300)}`);
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
      case "account-limit": {
        const key = `${req.sessionKey}\u0000${owner}`;
        if (!this.limitStarted.has(key)) {
          this.limitStarted.add(key);
          const ms = Number(owner.match(/script:account-limit[ \t]+(\d+)/)?.[1]) || 5_000;
          const until = Date.now() + Math.min(ms, 600_000);
          this.limits.set(account, { until, refused: 1, answered: 0 });
          throw this.limitedAnswer(req, until);
        }
        // Once the limit passed, its prompt is answered as a waiting one is.
        return reply(this.placeWords(account));
      }
      case "account-wait":
        return reply(this.placeWords(account));
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
      case "overloaded-burst":
        // A burst longer than the counted retries, in the two forms one provider says it in (a
        // stream's exception and an HTTP 503), each asking for a short wait so the spec is quick.
        if (attempt < 12) throw new ProviderError("overloaded", attempt % 2 ? "Scripted: HTTP 503: the model is unable to process your request." : "Scripted stream: serviceUnavailableException: the model is unable to process your request.", attempt % 2 ? 503 : undefined, 100);
        return reply("Answered after the burst passed.");
      case "overloaded-long":
        // Overloaded twelve times, past the counted retries, with no wait asked for: the engine's own backoff.
        if (attempt < 12) throw new ProviderError("overloaded", "Scripted: 529 overloaded", 529);
        return reply("Answered after a long overload.");
      case "overloaded-asks":
        // Overloaded, and the provider asks for a wait longer than a turn waits (KEEL_RETRY_WAIT_MAX_MS).
        if (attempt === 0) throw new ProviderError("overloaded", "Scripted: 529 overloaded, retry after a while", 529, 400_000);
        return reply("Answered after the asked wait.");
      case "drop":
        if (attempt === 0) {
          for (const part of ["This half reply ", "is dropped with the stream"]) {
            onDelta({ kind: "text", index: 0, text: part });
            await Bun.sleep(300);
          }
          // The stream had counted its prompt and the half it sent: the failed attempt reports them.
          throw reportUsage(new ProviderError("network", "Scripted: the stream broke"), { ...usage, output: tokens("This half reply is dropped with the stream") });
        }
        return reply("The whole reply, after the dropped stream.");
      case "drop-same":
        // As drop, and the request sent again starts its reply as the broken one did (a client must not show that part twice).
        if (attempt === 0) {
          onDelta({ kind: "text", index: 0, text: "The same start " });
          await Bun.sleep(300);
          throw new ProviderError("network", "Scripted: the stream broke");
        }
        return reply("The same start and the whole rest.");
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
      case "silent": {
        // `script:silent <path>`: no reply at all until that file exists, the
        // turn is stopped, or a minute passed: a turn whose reply has not started.
        // A stop ends the request as a real stream's does.
        const gate = owner.match(/script:silent\s+(\S+)/)?.[1];
        for (let i = 0; i < 600 && gate && !existsSync(gate) && !req.signal.aborted; i++) await Bun.sleep(100);
        if (req.signal.aborted) throw Object.assign(new Error("interrupted"), { name: "AbortError" });
        return reply("Answered after a silent wait.");
      }
      case "started": {
        // `script:started <path>`: the stream's start counted the prompt (1,000 tokens read, 50,000
        // from the cache, as a message_start reports them), then nothing until that file exists, the
        // turn is stopped, or a minute passed. A stop ends the request with what its start reported.
        const gate = owner.match(/script:started\s+(\S+)/)?.[1];
        const begun = { ...usage, input: 1_000, cache_read: 50_000, cache_write: 0, output: 0 };
        for (let i = 0; i < 600 && gate && !existsSync(gate) && !req.signal.aborted; i++) await Bun.sleep(100);
        if (req.signal.aborted) throw reportUsage(Object.assign(new Error("interrupted"), { name: "AbortError" }), begun);
        const r = await reply("Answered after the stream's start.");
        return { ...r, usage: { ...begun, output: r.usage.output } };
      }
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
      case "block-later": {
        // `script:block-later <ms> <after_ms>`: answers at once, and holds the
        // loop that long from a timer after `after_ms`, as a callback nothing
        // times does when the daemon has gone idle again.
        const [, ms, after] = owner.match(/script:block-later\s+(\d+)\s+(\d+)/) ?? [];
        setTimeout(() => {
          const until = performance.now() + Math.min(Number(ms ?? 1500), 30_000);
          for (;;) if (performance.now() >= until) break;
        }, Math.min(Number(after ?? 8000), 120_000));
        return reply("Answered; the daemon is held later.");
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
      case "review": {
        // `script:review` in a review task's diff: a reviewer that answers with
        // one finding (P1) for each added line that says BUG: <title>, at its
        // file and line on the new side, as a real reviewer's JSON answer.
        const findings: { file: string; line: number; priority: number; title: string; body: string }[] = [];
        let file = "", line = 0;
        for (const l of owner.split("\n")) {
          if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); continue; }
          const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
          if (h) { line = Number(h[1]); continue; }
          if (!line || l.startsWith("-")) continue;
          if (l.startsWith("+") || l.startsWith(" ")) {
            const bug = l.startsWith("+") ? /BUG: ([^\n]+)/.exec(l) : null;
            if (bug) findings.push({ file, line, priority: 1, title: bug[1]!.trim(), body: `Line ${line} of ${file} says so.` });
            line++;
          }
        }
        const answer = { findings, verdict: findings.length ? "incorrect" : "correct", summary: `The scripted reviewer read ${new Set(findings.map((f) => f.file)).size || "the"} changed file${findings.length === 1 ? "" : "s"}.`, reading_order: [] };
        return reply("```json\n" + JSON.stringify(answer) + "\n```");
      }
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
      case "images": case "image-limit": case "image-bad": case "image-none": case "image-large": case "image-cap": {
        const left = (msgs as any[]).flatMap((m) => (m.role !== "user" ? [] : m.content.flatMap((b: any) => (b.type === "tool_result" && Array.isArray(b.content) ? b.content : [b])))).filter((b: any) => b.type === "text" && String(b.text).startsWith("[Image left out")).length;
        return reply(`Images: ${pics.map((b) => { const z = imageSize(b.data); return z ? `${z.w}x${z.h}` : "unreadable"; }).join(", ") || "none"}. Left out: ${left}. Attempt ${attempt + 1}.`);
      }
      case "byte-cap": {
        const cut = JSON.stringify(msgs).split("[Output shortened:").length - 1;
        return reply(`Request: ${JSON.stringify(msgs).length} bytes. Shortened: ${cut}. Attempt ${attempt + 1}.`);
      }
      case "refuse-schema": {
        const n = this.schemaRefused.get(refusedKey) ?? 0;
        return reply(refusedOne ? `The tool ${refusedOne.name} was declared ${bareSchema(refusedOne.input_schema) ? "without its parameters" : "with its parameters"}, after ${n} refusal${n === 1 ? "" : "s"} of its schema.` : `No tool named ${refuseName} was declared.`);
      }
      default:
        return reply(compacted ? "Scripted reply, after a compaction." : "Scripted reply.");
    }
  }
}

const bareSchema = (s: unknown) => s === BARE_SCHEMA || JSON.stringify(s) === '{"type":"object"}';

// A request the provider of `wire` refuses over a tool's input schema: its
// body built by the wire's own codec, each tool's schema read as the wire
// sends it and checked by the wire's rules (wires/schema-fit.ts), and the
// refusal in that provider's words, naming the tool as it does (the Anthropic
// wire by its position, OpenAI by its name, Gemini by its declaration's
// position). `only`: refuse this tool (a request's name), whatever its schema.
function schemaRefusal(req: ProviderRequest, wire: Wire, only?: string): ProviderError | undefined {
  const ctx = { origin: `scripted:${req.model}`, sessionKey: req.sessionKey ?? "", efforts: [] };
  const refuse = (message: string) => classify("Scripted", 400, new Headers(), JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
  // (On the Responses wire an MCP tool is declared in its server's namespace by the rest of its name.)
  const first = (name: string, schema: unknown) => (only ? (name === only || only.endsWith(`__${name}`) ? "refused" : undefined) : schemaRefusals(schema, wire)[0]);
  let body: any;
  try {
    body = wire === "anthropic_messages" ? anthropicBody(req, ctx) : wire === "openai_responses" ? responsesBody(req, ctx, "openai") : wire === "gemini_generate_content" ? geminiBody(req, ctx) : undefined;
  } catch {
    return undefined;
  }
  if (!body) return undefined;
  if (wire === "anthropic_messages") {
    const i = (body.tools ?? []).findIndex((t: any) => first(t.name, t.input_schema));
    // A tool_reference in a result to a tool the request does not declare (valid.ts anthropicProblems).
    if (i < 0 && !only) {
      const declared = new Set((body.tools ?? []).map((t: any) => t.name));
      for (const [m, msg] of (body.messages ?? []).entries()) for (const [k, b] of (Array.isArray(msg.content) ? msg.content : []).entries()) {
        if (b.type !== "tool_result" || !Array.isArray(b.content)) continue;
        const ref = b.content.find((c: any) => c.type === "tool_reference" && !declared.has(c.tool_name));
        if (ref) return refuse(`messages.${m}.content.${k}: Tool reference '${ref.tool_name}' not found in available tools`);
      }
    }
    if (i < 0) return undefined;
    const why = first(body.tools[i].name, body.tools[i].input_schema)!;
    return refuse(/property name/.test(why)
      ? `tools.${i}.custom.input_schema.properties: Property keys should match pattern '^[a-zA-Z0-9_.-]{1,64}$'`
      : `tools.${i}.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12 (https://json-schema.org/draft/2020-12). Learn more about tool use at https://docs.claude.com/en/docs/tool-use.`);
  }
  if (wire === "openai_responses") {
    const fns = (body.tools ?? []).flatMap((t: any) => (t.type === "namespace" ? t.tools : [t])).filter((t: any) => t.type === "function");
    const t = fns.find((x: any) => first(x.name, x.parameters));
    if (!t) return undefined;
    const why = first(t.name, t.parameters)!;
    return refuse(/missing items/.test(why)
      ? `Invalid schema for function '${t.name}': In context=('properties',), array schema missing items.`
      : `Invalid schema for function '${t.name}': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level.`);
  }
  const decls: any[] = body.tools?.[0]?.functionDeclarations ?? [];
  const i = decls.findIndex((d) => first(d.name, d.parametersJsonSchema));
  if (i < 0) return undefined;
  return refuse(`* GenerateContentRequest.tools[0].function_declarations[${i}].parameters_json_schema: ${first(decls[i].name, decls[i].parametersJsonSchema)}`);
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
function callsAfter(text: string, word = "script:calls"): { name: unknown; input?: unknown; after_ms?: unknown; say?: unknown; think?: unknown }[] {
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

