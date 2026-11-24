// An agent's write scope as the automation keeps it: the places its spawn gave
// it (`writes`, or a reviewer's default of its own worktree and scratch), the
// questions it asked its parent about a write outside them, and the parent's
// answers. The gate decides each write (src/safety/write-scope.ts, from the
// places the judge reads too); this module is where it learns the scope and
// where it asks.
//
// A write outside the scope is refused and is one question to the parent: the
// agent goes on with the rest, the parent is told once per path (a later
// write there is refused with what was asked, and never asks again), and the
// parent's yes is a message to the agent that names the path in its `writes`
// (SendMessage, send_input). A question is owed in its own table until its
// prompt is stored in the parent's session, so a restart tells it once.
import type { Session } from "../core/types.ts";
import { realOf, homeDir } from "../core/paths.ts";
import * as perm from "../server/routes/permissions.ts";
import { isReviewer, parseWrites, scopes, type Given } from "../safety/write-scope.ts";
import { capture, D, deliver, isPending } from "./core.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS agent_write_asks (
  id TEXT PRIMARY KEY,
  agent_session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  glob INTEGER NOT NULL DEFAULT 0,
  tool TEXT,
  state TEXT NOT NULL,
  told INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  answered INTEGER,
  UNIQUE (agent_session, path)
);
CREATE INDEX IF NOT EXISTS agent_write_asks_owed ON agent_write_asks(parent_id) WHERE told = 0;`;

// (The agents' own column, writes, is made with the agents table: src/automation/agents.ts migrate.)
export const migrate = () => D().store.migrate(SCHEMA);

type Spawned = { places: { path: string; glob?: true }[] };
type AskRow = { id: string; agent_session: string; parent_id: string; path: string; glob: number; tool: string | null; state: "pending" | "allowed"; told: number; created: number };

// The scope of an agent's session: none for a session that is no agent, or an agent given no scope.
export function given(sessionId: string): Given | undefined {
  let row: { writes: string | null } | null = null;
  try { row = D().store.db.query<{ writes: string | null }, [string]>("SELECT writes FROM agents WHERE session_id = ?").get(sessionId); } catch { return undefined; } // no agents table yet
  if (!row?.writes) return undefined;
  let spawned: Spawned;
  try { spawned = JSON.parse(row.writes); } catch { return undefined; }
  const allowed = D().store.db.query<{ path: string; glob: number }, [string]>("SELECT path, glob FROM agent_write_asks WHERE agent_session = ? AND state = 'allowed'").all(sessionId);
  return { places: [...(spawned.places ?? []), ...allowed.map((a) => (a.glob ? { path: a.path, glob: true as const } : { path: a.path }))] };
}

// The scope a spawn gives its agent, as stored with its record, what of `writes` was not taken (told to the parent
// with the rest of what the agent starts without), and why it has one (told to the parent with the spawn's result).
// Null: no scope. An agent has one when its spawn names writes, when its type reviews or verifies, or when its parent
// has a scope itself: a scoped agent never starts one that writes as it likes. `cwd`: the agent's folder, where a
// relative path is read from.
export async function forSpawn(parent: Session, writes: unknown, a: { type?: string; cwd: string }): Promise<{ json: string | null; left: string[]; why?: string }> {
  const why = writes !== undefined ? "its spawn named the paths it may write"
    : isReviewer(a.type) ? `its type, ${a.type}, is one that reviews or verifies, so it writes only its own folders unless its spawn names more`
    : given(parent.id) ? "this session has a write scope of its own, and an agent it starts writes no more than it may"
    : undefined;
  if (!why) return { json: null, left: [] };
  const parsed = parseWrites(writes ?? [], a.cwd, realOf(homeDir()));
  if ("error" in parsed) throw new Error(parsed.error);
  const left: string[] = [];
  const places: Spawned["places"] = [];
  for (const p of parsed.places) {
    const no = await refusedGift(parent, a.cwd, p.path);
    if (no) left.push(`writes ${p.path}: ${no}`);
    else places.push(p);
  }
  return { json: JSON.stringify({ places }), left, why };
}

// What the parent is told of an agent's scope with the spawn's result: where it may write and why.
export function spawnLine(child: Session, json: string, why: string): string {
  return `It may write only in ${placesSaid(child, json)} (and temporary files), because ${why}. A write elsewhere is refused and asks you once; to let it, send it a message whose writes names the path.`;
}

function placesSaid(child: Session, json: string): string {
  let spawned: Spawned = { places: [] };
  try { spawned = JSON.parse(json); } catch {} // stored by forSpawn: always this shape
  const own = perm.gate ? perm.gate.placesFor(child).filter((p) => p.from !== "writes").map((p) => p.path) : [child.workspace];
  return [...new Set([...own, ...spawned.places.map((p) => p.path)])].join(", ");
}

// Why a parent cannot give a path: it is in the owner's checkout or its git directory, or the parent has a scope of
// its own that does not hold it (a parent gives no more than it may write).
async function refusedGift(parent: Session, agentFolder: string, path: string): Promise<string | undefined> {
  const g = perm.gate;
  if (!g) return undefined;
  return g.giftRefused(parent, agentFolder, path);
}

// A write outside an agent's scope: the question to its parent, once per path, and what the agent is told.
export function ask(sessionId: string, paths: string[], tool: string): string {
  const { store } = D();
  const s = store.session(sessionId);
  const parentId = s?.parent_id;
  if (!s || !parentId) return `Refused: ${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} outside the paths this agent may write.`;
  const fresh: string[] = [], asked: string[] = [];
  const now = Date.now();
  for (const path of paths) {
    const had = store.db.query<{ state: string }, [string, string]>("SELECT state FROM agent_write_asks WHERE agent_session = ? AND path = ?").get(sessionId, path);
    if (had) { asked.push(path); continue; }
    store.db.query("INSERT INTO agent_write_asks (id, agent_session, parent_id, path, tool, state, told, created) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)").run(Bun.randomUUIDv7(), sessionId, parentId, path, tool, now);
    fresh.push(path);
  }
  if (fresh.length) tell(parentId);
  const scope = scopeLine(sessionId);
  const said = [
    fresh.length ? `${fresh.join(", ")} ${fresh.length === 1 ? "is" : "are"} outside the paths you may write (${scope}). Your parent session was asked once whether you may; its answer comes as a message.` : "",
    asked.length ? `${asked.join(", ")}: your parent was asked about ${asked.length === 1 ? "it" : "them"} already and has not let you write there. It is not asked again.` : "",
  ].filter(Boolean).join(" ");
  return `Refused: ${said} Go on with the rest of your task, or end your turn and say in your report what waits on it.`;
}

// Where the agent may write, in a line: its own folders and what it was given.
function scopeLine(sessionId: string): string {
  const s = D().store.session(sessionId);
  const g = perm.gate;
  const places = s && g ? g.placesFor(s) : [];
  return places.map((p) => p.path).join(", ") || "its own folder";
}

// What an agent with a scope is told with its task: where it may write, and what happens elsewhere.
export function taskLine(child: Session, json: string): string {
  return `You may write only in: ${placesSaid(child, json)} (and temporary files). A write anywhere else is refused, and your parent is asked once whether you may write that path; its answer comes as a message. The owner's own checkout and its git directory are never yours to write.`;
}

