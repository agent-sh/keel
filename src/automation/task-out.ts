import { D, emit } from "./core.ts";
import * as goals from "./goals.ts";

// A task taken out into a session of its own, on its session's model and
// folder. Once: a retry answers with the session it already has. A task that
// was completed or cancelled meanwhile is not started (reopen it first).
//
// The destination, the row's link to it and its first prompt are one write: a
// daemon stopped anywhere in it leaves none of the three, and the retry
// launches the task once. The prompt is stored with its turn owed, so a stop
// right after the write runs it at the next start.
export function start(sourceId: string, taskId: string): { status: number; body: Record<string, unknown> } {
  const { store, bus, engine } = D();
  const s = store.session(sourceId);
  if (!s) return { status: 404, body: { error: "no such session" } };
  const t = goals.tasks(s.id).find((x) => x.id === taskId);
  if (!t) return { status: 404, body: { error: "no such task" } };
  const prompt = (to: string) => engine.send(to, `${t.text}\n\n(A task taken from the session "${s.title || "untitled"}".)`, { meta: { kind: "task_start", from_session: s.id, task_id: t.id } });
  if (t.dest_session && store.session(t.dest_session)) {
    // Linked by a daemon that stopped before the prompt, when these were separate writes: it gets it now.
    const prompted = store.db.query("SELECT 1 FROM events WHERE session_id = ? AND kind = 'user' AND json_extract(data, '$.kind') = 'task_start' AND json_extract(data, '$.task_id') = ? LIMIT 1").get(t.dest_session, t.id);
    if (!prompted) prompt(t.dest_session);
    return { status: 200, body: { session_id: t.dest_session, existing: true } };
  }
  if (t.status === "completed" || t.status === "cancelled") return { status: 409, body: { error: `the task is ${t.status === "completed" ? "done" : "cancelled"}; reopen it to start it`, status: t.status } };
  try {
    const n = store.db.transaction(() => {
      const made = store.createSession({ model: s.model, workspace: s.workspace, title: t.text.slice(0, 80) });
      // Its folder is a folder of the machine the source's tools run on: the
      // new session's tools run there too, from its first prompt.
      if (s.machine) store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(s.machine, made.id);
      goals.editTask(s.id, t.id, { status: "in_progress", dest_session: made.id });
      bus.emit({ t: "session", session: store.session(made.id)! });
      prompt(made.id);
      return made;
    })();
    return { status: 201, body: { session_id: n.id } };
  } catch (e) {
    // The link went with the rest: pages that saw it get the list as it is stored.
    emit("tasks", { session_id: s.id, tasks: goals.tasks(s.id) });
    throw e;
  }
}
