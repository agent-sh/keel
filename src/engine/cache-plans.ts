// Runs the cache plan of each session that waits (src/engine/cache-plan.ts
// decides): a session parked on a wait it set, and a tool step that runs past
// the cache lifetime. Before the cache lapses the plan is decided again with
// what was spent: a warm request is sent, a summary is prepared, or nothing.
// When the wait ends the session's timeline gets one note of what was chosen,
// what it cost and what a rewrite of the context would have cost
// (`cache_plan`); each warm request is a call of its own in telemetry
// (purpose "warm"). A wait kept warm is told once the session's next request
// says whether it read the cache (`answered`): a warm request whose next
// request wrote the context again failed, and the note says so ("warm_missed").
// Nothing here enters the history the model reads: a warm request is sent
// beside it, and the note is not sent.
import type { Store } from "../core/store.ts";
import type { Message, Session, StoredEvent, Usage } from "../core/types.ts";
import type { ErrorTracker } from "../core/errors.ts";
import { priceOf } from "../providers/pricing.ts";
import { cacheLives } from "../providers/wires/common.ts";
import type { ModelInfo, Provider, ProviderResult } from "../providers/types.ts";
import { PAUSE_MARGIN_MS, retention } from "./cachewarn.ts";
import { decide, mins, type Choice, type Plan, type WaitShape } from "./cache-plan.ts";
import { bytesPerToken, lastWarm, replyBytes, utf8Bytes } from "./compact.ts";

export type PlanStep = { provider: Provider; info: ModelInfo };

// How a route keeps its cache, for a plan. A provider may say so itself
// (`Provider.caching`); else its wire's documented behaviour: on the Anthropic
// Messages wire a read refreshes the prefix's lifetime at the read price, and
// a one-token request is the documented way to do it ("pre-warming the
// cache", Anthropic's prompt caching guide). The Responses wire also
// refreshes on a read, but its driver goes on from the connection's last
// response, which a request beside the turn would change: no warm request
// there. Other wires document no refresh.
export function cacheOf(st: PlanStep, events: readonly StoredEvent[]): { life: number; warmable: boolean } {
  const own = st.provider.caching;
  if (own) return { life: own.life, warmable: own.refresh === "read" };
  const life = retention(st.provider.wire, events, st.info.id).sure;
  return { life, warmable: st.provider.wire === "anthropic_messages" && st.info.caching !== false };
}

// What a request needs of the lifetime before it ends (PAUSE_MARGIN_MS, a
// minute: a long context's request takes up to half of that and timers run
// late), or a quarter of a lifetime shorter than four of them.
export const marginOf = (life: number) => Math.min(PAUSE_MARGIN_MS, Math.floor(life / 4));

// The words of the request that keeps the cache warm: read, never answered (one output token at most).
export const WARM_TEXT = "[harness] A request that keeps the prompt cache warm while this session waits. Nothing to answer.";

type Deps = {
  store: Store;
  errors: ErrorTracker;
  append(id: string, kind: "note", data: unknown): StoredEvent;
  isRunning(id: string): boolean;
  // The owner's Stop (or another stop that holds the queue) holds the session: nothing is sent for it.
  isHeld(id: string): boolean;
  draining(): boolean;
  // What the session waits on now; nothing once its waits were cancelled, fired or the agent stopped.
  waitShape(id: string): WaitShape | undefined;
  // The session's model changed while it waited: its plan is made again for the new route.
  replan(id: string): void;
  // One request beside the history, quiet, priced and measured like any other.
  call(id: string, st: PlanStep, messages: Message[], signal: AbortSignal, fitTokens: number): Promise<ProviderResult>;
  // The context's summary, prepared while the cache is warm (idle compaction's own).
  prepare(id: string, st: PlanStep): void;
};

