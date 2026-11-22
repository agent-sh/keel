// The sessions a list carries.
//
// A list shows the sessions the owner started, and of the agents' sessions
// the ones that are not at rest: an agent that works or waits (a card of its
// own included: it asks while it runs), one whose failure the owner has not
// looked at, one they pinned, and every session between such an agent and the
// session that started it. An agent that finished is one more row in every
// page's first read and on every reconnect, and after a week of work they are
// most of the list. So they are left out and counted: `left` says, for each
// session the list carries, how many agents' sessions under it were left out
// (under it at any depth, up to the next session the list carries).
//   GET /api/sessions                the list, with `agents_left`
//   GET /api/sessions?agents=all     every session, as before
//   GET /api/sessions?agents_of=ID   every agent's session under ID
// A session that was left out is read by its id like any other
// (GET /api/sessions/ID): a link to it, or a report that names it, opens it.
import type { Session } from "../core/types.ts";

// The failure of its last turn (or a turn the model declined) that the owner has not looked at: src/server/routes/marks.ts.
const failUnseen = (s: Session) => (!!s.settings.failed_ms && s.settings.fail_seen_ms !== s.settings.failed_ms) || s.settings.fail_seen_ms === 0;

// `working`: the agent of this session runs or waits, or a turn runs in it.
export function leanSessions(all: Session[], working: (id: string) => boolean): { sessions: Session[]; left: Record<string, number> } {
  const byId = new Map(all.map((s) => [s.id, s]));
  const keep = new Set<string>();
  for (const s of all) {
    // (An agent whose parent is not in this list has no row to be counted under: it stays.)
    if (!s.parent_id || !byId.has(s.parent_id) || working(s.id) || !!s.settings.pinned_ms || failUnseen(s)) {
      for (let a: Session | undefined = s, n = 0; a && !keep.has(a.id) && n < 64; a = a.parent_id ? byId.get(a.parent_id) : undefined, n++) keep.add(a.id);
    }
  }
  const left: Record<string, number> = {};
  for (const s of all) {
    if (keep.has(s.id)) continue;
    let a = byId.get(s.parent_id!);
    for (let n = 0; a && !keep.has(a.id) && n < 64; n++) a = a.parent_id ? byId.get(a.parent_id) : undefined;
    if (a) left[a.id] = (left[a.id] ?? 0) + 1;
  }
  return { sessions: all.filter((s) => keep.has(s.id)), left };
}

// Every agent's session under `id`, at any depth.
export function agentsUnder(all: Session[], id: string): Session[] {
  const kids = new Map<string, Session[]>();
  for (const s of all) if (s.parent_id) (kids.get(s.parent_id) ?? kids.set(s.parent_id, []).get(s.parent_id)!).push(s);
  const out: Session[] = [];
  const seen = new Set<string>([id]);
  for (let at = [id]; at.length; ) {
    const next: string[] = [];
    for (const p of at) for (const k of kids.get(p) ?? []) if (!seen.has(k.id)) { seen.add(k.id); out.push(k); next.push(k.id); }
    at = next;
  }
  return out;
}
