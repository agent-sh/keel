// A live session keeps the tools and system prompt it was last sent across a
// daemon upgrade.
//
// A provider's prompt cache is keyed by the request's prefix: the tools, then
// the system prompt, then the messages. When a new build rewords one tool or
// one block of the prompt, every session's next request has another prefix
// and its whole context is written to the cache again, at the write price,
// for a change the session did not need at that moment. So each session is
// pinned: its tool definitions are stored here as they were sent (names,
// descriptions, schemas, order, deferral), its prompt in the prompt store,
// and a restart reads both back byte for byte.
//
// The session takes the running build's tools and prompt, both together, at
// a moment its cache does not hold the context anyway (coldReason): after a
// compaction or a clear, on another model, once the cache lifetime has surely
// passed since its last reply, or when no reply ever used the cache. And at
// once, at the price of one write, when waiting would be wrong:
// - a pinned tool in the prompt that the build removed or can no longer serve
//   (src/tools/pin.ts): a call to it would fail;
// - a tool or prompt block the build marks urgent (src/core/build.ts);
// - the owner asked (the context popup, or the command).
// The owner's or the machine's own side of the prompt changing (an
// instruction file was edited, an MCP server was added or turned off, a skill
// was installed) does not wait to be in force: the engine tells the change at
// the tail of the history at the next request (src/engine/prompt-note.ts),
// and the prompt takes it at the next cold moment like any other block. A
// block says which part of it is that data (hooks.ts SystemBlock), so a build
// that only rewords the block is not told, it waits.
// Deferred tools and every MCP or catalog tool are not part of the cached
// prefix; they follow the build and the servers per request, as before.
//
// A deferred tool the conversation already loaded is in the prefix from its
// reference on (the provider puts its definition there), so its definition is
// kept too, per session (session_loaded), while the tool still takes it.
//
// A pin does not grow old without bound: a session that stays warm and never
// compacts (a loop every few minutes, the helper's conversation) takes the
// running build's once it has been behind for build_pin.max_age_hours (24 by
// default, 0 for never), so a change nobody marked urgent still reaches every
// session, at one cache write per session per period.
//
// Each adoption is recorded with its reason, and the pin row says what waits,
// so the owner sees which build a session's prefix is from. A session row is
// small; the tool list it points at (24 to 36 kB as measured, 62 tools on the
// Anthropic wire) is shared by the sessions of one build, family and wire.
import { registerSettings, settings } from "../admin/settings.ts";
import { buildId, toolMarks } from "../core/build.ts";
import { SessionMap } from "../core/session-map.ts";
import type { Store } from "../core/store.ts";
import type { Session, StoredEvent } from "../core/types.ts";
import { changedTools, mergeTools, pinOf, servable, type PinnedTool } from "../tools/pin.ts";
import type { Tool } from "../tools/types.ts";
import { checkpointAt, lastWarm } from "./compact.ts";
import { ownChanges, urgentBlock, type PromptBlock } from "./prompt-store.ts";

// The reason of an adoption at a cache that had surely expired: its break is an expiry (src/admin/telemetry.ts).
export const EXPIRED = "the cache expired";

// The longest a session stays behind the running build, in hours; 0: no limit.
registerSettings("build_pin", { max_age_hours: 24 }, (v) =>
  typeof v.max_age_hours === "number" && Number.isFinite(v.max_age_hours) && v.max_age_hours >= 0 ? undefined : "max_age_hours is a number of hours, or 0 for no limit");
const maxAgeMs = () => Number(settings().build_pin?.max_age_hours ?? 0) * 3_600_000;
// A copy kept since `since` (a pin, a subagent's copy of its parent's prompt) is past the age the owner allows.
export const pinAged = (since: number, now = Date.now()) => maxAgeMs() > 0 && now - since > maxAgeMs();
const agedWhy = () => `its tools and prompt were more than ${settings().build_pin.max_age_hours} hours behind`;

