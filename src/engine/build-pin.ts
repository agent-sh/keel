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
// - the owner's or the machine's own side of the prompt changed (an
//   instruction file was edited, an MCP server was added or turned off, a
//   skill was installed): taken at the first request after a daemon start, as
//   before. A block says which part of it is that data (hooks.ts
//   SystemBlock), so a build that only rewords the block still waits;
// - the owner asked (the context popup, or the command).
// Deferred tools and every MCP or catalog tool are not part of the cached
// prefix; they follow the build and the servers per request, as before.
//
// Each adoption is recorded with its reason, and the pin row says what waits,
// so the owner sees which build a session's prefix is from.
import { buildId, URGENT } from "../core/build.ts";
import { SessionMap } from "../core/session-map.ts";
import type { Store } from "../core/store.ts";
import type { Session, StoredEvent } from "../core/types.ts";
import { changedTools, mergeTools, pinOf, type PinnedTool } from "../tools/pin.ts";
import type { Tool } from "../tools/types.ts";
import { checkpointAt, lastWarm } from "./compact.ts";
import { ownChanges, urgentBlock, type PromptBlock } from "./prompt-store.ts";

// Why no warm cache holds this context on `model`, or undefined when one may:
// a reply of the model after the last checkpoint used the cache (or a summary
// prepared on the same prefix did, `preparedMs`) within `keepMs`, the longest
// its route may keep a prefix (retention().max in cachewarn.ts).
export function coldReason(lineage: readonly StoredEvent[], model: string, keepMs: number, now: number, preparedMs = 0): string | undefined {
  const warm = lastWarm(lineage, model, preparedMs);
  if (warm) return now - warm > keepMs ? "the cache expired" : undefined;
  const cp = checkpointAt(lineage).at;
  let reply: StoredEvent | undefined;
  for (let i = lineage.length - 1; i > cp && !reply; i--) if (lineage[i]!.kind === "assistant") reply = lineage[i];
  if (!reply) return cp < 0 ? "a new context" : lineage[cp]!.data.mode === "clear" ? "a clear" : "a compaction";
  return reply.data.model !== model ? "a model switch" : "no cached prefix";
}

export type Waiting = { blocks: string[]; tools: string[] };
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
  asked: boolean;
  adoptions: Adoption[];
};

// `own`: the session's own part of its tool list when it was pinned (registry.ts sessionToolsKey).
type Row = { build: string | null; ts: number; model: string; native: boolean; own: string; list: string; waiting: Waiting; checked: string | null; asked: boolean };