// The questions owed to a parent go out as one input; each is settled when its prompt is stored.
function tell(parentId: string) {
  if (isPending(parentId, (m) => m.kind === "write_asks")) return; // on its way: read again when sent
  const first = owed(parentId);
  if (first) deliver(parentId, first.text, first.meta, { coalesceMs: 300, refresh: () => owed(parentId), onSent: () => settle(first.meta.ids as string[]) });
}
function settle(ids: string[]) {
  const q = D().store.db.query("UPDATE agent_write_asks SET told = 1 WHERE id = ?");
  for (const id of ids) q.run(id);
}

function owed(parentId: string): { text: string; meta: Record<string, unknown>; onSent: () => void } | undefined {
  const { store } = D();
  const rows = store.db.query<AskRow, [string]>("SELECT * FROM agent_write_asks WHERE parent_id = ? AND told = 0 AND state = 'pending' ORDER BY created LIMIT 40").all(parentId);
  if (!rows.length) return undefined;
  const by = new Map<string, AskRow[]>();
  for (const r of rows) by.set(r.agent_session, [...(by.get(r.agent_session) ?? []), r]);
  const parts: string[] = [];
  for (const [sid, list] of by) {
    const a = store.db.query<{ id: string; title: string }, [string]>("SELECT id, title FROM agents WHERE session_id = ?").get(sid);
    if (!a) continue;
    parts.push(`Agent ${a.id} (${a.title}) asks to write outside the paths it was given (${scopeLine(sid)}):\n${list.map((r) => `- ${r.path}${r.tool ? ` (by ${r.tool})` : ""}`).join("\n")}\nThe write was refused and it goes on with the rest. To let it, send it a message whose writes names ${list.length === 1 ? "the path" : "the paths"} (SendMessage or send_input; a folder lets it write everything under it). To keep it out, tell it so, or leave it: it does not ask again.`);
  }
  if (!parts.length) { settle(rows.map((r) => r.id)); return undefined; }
  const ids = rows.map((r) => r.id);
  return { text: `[harness] ${parts.join("\n\n")}`, meta: { kind: "write_asks", ids }, onSent: () => settle(ids) };
}