// Why no warm cache holds this context on `model`, or undefined when one may:
// a reply of the model after the last checkpoint used the cache (or a summary
// prepared on the same prefix did, `preparedMs`) within `keepMs`, the longest
// its route may keep a prefix (retention().max in cachewarn.ts).
export function coldReason(lineage: readonly StoredEvent[], model: string, keepMs: number, now: number, preparedMs = 0): string | undefined {
  const warm = lastWarm(lineage, model, preparedMs);
  if (warm) return now - warm > keepMs ? EXPIRED : undefined;
  const cp = checkpointAt(lineage).at;
  let reply: StoredEvent | undefined;
  for (let i = lineage.length - 1; i > cp && !reply; i--) if (lineage[i]!.kind === "assistant") reply = lineage[i];
  if (!reply) return cp < 0 ? "a new context" : lineage[cp]!.data.mode === "clear" ? "a clear" : "a compaction";
  return reply.data.model !== model ? "a model switch" : "no cached prefix";
}

// `told`: of the blocks, those of the owner's side, told at the tail of the history until they are folded in.
export type Waiting = { blocks: string[]; tools: string[]; told?: string[] };
export type Adoption = { ts: number; reason: string; from_build: string | null; to_build: string; blocks: string[]; tools: string[] };
export type PinState = {
  // The build that runs now.
  build: string;
  // The build the session's tools and prompt are from (null: one from before
  // pins were kept) and since when; null when it has sent no request yet.
  pinned: { build: string | null; since: number } | null;
  // What this build changed that the session does not carry yet. `known`:
  // compared by this build (a session is compared at its first request after
  // a daemon start).
  waiting: Waiting;
  known: boolean;
  // Since when the session is behind, and when it takes the build's by age (absent: no limit, or not behind).
  behind_since: number | null;
  takes_at: number | null;
  asked: boolean;
  adoptions: Adoption[];
};