type Run = {
  id: string;
  kind: "park" | "tool";
  shape: WaitShape;
  started: number;
  touched: number;
  tokens: number;    // the context the cache holds
  extra: number;     // tokens a warm request adds after it
  spent: number;
  pings: number;
  missed: number;
  read: number;
  written: number;
  first: Plan;
  last: Plan;
  done: Choice[];    // what was carried out, in order
  timer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  step: () => Promise<PlanStep>;
  messages: () => Message[];
  summary?: number;  // dollars, when a summary may be prepared (a park of a long context)
  price: ModelInfo["price"];
  life: number;
  warmable: boolean;
  long: boolean;     // a rewrite after a lapse asks for the long lifetime
  model: string;
};

type Note = Record<string, any> & { text: string; outcome: string; route: string; tokens: number; waited_ms: number; pings: number; spent_usd: number; lapse_usd: number };
type Owed = { data: Note; touched: number; life: number; timer?: ReturnType<typeof setTimeout> };

export class CachePlans {
  private runs = new Map<string, Run>();
  // Waits kept warm, until the session's next request says whether they kept the cache.
  private owed = new Map<string, Owed>();
  // Routes that refused a warm request: they get none again in this process.
  private refused = new Set<string>();

  constructor(private d: Deps) {
    // The last warm read of a session's context, and what the warm reads of its wait (the one
    // that began at `since`) cost so far: a restart goes on with the same cap and the same start.
    d.store.migrate("CREATE TABLE IF NOT EXISTS cache_warm (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, model TEXT NOT NULL, ts INTEGER NOT NULL)");
    for (const [col, type] of [["since", "INTEGER"], ["spent", "REAL NOT NULL DEFAULT 0"], ["pings", "INTEGER NOT NULL DEFAULT 0"]] as const)
      if (!d.store.columnExists("cache_warm", col)) d.store.migrate(`ALTER TABLE cache_warm ADD COLUMN ${col} ${type}`);
    // Routes that refused a warm request: none is sent there again.
    d.store.migrate("CREATE TABLE IF NOT EXISTS cache_warm_refused (route TEXT PRIMARY KEY, ts INTEGER NOT NULL, error TEXT)");
    for (const r of d.store.db.query<{ route: string }, []>("SELECT route FROM cache_warm_refused").all()) this.refused.add(r.route);
  }

  // What the warm reads of the wait that began at `since` cost so far, and how many there were.
  private kept(id: string, since: number): { spent: number; pings: number } {
    const r = this.d.store.db.query<{ since: number | null; spent: number; pings: number }, [string]>("SELECT since, spent, pings FROM cache_warm WHERE session_id = ?").get(id);
    return r && r.since === since ? { spent: r.spent, pings: r.pings } : { spent: 0, pings: 0 };
  }

  // When a warm request last read this context's cache on `model` (0: none).
  warmedAt(id: string, model: string): number {
    const r = this.d.store.db.query<{ model: string; ts: number }, [string]>("SELECT model, ts FROM cache_warm WHERE session_id = ?").get(id);
    return r && r.model === model ? r.ts : 0;
  }

  // A session parked on a wait: its plan. `summary`: what preparing its summary
  // would cost and save, when that is allowed (the idle compaction's rules).
  park(session: Session, st: PlanStep, events: readonly StoredEvent[], shape: WaitShape, o: { tokens: number; step: () => Promise<PlanStep>; messages: () => Message[]; summaryTokens?: { out: number; after: number } }): Plan | undefined {
    const touched = Math.max(lastWarm(events, st.info.id), this.warmedAt(session.id, st.info.id));
    if (!touched) return undefined;
    const last = events.findLast((e) => e.kind === "assistant");
    const extra = Math.ceil((utf8Bytes(WARM_TEXT) + (last ? replyBytes(last.data.blocks ?? []) : 0)) / bytesPerToken(st.info.id));
    return this.start({ id: session.id, kind: "park", shape, touched, tokens: o.tokens, extra, st, events, step: o.step, messages: o.messages, summaryTokens: o.summaryTokens });
  }

