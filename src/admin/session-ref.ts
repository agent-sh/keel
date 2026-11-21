// A session named loosely: its id, a prefix of it that names one session, its
// last twelve characters (the short id the report across sessions prints), or
// an agent by its id or a prefix of that (the agent's session). The command
// line, the timeline route and the timeline tool all name sessions this way,
// so an id copied from a row or a card opens what it names.
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";

const fail = (message: string, status: number) => Object.assign(new Error(message), { status });
const HEX = /^[0-9a-f-]{4,}$/i;
const SHORT = /^[0-9a-f]{12}$/;

// The sessions a name could mean, exact matches first. `of`: only agents this
// session started (and their sessions), for a tool that reads no one else's.
export function sessionRefs(store: Store, ref: string, of?: string): string[] {
  const db = store.db;
  const agents = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get();
  const mine = of ? " AND parent_id = ?2" : "";
  const args = (v: string): [string] | [string, string] => (of ? [v, of] : [v]);
  const id = ref.trim();
  if (!id) return [];
  if (!of && store.session(id)) return [id];
  const agent = agents ? db.query<{ session_id: string }, [string] | [string, string]>(`SELECT session_id FROM agents WHERE (id = ?1 OR session_id = ?1)${mine}`).get(...args(id)) : undefined;
  if (agent) return [agent.session_id];
  if (!HEX.test(id)) return [];
  const part = id.toLowerCase().replace(/[%_]/g, "");
  const out = new Set<string>();
  // A prefix, then the short id: an id's start is its time, its last twelve characters are what
  // tells two sessions apart. No shorter ending names a session.
  for (const like of [`${part}%`, ...(SHORT.test(part) ? [`%${part}`] : [])]) {
    if (!of) for (const r of db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE id LIKE ? LIMIT 6").all(like)) out.add(r.id);
    if (agents) for (const r of db.query<{ session_id: string }, [string] | [string, string]>(`SELECT session_id FROM agents WHERE (id LIKE ?1 OR session_id LIKE ?1)${mine} LIMIT 6`).all(...args(like))) out.add(r.session_id);
    if (out.size) break;
  }
  return [...out];
}

// The one session a name means; refused (404, 409) when it means none or several.
export function sessionRef(store: Store, ref: string): Session {
  const ids = sessionRefs(store, ref);
  if (ids.length > 1) throw fail(`${ref} names more than one session: ${ids.join(", ")}`, 409);
  const s = ids[0] ? store.session(ids[0]) : undefined;
  if (!s) throw fail(`no session ${ref}`, 404);
  return s;
}