// The parent's yes: the paths its message to the agent names in `writes`. Only the agent's own parent widens its
// scope, with no more than the parent may give. Returns the line the message carries, or throws why not.
export async function allow(fromSessionId: string, agentSessionId: string, writes: unknown): Promise<string> {
  const { store } = D();
  const s = store.session(agentSessionId);
  if (!s) throw new Error("no such agent");
  if (s.parent_id !== fromSessionId) throw new Error("writes widens the scope of an agent you started; this agent was started by another session");
  const from = store.session(fromSessionId)!;
  if (!given(agentSessionId)) throw new Error("this agent has no write scope (its spawn named no writes, its type is no reviewer's and you have no scope yourself): it writes wherever its permissions let it. Send the message without writes");
  const parsed = parseWrites(writes, s.workspace, realOf(homeDir()));
  if ("error" in parsed) throw new Error(parsed.error);
  if (!parsed.places.length) return "";
  for (const p of parsed.places) {
    const why = await refusedGift(from, s.workspace, p.path);
    if (why) throw new Error(`writes ${p.path}: ${why}`);
  }
  const now = Date.now();
  for (const p of parsed.places) {
    const path = p.glob ? p.path : realOf(p.path);
    store.db.query("INSERT INTO agent_write_asks (id, agent_session, parent_id, path, glob, state, told, created, answered) VALUES (?, ?, ?, ?, ?, 'allowed', 1, ?, ?) ON CONFLICT(agent_session, path) DO UPDATE SET state = 'allowed', told = 1, answered = excluded.answered")
      .run(Bun.randomUUIDv7(), agentSessionId, fromSessionId, path, p.glob ? 1 : 0, now, now);
    // A question about a path under a folder given now is answered by it.
    if (!p.glob) store.db.query("UPDATE agent_write_asks SET state = 'allowed', told = 1, answered = ? WHERE agent_session = ? AND state = 'pending' AND (path = ? OR path LIKE ? || '/%')").run(now, agentSessionId, path, path);
  }
  perm.gate?.forgetPlaces(agentSessionId);
  return `Your parent lets you write ${parsed.places.map((p) => p.path).join(", ")} from now on.`;
}

// After a restart: the questions not yet told are told.
export function recover() {
  try {
    for (const r of D().store.db.query<{ parent_id: string }, []>("SELECT DISTINCT parent_id FROM agent_write_asks WHERE told = 0 AND state = 'pending'").all()) tell(r.parent_id);
  } catch (e) { capture(e, { at: "write asks recover" }); }
}

export function init() {
  scopes.of = given;
  scopes.ask = ask;
}