  // A tool step: the plan holds while it runs; the returned function ends it.
  // `messages`: the history the step's request was sent with, as the session's
  // next request projects it (the notes the request's hooks stored included).
  tool(id: string, st: PlanStep, events: readonly StoredEvent[], messages: () => Message[], shape: WaitShape, sentAt: number, u: Usage): () => void {
    if (u.cache_read + u.cache_write <= 0) return () => {};
    const tokens = u.input + u.cache_read + u.cache_write;
    const extra = Math.ceil(utf8Bytes(WARM_TEXT) / bytesPerToken(st.info.id));
    this.start({ id, kind: "tool", shape, touched: sentAt, tokens, extra, st, events, step: async () => st, messages });
    return () => this.end(id, "tool");
  }

  private start(o: { id: string; kind: Run["kind"]; shape: WaitShape; touched: number; tokens: number; extra: number; st: PlanStep; events: readonly StoredEvent[]; step: Run["step"]; messages: Run["messages"]; summaryTokens?: { out: number; after: number } }): Plan | undefined {
    this.end(o.id, o.kind === "tool" ? "replaced" : "park");
    const price = o.st.info.price;
    if (!price) return undefined; // no price: nothing to weigh
    const { life, warmable } = cacheOf(o.st, o.events);
    if (life <= 0) return undefined; // nothing says how long the provider keeps it
    const long = !!cacheLives(o.st.provider.wire);
    const now = Date.now();
    // A park goes on from when its wait began, with what its warm reads cost before a restart.
    const started = o.kind === "park" && o.shape.since ? o.shape.since : now;
    const had = o.kind === "park" ? this.kept(o.id, started) : { spent: 0, pings: 0 };
    const run: Run = {
      id: o.id, kind: o.kind, shape: o.shape, started, touched: o.touched, tokens: o.tokens, extra: o.extra,
      spent: had.spent, pings: had.pings, missed: 0, read: 0, written: 0, done: [], abort: new AbortController(), step: o.step, messages: o.messages,
      price, life, warmable: warmable && !this.refused.has(o.st.info.id), long, model: o.st.info.id,
      first: undefined as any, last: undefined as any,
    };
    if (o.summaryTokens) run.summary = this.summaryCost(run, o.summaryTokens);
    run.first = run.last = this.decide(run, now);
    this.runs.set(o.id, run);
    this.arm(run);
    return run.first;
  }

  // What the plan's choices cost, by the model's price: a warm request reads
  // the context up to the breakpoint the next request shares with it, and what
  // follows (the reply of a park, its own words) is plain input; a lapse writes
  // the whole context again at the lifetime the wake asks for; a summary reads
  // it, writes the summary and the wake writes what follows the summary.
  private ping = (r: Run) => priceOf({ input: r.extra, cache_read: r.tokens, cache_write: 0, output: 1 }, r.price) ?? 0;
  private lapse = (r: Run) => this.write(r, r.tokens);
  private write = (r: Run, tokens: number) => priceOf({ input: 0, cache_read: 0, cache_write: tokens, ...(r.long ? { cache_write_1h: tokens } : {}), output: 0 }, r.price) ?? 0;
  private summaryCost = (r: Run, t: { out: number; after: number }) => (priceOf({ input: 0, cache_read: r.tokens, cache_write: 0, output: t.out }, r.price) ?? 0) + this.write(r, t.after);

  private decide(r: Run, now: number): Plan {
    return decide({
      now, started: r.started, touched: r.touched, life: r.life, margin: marginOf(r.life), warmable: r.warmable, wait: r.shape, spent: r.spent,
      costs: { ping: this.ping(r), lapse: this.lapse(r), ...(r.summary !== undefined ? { summary: r.summary } : {}) },
    });
  }

  private arm(r: Run) {
    clearTimeout(r.timer);
    if (r.last.choice !== "warm" && r.last.choice !== "summary") return;
    r.timer = setTimeout(() => void this.act(r).catch((e) => this.d.errors.capture("provider", e, { session: r.id, at: "cache plan" })), Math.max(0, r.last.at - Date.now()));
    (r.timer as any).unref?.();
  }

