// What memory costs and whether it is used, measured for every recall and
// kept without content: one row per time a recall path was asked (the external
// store's session start, prompt and tool blocks, the helper's records), with
// what it added (facts, tokens), what it left out (already in the context, over
// the turn's budget), how long the turn waited for it, how it ended, and, once
// the turn is over, how many of the facts the turn's output named.
//
// "Used" is a proxy: a fact counts when the reply or a tool call of its turn
// holds one of its names as a word, or three of its words in a row. The names
// and words are held in memory until the turn ends and are never stored.
import { ownerPrompt } from "../core/owner.ts";
import type { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import { bytesPerToken } from "../engine/compact.ts";
import { registerHooks } from "../engine/hooks.ts";

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
// request, or one of the session's calls was still out); late: the turn did
// not wait for its answer (the store was not answering in time; what it
// answers joins a later request as store_owed); timeout and failure: the store's.
export type MemoryOutcome = "added" | "empty" | "repeat" | "skipped" | "late" | "timeout" | "failure";
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

// The proxy: does this output name the fact, or repeat three of its words in a row?
export function usedBy(f: Fact, output: string): boolean {
  const out = ` ${wordsOf(output).join(" ")} `;
  for (const n of f.names) {
    const name = wordsOf(n).join(" ");
    if (name.length >= 3 && out.includes(` ${name} `)) return true;
  }
  const w = wordsOf(f.text);
  if (w.length < 3) return false;
  for (let i = 0; i + 3 <= w.length; i++) if (out.includes(` ${w.slice(i, i + 3).join(" ")} `)) return true;
  return false;
}

type Open = { row: number; facts: Fact[]; ts: number };
export type MemoryFilter = { since?: number; until?: number; session?: string };

export class MemoryMeter {
  // Recalls of each session's running turn, until it ends.
  private open = new Map<string, Open[]>();

  constructor(private store: Store) {
    store.migrate(`CREATE TABLE IF NOT EXISTS telemetry_memory (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, path TEXT NOT NULL, outcome TEXT NOT NULL,
  facts INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, used INTEGER, repeats INTEGER NOT NULL DEFAULT 0, cut INTEGER NOT NULL DEFAULT 0, wait_ms INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS telemetry_memory_ts ON telemetry_memory(ts);
CREATE INDEX IF NOT EXISTS telemetry_memory_session ON telemetry_memory(session_id);`);
    this.prune();
    registerHooks({ turnEnd: (s) => this.settle(s.id) });
  }

  // Rows past their keep time go: at start, then once a day as rows are written.
  private pruned = 0;
  private prune(now = Date.now()) {
    if (now - this.pruned < 86_400_000) return;
    this.pruned = now;
    this.store.db.query("DELETE FROM telemetry_memory WHERE ts < ?").run(now - KEEP_MS);
  }

  // One recall. `text`: what was added to the turn (nothing for the other
  // outcomes); `facts`: its lines, for the check at the turn's end; `repeats`
  // and `cut`: lines left out as already in the context, and as over the budget.
  // `row`: an earlier row of the same ask (a block that came late), written
  // over with how it ended.
  record(sessionId: string, path: MemoryPath, r: { outcome: MemoryOutcome; text?: string; facts?: Fact[]; repeats?: number; cut?: number; waitMs?: number }, row?: number): number {
    this.prune();
    const model = this.store.session(sessionId)?.model;
    const tokens = r.text ? Math.round(Buffer.byteLength(r.text) / bytesPerToken(model)) : 0;
    const ts = Date.now();
    const values = [r.outcome, r.facts?.length ?? 0, tokens, r.repeats ?? 0, r.cut ?? 0] as const;
    if (row !== undefined) this.store.db.query("UPDATE telemetry_memory SET outcome = ?, facts = ?, tokens = ?, repeats = ?, cut = ? WHERE id = ?").run(...values, row);
    else row = this.store.db
      .query("INSERT INTO telemetry_memory (session_id, ts, path, outcome, facts, tokens, repeats, cut, wait_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, ts, path, ...values, Math.round(r.waitMs ?? 0)).lastInsertRowid as number;
    if (r.facts?.length) {
      const list = this.open.get(sessionId) ?? [];
      list.push({ row, facts: r.facts, ts });
      this.open.set(sessionId, list);
    }
    return row;
  }

  // The turn ended: each recall of it gets the count of its facts that the
  // turn's output named after the recall.
  private settle(sessionId: string) {
    const list = this.open.get(sessionId);
    if (!list?.length) return;
    this.open.delete(sessionId);
    const events = lineage(this.store.events(sessionId), this.store.session(sessionId)?.head ?? null);
    const from = events.findLastIndex((e) => e.kind === "turn_start");
    const said = events.slice(Math.max(0, from)).filter((e) => e.kind === "assistant").map((e) => ({
      ts: e.ts,
      text: (e.data.blocks ?? []).map((b: any) => (b.type === "text" ? b.text : b.type === "tool_use" ? JSON.stringify(b.input ?? "") : "")).join("\n"),
    }));
    const q = this.store.db.query("UPDATE telemetry_memory SET used = ? WHERE id = ?");
    for (const o of list) {
      // A reply is stored when it ends: one stored at or after the recall could read it.
      const output = said.filter((a) => a.ts >= o.ts).map((a) => a.text).join("\n");
      q.run(o.facts.filter((f) => usedBy(f, output)).length, o.row);
    }
  }

  forget(sessionId: string) {
    this.open.delete(sessionId);
  }

  // Per path and in total: how often it was asked and how that ended, what it
  // added, what the turns used, what it left out, and the time turns waited.
  // `used` is over the recalls whose turn ended (`facts_checked` of `facts`).
  // `cut`: lines a block had no room for, carried to a later request.
  // Summed in the database: the table has a row per prompt and tool call.
  report(f: MemoryFilter = {}) {
    const where = ["1 = 1"];
    const args: (string | number)[] = [];
    if (f.session) { where.push("session_id = ?"); args.push(f.session); }
    if (f.since !== undefined) { where.push("ts >= ?"); args.push(f.since); }
    if (f.until !== undefined) { where.push("ts < ?"); args.push(f.until); }
    const n = (o: MemoryOutcome) => `COALESCE(SUM(outcome = '${o}'), 0)`;
    const added = (col: string, more = "") => `COALESCE(SUM(CASE WHEN outcome = 'added'${more} THEN ${col} ELSE 0 END), 0)`;
    const checked = " AND used IS NOT NULL";
    const cols = `COUNT(*) AS asked, ${n("added")} AS recalls, ${n("empty")} AS empty, ${n("repeat")} AS repeat, ${n("skipped")} AS skipped, ${n("late")} AS late, ${n("timeout")} AS timeouts, ${n("failure")} AS failures,
      ${added("facts")} AS facts, ${added("tokens")} AS tokens, ${added("facts", checked)} AS facts_checked, ${added("used", checked)} AS used,
      ${added("1", checked)} AS recalls_checked, ${added("1", " AND used > 0")} AS recalls_used,
      COALESCE(SUM(repeats), 0) AS repeats, COALESCE(SUM(cut), 0) AS cut, COALESCE(SUM(wait_ms), 0) AS wait_ms, COALESCE(MAX(wait_ms), 0) AS wait_max_ms`;
    const from = `FROM telemetry_memory WHERE ${where.join(" AND ")}`;
    type Sum = Record<"asked" | "recalls" | "empty" | "repeat" | "skipped" | "late" | "timeouts" | "failures" | "facts" | "tokens" | "facts_checked" | "used" | "recalls_checked" | "recalls_used" | "repeats" | "cut" | "wait_ms" | "wait_max_ms", number>;
    const total = this.store.db.query<Sum, any[]>(`SELECT ${cols} ${from}`).get(...args)!;
    const paths = this.store.db.query<Sum & { path: MemoryPath }, any[]>(`SELECT path, ${cols} ${from} GROUP BY path`).all(...args);
    return {
      since_ms: f.since ?? null, until_ms: f.until ?? Date.now(), estimate: true, total,
      paths: MEMORY_PATHS.flatMap((path) => paths.filter((p) => p.path === path)),
    };
  }
}

// One meter per store: the external store's hooks and the helper write to the same one.
const meters = new WeakMap<Store, MemoryMeter>();
export function memoryMeter(store: Store): MemoryMeter {
  let m = meters.get(store);
  if (!m) meters.set(store, (m = new MemoryMeter(store)));
  return m;
}
