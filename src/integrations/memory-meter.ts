// What memory costs and whether it is used, measured for every recall and
// kept without content: one row per time a recall path was asked (the external
// store's session start, prompt and tool blocks, the helper's records), with
// what it added (facts, tokens), what it left out (already in the context, over
// the turn's budget), how long the turn waited for it, how it ended, and, once
// the turn is over, how many of the facts the turn's output named.
//
// "Used" is a proxy: a fact counts when the reply or a tool call of its turn
// holds one of its names as a word, or three of its words in a row that are
// not all common ones, or when a tool call of the turn touches a path, a
// file, a flag or a quoted command the fact names. The words are held in
// memory until the turn ends and are never stored.
//
// What the store gave is also kept per fact (memory_given): its name, when,
// by which hook and for which call, the tokens of its line and, once the
// turn is over, whether the turn named it. Names and ids only: a fact's text
// is read from the store when the owner opens it (memory-store.ts), and a
// line whose name is not one the store gives a fact gets no row, so a line of
// another shape never puts its text there. The rows go with their session:
// in parts, between other work, so deleting a session that was given
// thousands of facts does not hold the loop for all of them at once.
import { ownerPrompt } from "../core/owner.ts";
import type { Store } from "../core/store.ts";
import { bytesPerToken } from "../engine/compact.ts";
import { registerHooks } from "../engine/hooks.ts";
import { SessionMap } from "../core/session-map.ts";
import { readsOf, type Reads } from "../server/reads.ts";
import { isFactName } from "./memory-store.ts";

// Which inputs the store is asked about. Everything that asks for work is:
// the owner's words, an agent's or a verifier's task, a parent's steer, a
// peer's message, a loop's run (its prompt is the owner's standing words), a
// goal's start and resume (they carry the objective). What the harness
// delivers about something that happened is not: an agent's report, a wait's
// wake, a goal going on after a check, a failure notice, a digest, its own
// instructions, a continuation after a restart. Several deliveries in one
// input ask when any of them does.
const DELIVERED = new Set(["subagent", "wait", "failures", "helper_digest", "harness"]);
type InputMeta = { kind?: unknown; origin?: unknown; goal?: unknown; parts?: unknown } | undefined;
export function asksMemory(d: InputMeta): boolean {
  if (ownerPrompt(d)) return true;
  if (!d || d.origin === "harness" || d.origin === "restart") return false;
  if (d.kind === "wake") return Array.isArray(d.parts) && d.parts.some((p) => asksMemory(p as InputMeta));
  if (d.kind === "goal") return d.goal === "start" || d.goal === "resume";
  return !DELIVERED.has(String(d.kind ?? ""));
}

// store_owed: lines the store gave earlier that joined a later request (a
// block was full, or the answer came after its request went).
export type MemoryPath = "store_start" | "store_prompt" | "store_tool" | "store_owed" | "helper";
export const MEMORY_PATHS: MemoryPath[] = ["store_start", "store_prompt", "store_tool", "store_owed", "helper"];
// Rows are kept this long: three times the longest range the Usage views
// show (a month), so this month can be read against the ones before it.
export const KEEP_MS = 90 * 86_400_000;
// added: the turn got a block; empty: the store had nothing; repeat: all of it
// was in the context already; skipped: not asked (an input that is not a
// request, or one of the session's calls was still out); timeout: the turn
// waited its full wait and went on without the answer; late: the turn did
// not wait at all (the store was already not answering in time). What a
// call answers after its turn went on joins a later request as store_owed.
// later: an ask nothing waited for (an agent's brief, a loop's run) that gave
// facts: they join a later request, and its store_owed row says what they added.
// failure: the store's.
export type MemoryOutcome = "added" | "empty" | "repeat" | "skipped" | "late" | "later" | "timeout" | "failure";
export type Fact = { names: string[]; text: string };

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
const wordsOf = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// One line of a memory block as a fact: "- name: text", "- RULE name: text",
// "- key (kind): text". A line without a name is its text alone.
export function factOf(line: string): Fact {
  const m = /^\s*-\s+(?:RULE\s+)?([^\s:][^:]*?)(?:\s+\([^)]*\))?:\s+(.*)$/.exec(line);
  return m ? { names: [m[1]!.trim()], text: m[2]! } : { names: [], text: line.replace(/^\s*-\s+/, "") };
}
export const factLines = (text: string) => text.split("\n").filter((l) => /^\s*-\s/.test(l));