  // Before the cache lapses: decided again with what was spent, then done.
  private async act(r: Run) {
    if (this.runs.get(r.id) !== r || this.d.draining()) return;
    const s = this.d.store.session(r.id);
    if (!s || s.archived) return this.end(r.id, "gone");
    if (this.d.isHeld(r.id)) return this.end(r.id, "held");
    if (r.kind === "park") {
      if (this.d.isRunning(r.id)) return this.end(r.id, "woke");
      // Its waits were cancelled (the agent was stopped) or ended: nothing is waited for any more.
      const shape = this.d.waitShape(r.id);
      if (!shape) return this.end(r.id, "cancelled");
      r.shape = shape;
      // Another model now: its route's cache is another one.
      if (s.model !== r.model) { this.end(r.id, "switched"); return this.d.replan(r.id); }
    }
    r.last = this.decide(r, Date.now());
    if (r.last.choice !== "warm" && r.last.choice !== "summary") return;
    const st = await r.step();
    if (this.runs.get(r.id) !== r) return;
    if (r.last.choice === "summary") {
      r.done.push("summary");
      this.d.prepare(r.id, st);
      return;
    }
    const t0 = Date.now();
    let res: ProviderResult;
    try {
      res = await this.d.call(r.id, st, withWarm(r.messages(), r.kind), r.abort.signal, r.tokens + r.extra);
    } catch (e) {
      if (r.abort.signal.aborted) return;
      // A route that refuses the request (a platform without it) gets none again; the plan goes on without.
      if (typeof (e as any)?.status === "number" && (e as any).status >= 400 && (e as any).status < 500 && (e as any).status !== 429) {
        this.refused.add(r.model);
        this.d.store.db.query("INSERT OR REPLACE INTO cache_warm_refused (route, ts, error) VALUES (?, ?, ?)").run(r.model, Date.now(), String((e as Error)?.message ?? e).slice(0, 300));
      }
      r.warmable = false;
      this.d.errors.capture("provider", e, { session: r.id, at: "a request that keeps the cache warm" }, { group: `warm request refused: ${r.model}` });
      r.last = this.decide(r, Date.now());
      this.arm(r);
      return;
    }
    if (this.runs.get(r.id) !== r) return;
    const u = res.usage;
    r.pings++;
    r.done.push("warm");
    r.spent += typeof u.cost === "number" ? u.cost : this.ping(r);
    r.read += u.cache_read;
    r.written += u.cache_write + u.input;
    // A warm request that read nothing found the cache gone: it wrote it again.
    if (u.cache_read < 0.5 * r.tokens) r.missed++;
    r.touched = t0;
    this.d.store.db.query("INSERT OR REPLACE INTO cache_warm (session_id, model, ts, since, spent, pings) VALUES (?, ?, ?, ?, ?, ?)").run(r.id, r.model, t0, r.started, r.spent, r.pings);
    r.last = this.decide(r, Date.now());
    this.arm(r);
  }