const SCHEMA = `CREATE TABLE IF NOT EXISTS session_pins (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  build TEXT, ts INTEGER NOT NULL, model TEXT NOT NULL, native INTEGER NOT NULL, own TEXT NOT NULL, list TEXT NOT NULL,
  waiting TEXT NOT NULL, checked TEXT, asked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pinned_tools (hash TEXT PRIMARY KEY, tools TEXT NOT NULL);
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
  // A prompt taken up whose tools have not followed yet: the reason and the blocks.
  private took = new Map<string, { why: string; blocks: string[] }>();
  // The blocks of each session's prompt that wait, as this run compared them
  // (a session that dropped out reads them back from its row).
  private blocks = new SessionMap<string[]>(256);
  // Tool lists by fingerprint: sessions of one build, family and wire share one.
  private lists = new Map<string, PinnedTool[]>();

  constructor(private store: Store) {
    store.migrate(SCHEMA);
    store.db.run("DELETE FROM pinned_tools WHERE hash NOT IN (SELECT list FROM session_pins)");
  }

  private row(id: string): Row | undefined {
    const r = this.store.db
      .query<{ build: string | null; ts: number; model: string; native: number; own: string; list: string; waiting: string; checked: string | null; asked: number }, [string]>(
        "SELECT build, ts, model, native, own, list, waiting, checked, asked FROM session_pins WHERE session_id = ?")
      .get(id);
    return r ? { ...r, native: !!r.native, waiting: JSON.parse(r.waiting), asked: !!r.asked } : undefined;
  }

  private list(hash: string): PinnedTool[] {
    let l = this.lists.get(hash);
    if (!l) {
      const r = this.store.db.query<{ tools: string }, [string]>("SELECT tools FROM pinned_tools WHERE hash = ?").get(hash);
      l = r ? (JSON.parse(r.tools) as PinnedTool[]) : [];
      if (this.lists.size >= 32) this.lists.delete(this.lists.keys().next().value!);
      this.lists.set(hash, l);
    }
    return l;
  }

  // Written only when something changed: a step that finds its pin as it was writes nothing.
  private save(id: string, was: Row | undefined, now: Omit<Row, "list"> & { tools: PinnedTool[] }) {
    const text = JSON.stringify(now.tools);
    const list = Bun.hash(text).toString(36);
    const { tools: _, ...rest } = now;
    if (was && JSON.stringify({ ...rest, list }) === JSON.stringify({ build: was.build, ts: was.ts, model: was.model, native: was.native, own: was.own, waiting: was.waiting, checked: was.checked, asked: was.asked, list: was.list })) return;
    this.store.db.transaction(() => {
      this.store.db.query("INSERT OR IGNORE INTO pinned_tools (hash, tools) VALUES (?, ?)").run(list, text);
      this.store.db
        .query(`INSERT INTO session_pins (session_id, build, ts, model, native, own, list, waiting, checked, asked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET build = excluded.build, ts = excluded.ts, model = excluded.model, native = excluded.native,
                  own = excluded.own, list = excluded.list, waiting = excluded.waiting, checked = excluded.checked, asked = excluded.asked`)
        .run(id, now.build, now.ts, now.model, now.native ? 1 : 0, now.own, list, JSON.stringify(now.waiting), now.checked, now.asked ? 1 : 0);
    })();
    this.lists.set(list, now.tools);
  }

  // Why a request of the session on `model` takes this build's tools and
  // prompt now, when it does. `to`: what the request would carry on this
  // build. `cold`: asked only when something waits, or the session was not
  // compared in this run yet.
  due(session: Session, to: Variant, current: Tool[], cold: () => string | undefined): string | undefined {
    const took = this.took.get(session.id);
    if (took) return took.why;
    const row = this.row(session.id);
    if (!row) return undefined;
    if (row.asked) return "the owner asked";
    const other = otherList(row, to);
    if (other) return other;
    const m = mergeTools(this.list(row.list), current, URGENT.tools);
    if (m.urgent) return m.urgent;
    const blocks = this.blocks.get(session.id);
    return m.waiting.length || !blocks || blocks.length ? cold() : undefined;
  }

  begin(id: string, why: string | undefined) {
    if (why) this.why.set(id, why);
  }

  end(id: string) {
    this.why.delete(id);
  }

  // A turn that is running asks before each request: the owner asked, or
  // something waits (then the caller checks whether the cache is cold).
  waits(id: string): "asked" | "behind" | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    if (row.asked || this.took.has(id)) return "asked";
    return row.waiting.blocks.length || row.waiting.tools.length ? "behind" : undefined;
  }

  // The session's prompt was rendered again (`made`) and compared with the
  // kept one (`changed`: the blocks that differ). True when the new render is
  // taken: there is no kept one, the step in hand has a reason, the session
  // moved, a changed block is urgent, or the change is the owner's or the
  // machine's own (the data a block renders, not the build's words).
  // Otherwise the kept prompt stays and the changed blocks wait.
  prompt(id: string, kept: PromptBlock[] | undefined, made: PromptBlock[], changed: string[], moved: boolean): boolean {
    if (!kept || !changed.length) {
      this.blocks.set(id, []);
      return !kept;
    }
    const urgent = urgentBlock(kept, changed);
    const own = ownChanges(kept, made, changed);
    const why = this.why.get(id) ?? this.took.get(id)?.why
      ?? (moved ? "the session moved" : urgent ? `the ${urgent} block has an urgent change` : own.length ? `the owner's side changed (${own.join(", ")})` : undefined);
    if (!why) {
      this.blocks.set(id, changed);
      return false;
    }
    this.blocks.set(id, []);
    this.took.set(id, { why, blocks: changed });
    return true;
  }

  // The tools a request of the session carries: its pinned definitions on the
  // current build's implementations, or the build's own list when the session
  // takes it now (a reason from due or prompt, or one found here).
  tools(session: Session, to: Variant, current: Tool[]): Tool[] {
    const { model, native, own } = to;
    const id = session.id, build = buildId();
    const took = this.took.get(id);
    const row = this.row(id);
    // A subagent on this machine has no prompt of its own to compare: it runs on its parent's.
    if (session.parent_id && !session.machine) this.blocks.set(id, []);
    const blocks = this.blocks.get(id) ?? (row?.checked === build ? row.waiting.blocks : []);
    let reason = took?.why ?? this.why.get(id);
    // A subagent on this machine starts on its parent's list (and prompt), so
    // its first request reads the prefix the parent cached.
    const parent = !row && session.parent_id && !session.machine ? this.row(session.parent_id) : undefined;
    const base = row ?? (parent && !otherList(parent, to) ? parent : undefined);
    const from = base ? this.list(base.list) : undefined;
    if (row) reason ??= otherList(row, to);
    if (from && !reason) {
      const m = mergeTools(from, current, URGENT.tools);
      if (!m.urgent) {
        const waiting = { blocks, tools: m.waiting };
        // Nothing of this build is missing: the session is on it.
        const on = !m.waiting.length && !blocks.length ? build : base!.build;
        this.save(id, row, { build: on, ts: row && on === row.build ? row.ts : Date.now(), model, native, own, tools: m.pin ?? from, waiting, checked: build, asked: !!row?.asked });
        return m.tools;
      }
      reason = m.urgent;
    }
    const pin = current.map((t) => pinOf(t, URGENT.tools[t.name]));
    const tools = from ? changedTools(from, pin) : [];
    this.took.delete(id);
    if (row && (took?.blocks.length || tools.length)) {
      this.store.db
        .query("INSERT INTO build_adoptions (session_id, ts, reason, from_build, to_build, blocks, tools) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, Date.now(), reason ?? "a new context", row.build, build, JSON.stringify(took?.blocks ?? []), JSON.stringify(tools));
    }
    // A prompt that still waits (it could not be rendered again) keeps the label of the build it is from.
    const on = blocks.length ? row?.build ?? null : build;
    const same = !!row && on === row.build && !tools.length && !took?.blocks.length;
    this.save(id, row, { build: on, ts: same ? row.ts : Date.now(), model, native, own, tools: pin, waiting: { blocks, tools: [] }, checked: build, asked: false });
    return current;
  }

  // The built-ins the session's list defers, by name: its tool search finds
  // those (a tool this build moved into the prompt still loads through the
  // search while the session's list defers it).
  deferred(id: string): string[] | undefined {
    const row = this.row(id);
    return row?.native ? this.list(row.list).filter((t) => t.defer).map((t) => t.name) : undefined;
  }

  // The owner asked for this build's tools and prompt: the session's next request takes them.
  ask(id: string): boolean {
    return this.store.db.query("UPDATE session_pins SET asked = 1 WHERE session_id = ?").run(id).changes > 0;
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
    return {
      build,
      pinned: row ? { build: row.build, since: row.ts } : null,
      waiting: row?.waiting ?? { blocks: [], tools: [] },
      known: !row || row.checked === build,
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
