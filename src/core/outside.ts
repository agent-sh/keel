// The rule for a session another harness runs on this machine (Claude Code,
// Codex: `Session.outside`, src/integrations/outside/service.ts): Keel only
// shows it. Nothing of its text (title, prompts, replies, transcript, its
// state line) leaves this daemon: no hook of the owner's, no memory store, no
// paired machine, no phone gets it. Continuing it in Keel makes a copy of its
// own, with no `outside` mark, and that copy is shared as any session is.
// One exception, the owner's ruling: while Keel answers such a session in place
// (src/integrations/outside/codex-app.ts), the cards its harness raises (a
// one-call approval, a question) reach the owner's own devices as any card does:
// the page, the desktop notification and the phone. No hook of his, no command
// he set for alerts, no paired machine and no standing answer gets them.
import type { Session } from "./types.ts";

export const isOutside = (s: Pick<Session, "outside"> | null | undefined): boolean => !!s?.outside;

// The ids of every such session now (a column of the sessions table, set when one is made).
export const outsideIds = (db: { query: (sql: string) => { all: () => unknown[] } }): Set<string> =>
  new Set((db.query("SELECT id FROM sessions WHERE outside IS NOT NULL").all() as { id: string }[]).map((r) => r.id));

// The same sessions by the id the agent view gives them on this machine (src/drive/agentview.ts rowId:
// <harness>:<its own id>), so the sessions elsewhere routes leave them out for a caller blind to them too.
export const outsideSources = (db: { query: (sql: string) => { all: () => unknown[] } }): Set<string> =>
  new Set((db.query("SELECT json_extract(outside, '$.harness') || ':' || json_extract(outside, '$.source_id') AS k FROM sessions WHERE outside IS NOT NULL").all() as { k: string | null }[]).flatMap((r) => (r.k ? [r.k] : [])));

// What another machine's relay of this daemon is shown (src/server/routes/fleet.ts): every session and
// frame but those of a session another harness runs. A frame goes only when its kind is named below with
// what of it goes; a kind not named stays home, so a frame added later that carries sessions' words is
// not relayed until it says whose they are. The ids are read once, when the relay opens; one made after
// is known by its first frame (the session frame that makes it comes before any other of it).
type Relayed = { t: string; [k: string]: any };
type Away = { has(id: string): boolean; alerts(): Set<string> };
type Rule = (f: Relayed, away: Away) => Relayed | null;

// A frame of one session, named at its top: it goes when that session is shown.
const one = (id: unknown, f: Relayed, away: Away) => (typeof id === "string" && id && !away.has(id) ? f : null);
const ofSession: Rule = (f, away) => one(f.session_id, f, away);

// The feature frames of one session (`session_id` at the top), each about that session alone. A frame of
// these kinds that names no session is this daemon's own matter and stays home.
const OF_SESSION = [
  "agents_now", "approval", "artifacts", "blocked", "checkpoints", "code_call", "draft", "fails_before", "handoff_progress",
  "handoff_waiting", "heavy", "jobs", "judged", "landing", "lane_plan", "mcp-session", "mcp_app_call", "memory", "outage",
  "overlap", "pairs", "perm", "pictures", "plan", "pr-reviews", "quarantine", "readers", "recap", "reviews", "rulings", "secret",
  "state", "steward", "trust", "tree_review", "voice", "worktree",
];
// The automation's frames say what they are about inside (src/automation/core.ts emit): an agent, a wait,
// a loop, an alert, the inbox read, an activity line, a snooze, a goal, a checklist.
const AUTOMATION = new Set(["agent", "wait", "loop", "alert", "alerts_read", "activity", "snooze", "goal", "tasks"]);
const automation: Rule = (f, away) => {
  const d = f.data as { kind?: string; data?: any; counts?: unknown } | undefined;
  if (!d || !AUTOMATION.has(d.kind ?? "")) return null;
  const inner = d.data && typeof d.data === "object" ? d.data : undefined;
  for (const k of ["session_id", "parent_id"]) if (typeof inner?.[k] === "string" && away.has(inner[k])) return null;
  // The inbox's counts are this daemon's (the far side keeps its own) and count every session: they stay home.
  if (d.kind !== "alerts_read" || !inner) return { ...f, data: { kind: d.kind, data: d.data } };
  // Alerts read or marked unread: by their ids, which an alert of a hidden session is not among; how many
  // changed counts those too, so it stays home.
  const hidden = away.alerts();
  if (typeof inner.unread === "string" && hidden.has(inner.unread)) return null;
  const { changed: _n, ...rest } = inner as Record<string, unknown>;
  if (Array.isArray(rest.ids)) {
    const ids = (rest.ids as unknown[]).filter((i) => !(typeof i === "string" && hidden.has(i)));
    if (!ids.length) return null;
    rest.ids = ids;
  }
  return { ...f, data: { kind: d.kind, data: rest } };
};

const RELAY: Record<string, Rule> = {
  session: (f, away) => one(f.session?.id, f, away),
  event: (f, away) => one(f.event?.session_id, f, away),
  delta: ofSession,
  status: ofSession,
  queue: ofSession,
  questions: (f, away) => ({ ...f, pending: (Array.isArray(f.pending) ? f.pending : []).filter((q: any) => !away.has(q?.session_id) && !(typeof q?.parent_id === "string" && away.has(q.parent_id))) }),
  // A new page was installed there: no session's words.
  ui: (f) => f,
};
const FEATURE: Record<string, Rule> = { automation, ...Object.fromEntries(OF_SESSION.map((n) => [n, ofSession])) };

export function forPeers(db: Parameters<typeof outsideIds>[0]) {
  const ids = outsideIds(db);
  const away: Away = {
    has: (id) => ids.has(id),
    // The alerts of hidden sessions, read when a frame names alerts by id (the inbox read: seldom).
    alerts() {
      try {
        return new Set((db.query("SELECT id FROM alerts WHERE session_id IN (SELECT id FROM sessions WHERE outside IS NOT NULL)").all() as { id: string }[]).map((r) => r.id));
      } catch { return new Set(); } // a store with no inbox has no alert to hide
    },
  };
  return {
    sessions: <S extends { id: string }>(all: S[]) => all.filter((s) => !ids.has(s.id)),
    states: <V>(all: Record<string, V>) => Object.fromEntries(Object.entries(all).filter(([id]) => !ids.has(id))),
    // The frame as it goes to the other machine, or null when it stays home.
    relay(f: Relayed): Relayed | null {
      if (f.t === "session" && isOutside(f.session)) ids.add(f.session.id);
      const rule = f.t === "feature" ? FEATURE[f.name] : RELAY[f.t];
      return rule ? rule(f, away) : null;
    },
  };
}