  // The wait is over (the session's next turn, the tool's result), or the session went.
  end(id: string, why: string) {
    const r = this.runs.get(id);
    if (!r) return;
    this.runs.delete(id);
    clearTimeout(r.timer);
    r.abort.abort();
    if (why === "replaced" || why === "park" || why === "gone" || why === "switched") return;
    const now = Date.now();
    // Nothing to tell: it ended before the cache would have lapsed, and nothing was sent.
    const lapsed = now > r.touched + r.life - marginOf(r.life);
    if (!r.done.length && !lapsed) return;
    const lapse = this.lapse(r);
    const outcome = lapsed ? (r.done.includes("summary") ? "summary" : "lapsed") : r.done.includes("warm") ? "warm" : "held";
    // Gone before the wait began (a daemon that was down, the last request long before it): the wait lost nothing.
    const before = outcome === "lapsed" && r.started >= r.touched + r.life - marginOf(r.life);
    const text = before ? beforeText(r.started - r.touched, lapse)
      : outcome === "warm" ? ""
      : outcome === "summary" ? `Prepared the summary while the cache was warm, for a wait of ${mins(now - r.started)}; writing the whole context again would cost ${usd(lapse)}`
      : outcome === "lapsed" ? `The prompt cache lapsed during a wait of ${mins(now - r.started)}${r.pings ? ` after ${r.pings} warm ${r.pings === 1 ? "request" : "requests"} for ${usd(r.spent)}` : ""}: writing the context again costs about ${usd(lapse)} (${r.first.why})`
      : `The wait ended before the cache lapsed`;
    const data: Note = {
      kind: "cache_plan", text, plan: r.kind, wait_kind: r.shape.kind, choice: r.first.choice, outcome, why: r.first.why,
      ...(before ? { before_wait: true, idle_ms: r.started - r.touched } : {}),
      ...(r.first.expect ? { expect_ms: r.first.expect.ms, expect_from: r.first.expect.from } : {}),
      waited_ms: now - r.started, life_ms: r.life, tokens: r.tokens, route: r.model,
      pings: r.pings, missed: r.missed, read_tokens: r.read, written_tokens: r.written,
      spent_usd: round(r.spent), lapse_usd: round(lapse), ...(r.summary !== undefined ? { summary_usd: round(r.summary) } : {}),
    };
    if (outcome !== "warm") return this.note(id, data);
    // Kept warm: told when the next request says whether it read the cache, or
    // once the cache's lifetime from the last read passed with no request.
    this.settle(id, "unchecked");
    const owed: Owed = { data, touched: r.touched, life: r.life };
    // (A session at work may have its next request in flight: it is waited for.)
    const arm = (ms: number) => {
      owed.timer = setTimeout(() => (this.d.isRunning(id) && this.owed.get(id) === owed ? arm(r.life) : this.settle(id, "unchecked")), Math.max(0, ms));
      (owed.timer as any).unref?.();
    };
    arm(r.touched + r.life - Date.now());
    this.owed.set(id, owed);
  }

  // Whether a wait kept warm waits for the session's next request to be told.
  owes(id: string) { return this.owed.has(id); }

  // The session's next turn request answered (`sentAt` its start, `usage` what
  // it read and wrote, `compactedAt` the time of its history's last
  // compaction): the wait kept warm is told by what it read. A request that
  // read less than half of what the warm requests kept (the rule a cache break
  // is counted by, src/admin/telemetry.ts) wrote the context again: the warm
  // requests failed. One on another route, or after a compaction, says nothing
  // of them. `cause`: the break the ledger counted for the request
  // (src/admin/telemetry.ts breakCause, "none" for a read): one it names by
  // something else (a changed prefix, an urgent build, a compaction) says
  // nothing of them either.
  answered(id: string, o: { route: string; usage: Usage; sentAt: number; compactedAt?: number; cause?: string }) {
    const w = this.owed.get(id);
    if (!w) return;
    const prompt = o.usage.input + o.usage.cache_read + o.usage.cache_write;
    if (o.route !== w.data.route || (o.compactedAt ?? 0) > w.touched || o.sentAt > w.touched + w.life) return this.settle(id, "unchecked");
    if (o.cause !== undefined && o.cause !== "none" && o.cause !== "warm_missed") return this.settle(id, "unchecked");
    this.settle(id, o.usage.cache_read >= 0.5 * Math.min(w.data.tokens, prompt) ? "read" : "missed", o.usage);
  }

  private settle(id: string, how: "read" | "missed" | "unchecked", u?: Usage) {
    const w = this.owed.get(id);
    if (!w) return;
    this.owed.delete(id);
    clearTimeout(w.timer);
    // (A session deleted meanwhile has nothing to be told.)
    if (!this.d.store.session(id)) return;
    const d = w.data;
    const long = mins(d.waited_ms), reqs = `${d.pings} warm ${d.pings === 1 ? "request" : "requests"}`;
    const next = u ? { next_read_tokens: u.cache_read, next_written_tokens: u.cache_write + u.input } : {};
    if (how === "read") return this.note(id, { ...d, ...next, text: warmText(long, reqs, d.spent_usd, d.lapse_usd) });
    if (how === "missed") return this.note(id, { ...d, ...next, outcome: "warm_missed", text: missedText(long, reqs, d.spent_usd, u!.cache_read, d.tokens, d.lapse_usd) });
    this.note(id, { ...d, outcome: "warm_unchecked", text: uncheckedText(long, reqs, d.spent_usd) });
  }