// Words any two texts share: three of them in a row say nothing about a fact
// ("is in the", "at the end", "when it is"). A word of three letters or
// fewer, or one of these.
const COMMON = new Set(("that this with from have been were will would should could must when then than them they their there these those what which while where "
  + "into onto over under after before about above below also only just more most much many some such each every other same very even still never always "
  + "does done make made take took uses used using need needs want wants keep kept stay left right here your ours mine its").split(" "));
const plain = (w: string) => w.length <= 3 || COMMON.has(w);

// What a fact names that a tool call can touch: a path, a file with its
// extension, a flag, a quoted command or word. Lower case, as written.
export function handlesOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{3,80})`/g)) out.add(m[1]!.trim().toLowerCase());
  // A path: not two common words with a slash between them ("and/or", "his/her").
  for (const m of text.matchAll(/(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+\/?/g)) {
    const path = m[0].toLowerCase().replace(/[.,;:]+$/, ""); // a sentence's own stop is not the path's
    if (path.length >= 5 && !path.split("/").every((w) => !w || plain(w))) out.add(path);
  }
  for (const m of text.matchAll(/(?<![\w.-])[\w-]{2,}\.[a-z]{1,5}(?![\w-])/g)) if (m[0].length >= 5 && !/^\d+\.\d+$/.test(m[0])) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(/(?<![\w-])--[a-z][\w-]{2,}/g)) out.add(m[0].toLowerCase());
  return [...out].filter((h) => h.length >= 3);
}

// The proxy: does this output name the fact, or repeat three of its words in
// a row (at least two of them not common ones)? `acted`: the text of the
// turn's tool calls; a fact also counts when one of them holds a path, a
// file, a flag or a quoted command the fact names.
export function usedBy(f: Fact, output: string, acted = ""): boolean {
  const out = ` ${wordsOf(output).join(" ")} `;
  for (const n of f.names) {
    const name = wordsOf(n).join(" ");
    if (name.length >= 3 && out.includes(` ${name} `)) return true;
  }
  const w = wordsOf(f.text);
  for (let i = 0; i + 3 <= w.length; i++) {
    const three = w.slice(i, i + 3);
    if (three.filter((x) => !plain(x)).length >= 2 && out.includes(` ${three.join(" ")} `)) return true;
  }
  if (acted) {
    const low = acted.toLowerCase();
    for (const h of handlesOf(f.text)) if (low.includes(h)) return true;
  }
  return false;
}

// The words of a tool call's input, as they were given: every string in it, a
// line each (its JSON would glue an "n" onto the first word of a later line).
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); stringsOf(x, out); }
  return out;
}

// `given`: the memory_given row of each fact, in the facts' order (0: a line with no name, not listed).
// A deleted session's given rows deleted in one statement: a few milliseconds of the loop.
const DROP_PART = 500;
const ORPHANS_AFTER_MS = 30_000;
type Sum = Record<"asked" | "recalls" | "empty" | "repeat" | "skipped" | "late" | "later" | "timeouts" | "failures" | "facts" | "tokens" | "facts_checked" | "used" | "recalls_checked" | "recalls_used" | "repeats" | "cut" | "wait_ms" | "wait_max_ms" | "proc_ms", number>;
type Open = { row: number; facts: Fact[]; ts: number; given: number[] };
// Where a block came from, for the list of what a session was given: the
// store's hook, the tool it was asked about (a tool's name) and what it
// answers (the prompt's event, the tool call).
export type GivenBy = { hook: string; call?: string; ref?: string };
export type MemoryFilter = { since?: number; until?: number; session?: string };

// Whether a path's recall fell: the share of its answered asks that gave
// facts (added, all held already, or carried to a later step) in the last RECENT_MS, against the same
// share over the DAY_MS before that. It fell when the recent share is half
// of the day's or less. A path asked or answered rarely cannot be said to
// fall: both windows need FELL_MIN_ASKS answered asks, and the day FELL_MIN_HITS
// of them with facts (ten hits is the least where a halving is more than a
// couple of misses in a row). A change of the store or of the store's hook
// reads here the hour it lands, whatever its cause (the first one this was
// written for: the store stopped answering the prompts of agents).
export const FELL_RECENT_MS = 2 * 3_600_000;
export const FELL_DAY_MS = 24 * 3_600_000;
export const FELL_MIN_ASKS = 20;
export const FELL_MIN_HITS = 10;
export type Window = { answered: number; hits: number };
export type Fell = { path: MemoryPath; recent: Window; day: Window };
export function recallFell(path: MemoryPath, recent: Window, day: Window): Fell | null {
  if (recent.answered < FELL_MIN_ASKS || day.answered < FELL_MIN_ASKS || day.hits < FELL_MIN_HITS) return null;
  return recent.hits / recent.answered <= day.hits / day.answered / 2 ? { path, recent, day } : null;
}

export class MemoryMeter {
  // Recalls of each session's running turn, until it ends.
  private open = new Map<string, Open[]>();

  constructor(private store: Store) {
    store.migrate(`CREATE TABLE IF NOT EXISTS telemetry_memory (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, path TEXT NOT NULL, outcome TEXT NOT NULL,
  facts INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, used INTEGER, repeats INTEGER NOT NULL DEFAULT 0, cut INTEGER NOT NULL DEFAULT 0, wait_ms INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS telemetry_memory_ts ON telemetry_memory(ts);
CREATE INDEX IF NOT EXISTS telemetry_memory_session ON telemetry_memory(session_id);
CREATE TABLE IF NOT EXISTS memory_given (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, recall INTEGER NOT NULL, path TEXT NOT NULL, hook TEXT NOT NULL,
  name TEXT NOT NULL, call TEXT, ref TEXT, tokens INTEGER NOT NULL DEFAULT 0, used INTEGER);
CREATE INDEX IF NOT EXISTS memory_given_session ON memory_given(session_id, id);
CREATE INDEX IF NOT EXISTS memory_given_ts ON memory_given(ts);`);
    // proc_ms: the time of the hook process that answered the ask (nobody may have waited for it).
    if (!store.db.query<{ name: string }, []>("PRAGMA table_info(telemetry_memory)").all().some((c) => c.name === "proc_ms")) store.db.exec("ALTER TABLE telemetry_memory ADD COLUMN proc_ms INTEGER NOT NULL DEFAULT 0");
    this.prune();
    void this.gone;
    registerHooks({ turnEnd: (s) => this.settle(s.id) });
    // Rows a deletion left behind (the daemon ended before they were all gone): found off the loop, a while after start.
    const late = setTimeout(() => {
      readsOf(store).sql<{ session_id: string }>("SELECT DISTINCT g.session_id FROM memory_given g WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = g.session_id)")
        .then((rows) => { for (const r of rows) this.drop(r.session_id); }, () => {});
    }, ORPHANS_AFTER_MS);
    (late as { unref?: () => void }).unref?.();
  }

  // The store drops a deleted session out of every SessionMap, whatever
  // deleted it: this one takes the session's given rows with it.
  private gone = new (class extends SessionMap<true> {
    constructor(private left: (id: string) => void) { super(1); }
    override delete(id: string) { this.left(id); return super.delete(id); }
  })((id) => this.drop(id));
  private dropping: string[] = [];
  private dropTimer: ReturnType<typeof setTimeout> | null = null;
  // A deleted session's given rows go a part at a time, the loop free between
  // parts: one statement over tens of thousands of rows would hold every stream.
  private drop(sessionId: string) {
    this.open.delete(sessionId);
    if (!this.dropping.includes(sessionId)) this.dropping.push(sessionId);
    if (this.dropTimer) return;
    const part = () => {
      this.dropTimer = null;
      const id = this.dropping[0];
      if (id === undefined) return;
      try {
        const n = this.store.db.query("DELETE FROM memory_given WHERE id IN (SELECT id FROM memory_given WHERE session_id = ? LIMIT ?)").run(id, DROP_PART).changes;
        if (n < DROP_PART) this.dropping.shift();
      } catch {
        this.dropping.shift(); // a store that was closed: nothing left to do here
      }
      if (this.dropping.length) this.dropTimer = setTimeout(part, 0);
    };
    this.dropTimer = setTimeout(part, 0);
  }

  // Rows past their keep time go: at start, then once a day as rows are written.
  private pruned = 0;
  private prune(now = Date.now()) {
    if (now - this.pruned < 86_400_000) return;
    this.pruned = now;
    this.store.db.query("DELETE FROM telemetry_memory WHERE ts < ?").run(now - KEEP_MS);
    this.store.db.query("DELETE FROM memory_given WHERE ts < ?").run(now - KEEP_MS);
  }

  // One recall. `text`: what was added to the turn (nothing for the other
  // outcomes); `facts`: its lines, for the check at the turn's end; `repeats`
  // and `cut`: lines left out as already in the context, and as over the budget.
  // `row`: an earlier row of the same ask (a block that came late), written
  // over with how it ended. `by`: where the block came from; with it each
  // named fact gets its own row in memory_given, in the same commit.
  record(sessionId: string, path: MemoryPath, r: { outcome: MemoryOutcome; text?: string; facts?: Fact[]; repeats?: number; cut?: number; waitMs?: number; procMs?: number; by?: GivenBy }, row?: number): number {
    this.prune();
    const per = bytesPerToken(this.store.session(sessionId)?.model);
    const tokens = r.text ? Math.round(Buffer.byteLength(r.text) / per) : 0;
    const ts = Date.now();
    const values = [r.outcome, r.facts?.length ?? 0, tokens, r.repeats ?? 0, r.cut ?? 0] as const;
    const db = this.store.db;
    const given: number[] = [];
    const proc = Math.round(r.procMs ?? 0);
    db.transaction(() => {
      if (row !== undefined) db.query("UPDATE telemetry_memory SET outcome = ?, facts = ?, tokens = ?, repeats = ?, cut = ? WHERE id = ?").run(...values, row);
      else row = db
        .query("INSERT INTO telemetry_memory (session_id, ts, path, outcome, facts, tokens, repeats, cut, wait_ms, proc_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(sessionId, ts, path, ...values, Math.round(r.waitMs ?? 0), proc).lastInsertRowid as number;
      // No row for a session that is gone (the rows go with their session).
      if (!r.by || !this.store.session(sessionId)) return;
      const q = db.query("INSERT INTO memory_given (session_id, ts, recall, path, hook, name, call, ref, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const f of r.facts ?? []) {
        const name = f.names[0];
        // Only a name the store gives a fact: a line of another shape has its text where a name would be.
        // The tokens are of the line as the block held it: "- name: text".
        given.push(isFactName(name) ? Number(q.run(sessionId, ts, row!, path, r.by.hook, name, r.by.call ?? null, r.by.ref ?? null, Math.round((Buffer.byteLength(name) + Buffer.byteLength(f.text) + 4) / per)).lastInsertRowid) : 0);
      }
    })();
    if (r.facts?.length) {
      const list = this.open.get(sessionId) ?? [];
      list.push({ row: row!, facts: r.facts, ts, given });
      this.open.set(sessionId, list);
    }
    return row!;
  }

  // The hook process of an ask that nothing waited for ended: its time joins the row.
  addProc(row: number, ms: number | undefined) {
    if (ms) this.store.db.query("UPDATE telemetry_memory SET proc_ms = proc_ms + ? WHERE id = ?").run(Math.round(ms), row);
  }

  // The turn ended: each recall of it gets the count of its facts that the
  // turn's output named after the recall.
  private settle(sessionId: string) {
    const list = this.open.get(sessionId);
    if (!list?.length) return;
    this.open.delete(sessionId);
    const events = this.store.lineage(sessionId);
    const from = events.findLastIndex((e) => e.kind === "turn_start");
    const said = events.slice(Math.max(0, from)).filter((e) => e.kind === "assistant").map((e) => {
      const calls = (e.data.blocks ?? []).filter((b: any) => b.type === "tool_use").map((b: any) => stringsOf(b.input).join("\n")).join("\n");
      return { ts: e.ts, calls, text: `${(e.data.blocks ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("\n")}\n${calls}` };
    });
    const q = this.store.db.query("UPDATE telemetry_memory SET used = ? WHERE id = ?");
    const one = this.store.db.query("UPDATE memory_given SET used = ? WHERE id = ?");
    // One commit for the whole turn's recalls.
    this.store.db.transaction(() => {
      for (const o of list) {
        // A reply is stored when it ends: one stored at or after the recall could read it.
        const after = said.filter((a) => a.ts >= o.ts);
        const output = after.map((a) => a.text).join("\n"), acted = after.map((a) => a.calls).join("\n");
        const used = o.facts.map((f) => usedBy(f, output, acted));
        q.run(used.filter(Boolean).length, o.row);
        used.forEach((u, i) => { if (o.given[i]) one.run(u ? 1 : 0, o.given[i]!); });
      }
    })();
  }

  forget(sessionId: string) {
    this.open.delete(sessionId);
  }

  // The given rows whose turn has not ended yet: their check is still to come.
  // A row left unchecked that is not among them was cut with its turn.
  openGiven(sessionId: string): Set<number> {
    return new Set((this.open.get(sessionId) ?? []).flatMap((o) => o.given).filter(Boolean));
  }

  // Per path and in total: how often it was asked and how that ended, what it
  // added, what the turns used, what it left out, and the time turns waited.
  // `used` is over the recalls whose turn ended (`facts_checked` of `facts`).
  // `cut`: lines a block had no room for, carried to a later request.
  // Summed in the database: the table has a row per prompt and tool call.
  // `reportOn` sums on the read thread (the panel's route: the table grows
  // with every prompt and tool call of every session); `report` here.
  private reportSql(f: MemoryFilter) {
    const where = ["1 = 1"];
    const args: (string | number)[] = [];
    if (f.session) { where.push("session_id = ?"); args.push(f.session); }
    if (f.since !== undefined) { where.push("ts >= ?"); args.push(f.since); }
    if (f.until !== undefined) { where.push("ts < ?"); args.push(f.until); }
    const n = (o: MemoryOutcome) => `COALESCE(SUM(outcome = '${o}'), 0)`;
    const added = (col: string, more = "") => `COALESCE(SUM(CASE WHEN outcome = 'added'${more} THEN ${col} ELSE 0 END), 0)`;
    const checked = " AND used IS NOT NULL";
    const cols = `COUNT(*) AS asked, ${n("added")} AS recalls, ${n("empty")} AS empty, ${n("repeat")} AS repeat, ${n("skipped")} AS skipped, ${n("late")} AS late, ${n("later")} AS later, ${n("timeout")} AS timeouts, ${n("failure")} AS failures,
      ${added("facts")} AS facts, ${added("tokens")} AS tokens, ${added("facts", checked)} AS facts_checked, ${added("used", checked)} AS used,
      ${added("1", checked)} AS recalls_checked, ${added("1", " AND used > 0")} AS recalls_used,
      COALESCE(SUM(repeats), 0) AS repeats, COALESCE(SUM(cut), 0) AS cut, COALESCE(SUM(wait_ms), 0) AS wait_ms, COALESCE(MAX(wait_ms), 0) AS wait_max_ms, COALESCE(SUM(proc_ms), 0) AS proc_ms`;
    const from = `FROM telemetry_memory WHERE ${where.join(" AND ")}`;
    return { total: `SELECT ${cols} ${from}`, paths: `SELECT path, ${cols} ${from} GROUP BY path`, args };
  }
  private reportOf(f: MemoryFilter, total: Sum, paths: (Sum & { path: MemoryPath })[]) {
    return {
      since_ms: f.since ?? null, until_ms: f.until ?? Date.now(), estimate: true, total,
      paths: MEMORY_PATHS.flatMap((path) => paths.filter((p) => p.path === path)),
    };
  }
  // The recall of each path against its own day (recallFell), at `now`. Two windows, one scan of the day.
  private fellSql(now: number) {
    const hit = "outcome IN ('added', 'repeat', 'later')", answered = "outcome IN ('added', 'repeat', 'later', 'empty')";
    const recentFrom = now - FELL_RECENT_MS;
    const sql = `SELECT path, ts >= ? AS recent, COALESCE(SUM(${answered}), 0) AS answered, COALESCE(SUM(${hit}), 0) AS hits
      FROM telemetry_memory WHERE ts >= ? AND ts < ? AND path IN ('store_start', 'store_prompt', 'store_tool') GROUP BY path, recent`;
    return { sql, args: [recentFrom, recentFrom - FELL_DAY_MS, now] };
  }
  private fellOf(rows: { path: MemoryPath; recent: number; answered: number; hits: number }[]): Fell[] {
    const none = (): Window => ({ answered: 0, hits: 0 });
    return MEMORY_PATHS.flatMap((path) => {
      const at = (recent: number) => rows.find((r) => r.path === path && r.recent === recent) ?? none();
      const fell = recallFell(path, at(1), at(0));
      return fell ? [fell] : [];
    });
  }
  fell(now = Date.now()): Fell[] {
    const q = this.fellSql(now);
    return this.fellOf(this.store.db.query<any, any[]>(q.sql).all(...q.args));
  }
  async fellOn(reads: Reads, now = Date.now()): Promise<Fell[]> {
    const q = this.fellSql(now);
    return this.fellOf(await reads.sql<any>(q.sql, q.args));
  }
  report(f: MemoryFilter = {}) {
    const q = this.reportSql(f);
    return this.reportOf(f, this.store.db.query<Sum, any[]>(q.total).get(...q.args)!, this.store.db.query<Sum & { path: MemoryPath }, any[]>(q.paths).all(...q.args));
  }
  async reportOn(reads: Reads, f: MemoryFilter = {}) {
    const q = this.reportSql(f);
    const [total, paths] = await Promise.all([reads.sql<Sum>(q.total, q.args), reads.sql<Sum & { path: MemoryPath }>(q.paths, q.args)]);
    return this.reportOf(f, total[0]!, paths);
  }
}

// One meter per store: the external store's hooks and the helper write to the same one.
const meters = new WeakMap<Store, MemoryMeter>();
export function memoryMeter(store: Store): MemoryMeter {
  let m = meters.get(store);
  if (!m) meters.set(store, (m = new MemoryMeter(store)));
  return m;
}
