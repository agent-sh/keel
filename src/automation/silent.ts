// An agent that has made no progress past the limit `keel stuck` uses
// (src/core/stuck.ts, the owner's `stuck` settings) is told to its parent
// once, with what it waits on: the parent is the one that can stop it, give
// it more time or go on without it. The daemon's state board marks a session
// stuck when its step passes the limit (src/server/routes/state.ts) and tells
// the mark in a state frame; this module hears that frame. Once a task: the
// task's first event (`first_seq`) is kept with the agent when it is told, so
// the same silence is never told twice, across a restart too. A parent held
// after the owner's Stop is not woken: the notice rides with its next input.
// A notice whose agent spoke again, or ended, before it was sent is taken back.
import type { StuckMark } from "../core/watch.ts";
import { stuckSaid } from "../core/stuck.ts";
import { attr, capture, D, deliver, isPending } from "./core.ts";
import { isSilent } from "./agents.ts";
import { board } from "../server/routes/state.ts";

type Agent = { id: string; parent_id: string; title: string; status: string; first_seq: number; silent_told: number | null };

export function migrate() {
  if (!D().store.columnExists("agents", "silent_told")) D().store.migrate("ALTER TABLE agents ADD COLUMN silent_told INTEGER");
}

const agentOf = (sessionId: string) =>
  D().store.db.query<Agent, [string]>("SELECT id, parent_id, title, status, first_seq, silent_told FROM agents WHERE session_id = ?").get(sessionId);
const isNotice = (id: string) => (m: Record<string, unknown>) => m.kind === "harness" && m.agent_id === id && m.status === "silent";

// The notice as it stands when it is sent: nothing once the agent spoke again, ended, or was told of.
function noticeNow(sessionId: string, mark: StuckMark): { text: string; meta: Record<string, unknown> } | undefined {
  const a = agentOf(sessionId);
  if (!a || a.status !== "running" || a.silent_told === a.first_seq) return undefined;
  // Read again when it is sent: a step that made progress meanwhile is not silent any more.
  const still = board ? board.read(sessionId)?.stuck : mark;
  if (!still) return undefined;
  const said = stuckSaid({ what: still.what, text: still.text, elapsed_ms: Date.now() - still.since });
  const who = attr(a.title) ? `"${attr(a.title)}" ` : "";
  return {
    text: `[harness] Agent ${who}(${a.id}) has made no progress: ${said.charAt(0).toLowerCase()}${said.slice(1)}. It is still running and has not reported. Stop it if it should not wait longer, or go on without it; its report comes if it ends.`,
    meta: { kind: "harness", agent_id: a.id, status: "silent", title: a.title, what: still.what, since: still.since },
  };
}

// A state frame of a session: an agent's that carries a stuck mark is told to its parent once.
export function onState(sessionId: string, st: { stuck?: StuckMark } | null) {
  try {
    if (!st?.stuck) return;
    const a = agentOf(sessionId);
    if (!a || a.status !== "running" || a.silent_told === a.first_seq || isSilent(a.id)) return;
    if (isPending(a.parent_id, isNotice(a.id))) return;
    const first = noticeNow(sessionId, st.stuck);
    if (!first) return;
    const mark = st.stuck;
    deliver(a.parent_id, first.text, first.meta, {
      ride: D().engine.isHeld(a.parent_id),
      refresh: () => noticeNow(sessionId, mark),
      onSent: () => void D().store.db.query("UPDATE agents SET silent_told = ? WHERE id = ?").run(a.first_seq, a.id),
    });
  } catch (e) {
    capture(e, { at: "silent agent notice", session: sessionId });
  }
}
