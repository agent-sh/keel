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

// Inputs the harness delivers about something that happened: a report, a
// wake, a loop run, a goal going on, a failure notice, a digest, its own
// instructions. They ask for no new work in the owner's words, and memory
// is not searched for what it knows about them (a record they name is still
// recalled where names can be looked up). Everything else is a request.
const DELIVERED = new Set(["subagent", "wait", "wake", "loop", "goal", "failures", "helper_digest", "harness", "verify_goal"]);
export const asksMemory = (d: { kind?: unknown; origin?: unknown } | undefined): boolean =>
  ownerPrompt(d) || (!!d && !DELIVERED.has(String(d.kind ?? "")) && d.origin !== "harness" && d.origin !== "restart");

export type MemoryPath = "store_start" | "store_prompt" | "store_tool" | "helper";
export const MEMORY_PATHS: MemoryPath[] = ["store_start", "store_prompt", "store_tool", "helper"];
// added: the turn got a block; empty: the store had nothing; repeat: all of it
// was in the context already; skipped: not asked (an input that is not a
// request, or a store that is not answering); late: the turn did not wait for
// its answer (the row is written over when the answer joins a later prompt,
// or when it turns out there is none); timeout and failure: the store's.
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
type Row = { path: MemoryPath; outcome: MemoryOutcome; facts: number; tokens: number; used: number | null; repeats: number; cut: number; wait_ms: number };

export class MemoryMeter {
  // Recalls of each session's running turn, until it ends.
  private open = new Map<string, Open[]>();

  constructor(private store: Store) {
    store.migrate(`CREATE TABLE IF NOT EXISTS telemetry_memory (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, path TEXT NOT NULL, outcome TEXT NOT NULL,
  facts INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, used INTEGER, repeats INTEGER NOT NULL DEFAULT 0, cut INTEGER NOT NULL DEFAULT 0, wait_ms INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS telemetry_memory_ts ON telemetry_memory(ts);`);
    registerHooks({ turnEnd: (s) => this.settle(s.id) });
  }

  // One recall. `text`: what was added to the turn (nothing for the other
  // outcomes); `facts`: its lines, for the check at the turn's end; `repeats`
  // and `cut`: lines left out as already in the context, and as over the budget.
  // `row`: an earlier row of the same ask (a block that came late), written
  // over with how it ended.
  record(sessionId: string, path: MemoryPath, r: { outcome: MemoryOutcome; text?: string; facts?: Fact[]; repeats?: number; cut?: number; waitMs?: number }, row?: number): number {
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
  report(f: MemoryFilter = {}) {
    const where = ["1 = 1"];
    const args: (string | number)[] = [];
    if (f.session) { where.push("session_id = ?"); args.push(f.session); }
    if (f.since !== undefined) { where.push("ts >= ?"); args.push(f.since); }
    if (f.until !== undefined) { where.push("ts < ?"); args.push(f.until); }
    const rows = this.store.db.query<Row, any[]>(`SELECT path, outcome, facts, tokens, used, repeats, cut, wait_ms FROM telemetry_memory WHERE ${where.join(" AND ")}`).all(...args);
    const sum = (list: Row[]) => {
      const added = list.filter((r) => r.outcome === "added");
      const checked = added.filter((r) => r.used !== null);
      const n = (o: MemoryOutcome) => list.filter((r) => r.outcome === o).length;
      const waits = list.map((r) => r.wait_ms).sort((a, b) => a - b);
      return {
        asked: list.length, recalls: added.length, empty: n("empty"), skipped: n("skipped"), late: n("late"), timeouts: n("timeout"), failures: n("failure"),
        facts: added.reduce((a, r) => a + r.facts, 0), tokens: added.reduce((a, r) => a + r.tokens, 0),
        facts_checked: checked.reduce((a, r) => a + r.facts, 0), used: checked.reduce((a, r) => a + (r.used ?? 0), 0),
        recalls_checked: checked.length, recalls_used: checked.filter((r) => (r.used ?? 0) > 0).length,
        repeats: list.reduce((a, r) => a + r.repeats, 0), cut: list.reduce((a, r) => a + r.cut, 0),
        wait_ms: list.reduce((a, r) => a + r.wait_ms, 0), wait_max_ms: waits.at(-1) ?? 0,
      };
    };
    return {
      since_ms: f.since ?? null, until_ms: f.until ?? Date.now(), estimate: true,
      total: sum(rows),
      paths: MEMORY_PATHS.map((path) => ({ path, ...sum(rows.filter((r) => r.path === path)) })).filter((p) => p.asked),
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