// `own`: the session's own part of its tool list when it was pinned (registry.ts sessionToolsKey).
// `stale`: since when something of the running build waits. `took`: a prompt
// taken whose tools have not followed yet (the reason and the blocks), kept
// in the row so a daemon restart in between does not lose it.
// `gone`: tools an adoption on the same model took away, so a call to one says why.
type Row = {
  build: string | null; ts: number; model: string; native: boolean; own: string; list: string; waiting: Waiting;
  checked: string | null; asked: boolean; stale: number | null; took: { why: string; blocks: string[] } | null; gone: string[];
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS session_pins (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  build TEXT, ts INTEGER NOT NULL, model TEXT NOT NULL, native INTEGER NOT NULL, own TEXT NOT NULL, list TEXT NOT NULL,
  waiting TEXT NOT NULL, checked TEXT, asked INTEGER NOT NULL DEFAULT 0, stale INTEGER, took TEXT, gone TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS pinned_tools (hash TEXT PRIMARY KEY, tools TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_loaded (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, name TEXT NOT NULL, def TEXT NOT NULL, PRIMARY KEY (session_id, name));
CREATE TABLE IF NOT EXISTS build_adoptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, reason TEXT NOT NULL, from_build TEXT, to_build TEXT NOT NULL, blocks TEXT NOT NULL, tools TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS build_adoptions_session ON build_adoptions(session_id, ts)`;

// What decides a session's tool list besides the build: the model, whether
// its wire defers tools (src/tools/defer.ts), and the session's own part of
// the list (registry.ts sessionToolsKey; "no tools" for a model sent none).
export type Variant = { model: string; native: boolean; own: string };

// Why a pinned list is not the one a request to `to` carries, whatever the
// build: there is no cached prefix of it to keep.
const otherList = (row: Row, to: Variant): string | undefined =>
  row.model !== to.model ? "a model switch" : row.native !== to.native ? "the route takes its tools another way" : row.own !== to.own ? "the session's tool set changed" : undefined;

export class BuildPins {
  // The reason the step in hand takes this build's, set before its prompt is read.
  private why = new Map<string, string>();
  // The blocks of each session's prompt that wait, as this run compared them
  // (a session that dropped out reads them back from its row).
  private blocks = new SessionMap<string[]>(256);
  // Of those, the owner's side: told at the tail until they are folded in.
  private told = new SessionMap<string[]>(256);
  // Tool lists by fingerprint: sessions of one build, family and wire share one.
  private lists = new Map<string, PinnedTool[]>();

  constructor(private store: Store) {
    store.migrate(SCHEMA);
    // A table made before these columns existed.
    for (const [col, type] of [["stale", "INTEGER"], ["took", "TEXT"], ["gone", "TEXT NOT NULL DEFAULT '[]'"]] as const)
      if (!store.columnExists("session_pins", col)) store.db.exec(`ALTER TABLE session_pins ADD COLUMN ${col} ${type}`);
    store.db.run("DELETE FROM pinned_tools WHERE hash NOT IN (SELECT list FROM session_pins)");
  }

  // A row whose list is missing is no pin: the session is pinned again from the running build.
  private row(id: string): Row | undefined {
    const r = this.store.db
      .query<{ build: string | null; ts: number; model: string; native: number; own: string; list: string; waiting: string; checked: string | null; asked: number; stale: number | null; took: string | null; gone: string }, [string]>(
        "SELECT build, ts, model, native, own, list, waiting, checked, asked, stale, took, gone FROM session_pins WHERE session_id = ?")
      .get(id);
    if (!r || !this.list(r.list)) return undefined;
    return { ...r, native: !!r.native, waiting: JSON.parse(r.waiting), asked: !!r.asked, took: r.took ? JSON.parse(r.took) : null, gone: JSON.parse(r.gone) };
  }

  private list(hash: string): PinnedTool[] | undefined {
    let l = this.lists.get(hash);
    if (!l) {
      const r = this.store.db.query<{ tools: string }, [string]>("SELECT tools FROM pinned_tools WHERE hash = ?").get(hash);
      if (!r) return undefined;
      l = JSON.parse(r.tools) as PinnedTool[];
      if (this.lists.size >= 32) this.lists.delete(this.lists.keys().next().value!);
      this.lists.set(hash, l);
      this.hashes.set(l, hash);
    }
    return l;
  }

  // The hash of a list already stored, by the list: a step that keeps its pin does not write the
  // list's text again to learn it (tens of KB a step, the step of every working session).
  private hashes = new WeakMap<PinnedTool[], string>();
  // Written only when something changed: a step that finds its pin as it was writes nothing.
  private save(id: string, was: Row | undefined, now: Omit<Row, "list"> & { tools: PinnedTool[] }) {
    const known = this.hashes.get(now.tools);
    const text = known === undefined ? JSON.stringify(now.tools) : undefined;
    const { tools: _, ...rest } = now;
    const next: Row = { ...rest, list: known ?? Bun.hash(text!).toString(36) };
    const flat = (r: Row) => JSON.stringify([r.build, r.ts, r.model, r.native, r.own, r.list, r.waiting, r.checked, r.asked, r.stale, r.took, r.gone]);
    if (was && flat(was) === flat(next)) return;
    this.store.db.transaction(() => {
      if (text !== undefined) this.store.db.query("INSERT OR IGNORE INTO pinned_tools (hash, tools) VALUES (?, ?)").run(next.list, text);
      this.store.db
        .query(`INSERT INTO session_pins (session_id, build, ts, model, native, own, list, waiting, checked, asked, stale, took, gone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET build = excluded.build, ts = excluded.ts, model = excluded.model, native = excluded.native,
                  own = excluded.own, list = excluded.list, waiting = excluded.waiting, checked = excluded.checked, asked = excluded.asked,
                  stale = excluded.stale, took = excluded.took, gone = excluded.gone`)
        .run(id, next.build, next.ts, next.model, next.native ? 1 : 0, next.own, next.list, JSON.stringify(next.waiting), next.checked, next.asked ? 1 : 0,
          next.stale, next.took ? JSON.stringify(next.took) : null, JSON.stringify(next.gone));
    })();
    this.lists.set(next.list, now.tools);
    this.hashes.set(now.tools, next.list);
  }

  // The session has been behind the running build for longer than the owner allows.
  private aged(row: Row, now = Date.now()): boolean {
    const max = maxAgeMs();
    return max > 0 && row.stale !== null && now - row.stale > max;
  }

  // Why a request of the session on `model` takes this build's tools and
  // prompt now, when it does. `to`: what the request would carry on this
  // build. `cold`: asked only when something waits, or the session was not
  // compared in this run yet.
  due(session: Session, to: Variant, current: Tool[], cold: () => string | undefined): string | undefined {
    const row = this.row(session.id);
    if (!row) return undefined;
    if (row.took) return row.took.why;
    if (row.asked) return "the owner asked";
    const other = otherList(row, to);
    if (other) return other;
    const m = mergeTools(this.list(row.list)!, current, toolMarks(current));
    if (m.urgent) return m.urgent;
    if (this.aged(row)) return agedWhy();
    const blocks = this.blocks.get(session.id);
    return m.waiting.length || !blocks || blocks.length ? cold() : undefined;
  }

  begin(id: string, why: string | undefined) {
    if (why) this.why.set(id, why);
  }

  end(id: string) {
    this.why.delete(id);
  }

  // A turn that is running asks before each request: this build's are due
  // now (the owner asked, a prompt was taken, the age passed), or something
  // waits (then the caller checks whether the cache is cold).
  waits(id: string): "now" | "behind" | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    if (row.asked || row.took || this.aged(row)) return "now";
    return row.waiting.blocks.length || row.waiting.tools.length ? "behind" : undefined;
  }

  // The session's prompt was rendered again (`made`) and compared with the
  // kept one (`changed`: the blocks that differ). True when the new render is
  // taken: there is no kept one, the step in hand has a reason, a changed
  // block is urgent, the change is the owner's or the machine's own (the
  // data a block renders, not the build's words), or the session moved.
  // Otherwise the kept prompt stays and the changed blocks wait. A change of
  // the owner's side waits too while the cache may be warm: the engine tells
  // it at the tail of the history meanwhile (src/engine/prompt-note.ts), so it
  // is in force at once without rewriting the prefix. A session with no pin
  // to fold it in later takes it now.
  // `cold`: why no warm cache holds the kept prompt, when the caller knows.
  prompt(id: string, kept: PromptBlock[] | undefined, made: PromptBlock[], changed: string[], moved: boolean, cold?: string): boolean {
    if (!kept || !changed.length) {
      this.blocks.set(id, []);
      this.told.delete(id);
      return !kept;
    }
    const urgent = urgentBlock(kept, changed);
    const own = ownChanges(kept, made, changed);
    const row = this.row(id);
    const why = this.why.get(id) ?? row?.took?.why
      ?? (urgent ? `the ${urgent} block has an urgent change` : moved ? "the session moved" : own.length && cold ? cold : own.length && !row ? `the owner's side changed (${own.join(", ")})` : undefined);
    if (!why) {
      this.blocks.set(id, changed);
      this.told.set(id, own);
      return false;
    }
    this.blocks.set(id, []);
    this.told.delete(id);
    // Kept in the row until the tools follow (a session with no pin yet takes the build's list anyway).
    this.store.db.query("UPDATE session_pins SET took = ? WHERE session_id = ?").run(JSON.stringify({ why, blocks: changed }), id);
    return true;
  }

  // The tools a request of the session carries: its pinned definitions on the
  // current build's implementations, or the build's own list when the session
  // takes it now (a reason from due or prompt, or one found here).
  tools(session: Session, to: Variant, current: Tool[]): Tool[] {
    const { model, native, own } = to;
    const id = session.id, build = buildId();
    const row = this.row(id);
    const took = row?.took;
    // A subagent on this machine has no prompt of its own to compare: it runs on its parent's.
    if (session.parent_id && !session.machine) this.blocks.set(id, []);
    const blocks = this.blocks.get(id) ?? (row?.checked === build ? row.waiting.blocks : []);
    const told = (this.told.get(id) ?? (row?.checked === build ? row.waiting.told : undefined) ?? []).filter((n) => blocks.includes(n));
    let reason = took?.why ?? this.why.get(id);
    // A subagent on this machine starts on its parent's list (and prompt), so
    // its first request reads the prefix the parent cached.
    const parent = !row && session.parent_id && !session.machine ? this.row(session.parent_id) : undefined;
    const base = row ?? (parent && !otherList(parent, to) ? parent : undefined);
    const from = base ? this.list(base.list) : undefined;
    if (row) reason ??= otherList(row, to) ?? (this.aged(row) ? agedWhy() : undefined);
    if (from && !reason) {
      const m = mergeTools(from, current, toolMarks(current));
      if (!m.urgent) {
        const waiting: Waiting = { blocks, tools: m.waiting, ...(told.length && { told }) };
        const behind = m.waiting.length + blocks.length > 0;
        // Nothing of this build is missing: the session is on it.
        const on = behind ? base!.build : build;
        this.save(id, row, {
          build: on, ts: row && on === row.build ? row.ts : Date.now(), model, native, own, tools: m.pin ?? from, waiting, checked: build,
          asked: !!row?.asked, stale: behind ? row?.stale ?? Date.now() : null, took: null, gone: row?.gone ?? [],
        });
        return m.tools;
      }
      reason = m.urgent;
    }
    const marks = toolMarks(current);
    const pin = current.map((t) => pinOf(t, marks[t.name]));
    const tools = from ? changedTools(from, pin) : [];
    if (row && (took?.blocks.length || tools.length)) {
      this.store.db
        .query("INSERT INTO build_adoptions (session_id, ts, reason, from_build, to_build, blocks, tools) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, Date.now(), reason ?? "a new context", row.build, build, JSON.stringify(took?.blocks ?? []), JSON.stringify(tools));
    }
    // The definitions the conversation loaded are this build's from here: each takes the
    // catalog's at its next request. Kept meanwhile, so a tool whose server is still
    // connecting (a daemon start) is declared as loaded, not as a stand-in (loaded, below).
    this.store.db.query("UPDATE session_loaded SET def = json_set(def, '$.retake', json('true')) WHERE session_id = ?").run(id);
    // Tools the build took away on the same model: a call to one says so (removed).
    const names = new Set(pin.map((t) => t.name));
    const gone = row && !otherList(row, to) ? [...new Set([...row.gone, ...from!.filter((t) => !names.has(t.name)).map((t) => t.name)])].filter((n) => !names.has(n)).slice(-64) : [];
    // A prompt that still waits (it could not be rendered again) keeps the label of the build it is from.
    const on = blocks.length ? row?.build ?? null : build;
    const same = !!row && on === row.build && !tools.length && !took?.blocks.length;
    this.save(id, row, {
      build: on, ts: same ? row.ts : Date.now(), model, native, own, tools: pin, waiting: { blocks, tools: [], ...(told.length && { told }) }, checked: build,
      asked: false, stale: blocks.length ? row?.stale ?? Date.now() : null, took: null, gone,
    });
    return current;
  }

  // The deferred tools of a request that the conversation already loaded
  // (`names`: the tools its history references): each keeps the definition it
  // was loaded with while the tool still takes it, since the provider puts the
  // definition at the reference and a changed one rewrites the cache from
  // there. One that takes another input now gets the new definition; one the
  // history no longer references (a compaction took it) is forgotten.
  // A loaded tool whose server is not connected (still connecting after a
  // start, or gone) is a stand-in in the catalog: it is declared with the
  // definition it was loaded with, so the request is the same bytes while the
  // server comes back, and a call of it still gets the stand-in's reason.
  loaded(id: string, tools: Tool[], names: Set<string>): Tool[] {
    const rows = this.store.db.query<{ name: string; def: string }, [string]>("SELECT name, def FROM session_loaded WHERE session_id = ?").all(id);
    if (!names.size && !rows.length) return tools;
    // `retake`: the session took a build since the tool was loaded, so the catalog's definition of now is taken.
    const kept = new Map(rows.map((r) => [r.name, JSON.parse(r.def) as PinnedTool & { retake?: boolean }]));
    for (const n of kept.keys()) if (!names.has(n)) this.store.db.query("DELETE FROM session_loaded WHERE session_id = ? AND name = ?").run(id, n);
    return tools.map((t) => {
      // A built-in the list defers is pinned with the list.
      if (!t.defer || !names.has(t.name) || !(t as { catalog?: string }).catalog) return t;
      const was = kept.get(t.name);
      // (Every field the request sends, the namespace too: the Responses wire nests an MCP tool in its server's.)
      // Sent as loaded while its server reconnects, it is the definition the cache holds from here.
      if ((t as { left?: boolean }).left) {
        if (was?.retake) this.store.db.query("INSERT OR REPLACE INTO session_loaded (session_id, name, def) VALUES (?, ?, ?)").run(id, t.name, JSON.stringify(pinOf(was)));
        return was ? { ...t, ...pinOf(was) } : t;
      }
      if (was && !was.retake && servable(was, t)) return { ...t, description: was.description, input_schema: was.input_schema, built: t.input_schema };
      this.store.db.query("INSERT INTO session_loaded (session_id, name, def) VALUES (?, ?, ?) ON CONFLICT(session_id, name) DO UPDATE SET def = excluded.def").run(id, t.name, JSON.stringify(pinOf(t)));
      return t;
    });
  }

  // The built-ins the session's list defers, by name: its tool search finds
  // those (a tool this build moved into the prompt still loads through the
  // search while the session's list defers it).
  deferred(id: string): string[] | undefined {
    const row = this.row(id);
    return row?.native ? this.list(row.list)!.filter((t) => t.defer).map((t) => t.name) : undefined;
  }

  // Whether a tool the session no longer has was taken away by a build it adopted.
  removed(id: string, name: string): boolean {
    return !!this.row(id)?.gone.includes(name);
  }

  // Whether a change of the owner's side waits in the session's prompt, told at the tail meanwhile.
  telling(id: string): boolean {
    return !!(this.told.get(id) ?? this.row(id)?.waiting.told)?.length;
  }

  // The owner asked for this build's tools and prompt: the session's next request takes them.
  ask(id: string): boolean {
    return this.store.db.query("UPDATE session_pins SET asked = 1 WHERE session_id = ?").run(id).changes > 0;
  }

  // The same for every open session that is behind or not compared yet; how many were asked.
  askAll(): number {
    const { behind, unknown } = this.open();
    for (const id of [...behind, ...unknown]) this.ask(id);
    return behind.length + unknown.length;
  }

  // The open sessions that may carry an earlier build's tools or prompt:
  // `behind` those known to (compared by this build), `unknown` those not
  // compared since this build started, and `asked` how many of either the
  // owner already asked (they take the build's at their next request).
  open(): { behind: string[]; unknown: string[]; asked: number } {
    const build = buildId();
    const rows = this.store.db
      .query<{ id: string; waiting: string; checked: string | null; asked: number }, []>("SELECT p.session_id AS id, p.waiting, p.checked, p.asked FROM session_pins p JOIN sessions s ON s.id = p.session_id WHERE s.archived = 0")
      .all();
    const behind: string[] = [], unknown: string[] = [];
    let asked = 0;
    for (const r of rows) {
      const w = JSON.parse(r.waiting) as Waiting;
      const list = r.checked !== build ? unknown : w.blocks.length || w.tools.length ? behind : undefined;
      if (list && r.asked) asked++;
      else list?.push(r.id);
    }
    return { behind, unknown, asked };
  }

  adoptions(id: string, limit = 5): Adoption[] {
    return this.store.db
      .query<{ ts: number; reason: string; from_build: string | null; to_build: string; blocks: string; tools: string }, [string, number]>(
        "SELECT ts, reason, from_build, to_build, blocks, tools FROM build_adoptions WHERE session_id = ? ORDER BY id DESC LIMIT ?")
      .all(id, limit)
      .map((r) => ({ ...r, blocks: JSON.parse(r.blocks), tools: JSON.parse(r.tools) }));
  }

  state(id: string): PinState {
    const row = this.row(id);
    const build = buildId();
    const max = maxAgeMs();
    return {
      build,
      pinned: row ? { build: row.build, since: row.ts } : null,
      waiting: row?.waiting ?? { blocks: [], tools: [] },
      known: !row || row.checked === build,
      behind_since: row?.stale ?? null,
      takes_at: row?.stale && max > 0 ? row.stale + max : null,
      asked: !!row?.asked,
      adoptions: this.adoptions(id),
    };
  }
}

// The adoption of a session between two moments, for a cache break's detail.
export function adoptionBetween(store: Store, id: string, after: number, upto: number): Adoption | undefined {
  if (!store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'build_adoptions'").get()) return undefined;
  const r = store.db
    .query<{ ts: number; reason: string; from_build: string | null; to_build: string; blocks: string; tools: string }, [string, number, number]>(
      "SELECT ts, reason, from_build, to_build, blocks, tools FROM build_adoptions WHERE session_id = ? AND ts > ? AND ts <= ? ORDER BY id DESC LIMIT 1")
    .get(id, after, upto);
  return r ? { ...r, blocks: JSON.parse(r.blocks), tools: JSON.parse(r.tools) } : undefined;
}