  private note(id: string, data: Note) {
    try { this.d.append(id, "note", data); } catch (e) { this.d.errors.capture("server", e, { session: id, at: "cache plan note" }); }
  }

  // The plan a session has now, for the page and telemetry.
  of(id: string): { kind: string; choice: Choice; why: string; at: number; pings: number; spent_usd: number; lapse_usd: number } | undefined {
    const r = this.runs.get(id);
    return r ? { kind: r.kind, choice: r.last.choice, why: r.last.why, at: r.last.at, pings: r.pings, spent_usd: round(r.spent), lapse_usd: round(this.lapse(r)) } : undefined;
  }

  stopAll() {
    // A wait kept warm that no request read after is told so now: this daemon will not see the next one.
    for (const id of [...this.owed.keys()]) this.settle(id, "unchecked");
    for (const id of [...this.runs.keys()]) {
      const r = this.runs.get(id)!;
      clearTimeout(r.timer);
      r.abort.abort();
      this.runs.delete(id);
    }
  }
}

// The history with the warm request's words after it: a message of its own
// after a reply, or a block at the end of the last message when that is the
// owner's side (a tool step waits for its results). Everything before them is
// the prefix the cache holds, byte for byte. The words are the request's last
// block, and the wire puts the cache breakpoint before them, on the last user
// block: where the session's last request put its own, so the warm request
// reads that entry at its breakpoint and keeps it, and the next request finds
// it (src/providers/wires/anthropic.ts toWire).
export function withWarm(messages: Message[], kind: "park" | "tool"): Message[] {
  const last = messages.at(-1);
  const block = { type: "text" as const, text: WARM_TEXT };
  if (kind === "tool" && last?.role === "user") return [...messages.slice(0, -1), { ...last, content: [...(last.content as any[]), block] } as Message];
  return [...messages, { role: "user", content: [block] } as Message];
}

// The notes of a wait kept warm (src/admin/timeline-rows.ts says the same from the note's data): the
// next request read the cache, wrote it again (the warm requests failed), or none came while it lived.
export const warmText = (long: string, reqs: string, spent: number, lapse: number) =>
  `Kept the prompt cache warm through a wait of ${long}: ${reqs} for ${usd(spent)}, and the next request read it, where writing the context again would cost ${usd(lapse)}`;
export const missedText = (long: string, reqs: string, spent: number, read: number, tokens: number, lapse: number) =>
  `The warm requests did not keep the prompt cache through a wait of ${long}: ${reqs} for ${usd(spent)}, and the next request read ${read.toLocaleString("en-US")} of ${tokens.toLocaleString("en-US")} tokens and wrote the rest again for about ${usd(lapse)}`;
export const uncheckedText = (long: string, reqs: string, spent: number) =>
  `Sent ${reqs} for ${usd(spent)} through a wait of ${long}; no request read the cache while it lived after them, so whether they kept it is not known`;

// The note of a cache that had lapsed before its wait began: `idle` is the time from the request that
// last read it to the wait's start. (src/admin/timeline-rows.ts says the same from the note's data.)
export const beforeText = (idle: number, lapse: number) =>
  `The prompt cache had lapsed before this wait began, ${mins(idle)} after the request that last read it: nothing could keep it, and the next request writes the context again for about ${usd(lapse)}`;

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const usd = (x: number) => (x >= 1 ? `$${x.toFixed(2)}` : x >= 0.01 ? `$${x.toFixed(3)}` : `$${x.toFixed(4)}`);
