// The daemon's log tells an incident by itself: an approval asked and who
// answered it from where, a call the judge settled, a session's failed turn
// with its class, a message between sessions sent and delivered or not, a
// model request tried again and the provider answering again. Each is one
// bounded line under its session (src/admin/daemon-log.ts has the words),
// heard from the bus here. What other modules say themselves: a wait set and
// settled (automation/waits.ts), a loop's run (automation/loops.ts), a hook's
// refusal or stop (server/routes/hooks.ts), a cut command's fate
// (server/routes/tools.ts).
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { TurnStatus } from "../core/types.ts";
import { errorClass } from "./classes.ts";
import { answeredLine, approvalLine, failedLine, judgedLine, messageLine, retryLine, sayAt } from "./daemon-log.ts";
import { CLASS } from "./timeline-rows.ts";
import { whereSaid, type AnsweredBy } from "../safety/card.ts";

const BOUND = 2000; // what is remembered of cards and messages, the newest kept
const remember = <K, V>(m: Map<K, V>, k: K, v: V) => { m.delete(k); m.set(k, v); if (m.size > BOUND) m.delete(m.keys().next().value!); };

export function bindStory(d: { store: Store; bus: Bus }): () => void {
  const titleOf = (id: string | null | undefined) => (id ? d.store.session(id)?.title : undefined);
  const since = Math.floor(performance.timeOrigin);
  const cards = new Map<string, string>();
  const messages = new Map<string, string>();
  // A failed turn whose error is not stored yet.
  const owed = new Map<string, { turn: string; steps?: number; timer: ReturnType<typeof setTimeout>; tried?: { tries: number; ms: number } }>();
  const failed = (id: string, err?: { kind?: string; status?: number; message?: string }) => {
    const o = owed.get(id);
    if (!o) return;
    owed.delete(id);
    clearTimeout(o.timer);
    const cls = err ? errorClass(err) : null;
    sayAt({ session: id, turn: o.turn }, failedLine({ cls: cls ? CLASS[cls] ?? cls.replace(/_/g, " ") : undefined, status: err?.status, title: titleOf(id), steps: o.steps, tried: o.tried }), "warn");
  };
  // A request being tried again: since when, how many tries.
  const retrying = new Map<string, { since: number; tries: number }>();

  const offs = [
    d.bus.on((f) => {
      if (f.t === "feature" && f.name === "approval" && f.data?.id) {
        const a = f.data as { id: string; state: string; session_id: string; by?: AnsweredBy; tool: string; risk: string; created: number };
        if (cards.get(a.id) === a.state) return;
        remember(cards, a.id, a.state);
        const line = approvalLine(a as any, a.by ? whereSaid(a.by) : undefined, titleOf(a.session_id));
        if (line) sayAt({ session: a.session_id }, line, a.state === "denied" ? "warn" : "info");
        return;
      }
      if (f.t === "feature" && f.name === "judged" && f.data?.session_id) {
        const j = f.data as { session_id: string; outcome: string; tool: string; model?: string };
        const line = judgedLine(j, titleOf(j.session_id));
        const level = j.outcome === "judge" || j.outcome === "retry" ? "info" : "warn";
        if (line) sayAt({ session: j.session_id }, line, level);
        return;
      }
      if (f.t === "feature" && f.name === "fleet_message" && f.data?.id) return message(f.data.id, f.data.state);
      if (f.t === "status") return status(f.session_id, f.status);
      if (f.t !== "event") return;
      const e = f.event;
      if (e.kind === "turn_end") {
        const r = retrying.get(e.session_id);
        // Still retrying at the turn's end: it gave up (a failure), or the provider answered and the turn ended on that answer.
        // (One that failed says its tries on its failed line.)
        if (r) {
          retrying.delete(e.session_id);
          if (e.data?.reason !== "error" && e.data?.reason !== "interrupted" && e.data?.reason !== "restart") sayAt({ session: e.session_id }, answeredLine({ tries: r.tries + 1, ms: Date.now() - r.since, title: titleOf(e.session_id) }));
        }
        if (e.data?.reason !== "error") return;
        // The turn's error is stored right after its end: the line waits for it, to say its class (a moment at most).
        const timer = setTimeout(() => failed(e.session_id), 2000);
        (timer as { unref?: () => void }).unref?.();
        remember(owed, e.session_id, { turn: e.id, steps: e.data?.steps, timer, ...(r ? { tried: { tries: r.tries + 1, ms: Date.now() - r.since } } : {}) });
      } else if (e.kind === "error" && owed.has(e.session_id)) failed(e.session_id, { kind: e.data?.kind, status: e.data?.status, message: e.data?.message });
    }),
  ];

  function status(id: string, st: TurnStatus) {
    const r = retrying.get(id);
    if (st.kind === "retry") {
      if (!r) {
        retrying.set(id, { since: Date.now(), tries: st.attempt });
        sayAt({ session: id }, retryLine({ attempt: st.attempt, max: st.max, inMs: st.at - Date.now(), message: st.message, title: titleOf(id) }), "warn");
      } else r.tries = st.attempt;
      return;
    }
    // The provider answered (a reply is streaming, a tool runs): the retries are over.
    if (r && ((st.kind === "model" && st.connected) || st.kind === "tool")) {
      retrying.delete(id);
      sayAt({ session: id }, answeredLine({ tries: r.tries + 1, ms: Date.now() - r.since, title: titleOf(id) }));
    }
  }

  function message(id: string, state: string) {
    if (messages.get(id) === state) return;
    const first = !messages.has(id);
    remember(messages, id, state);
    const m = d.store.db.query<{ created_ms: number; to_session: string; sender: string; reason: string | null; to_title: string | null; sent_to: string | null }, [string]>(
      "SELECT created_ms, to_session, sender, reason, to_title, sent_to FROM fleet_messages WHERE id = ?").get(id);
    if (!m) return;
    const from = JSON.parse(m.sender) as { session_id: string; title?: string; machine?: string };
    const local = !m.sent_to && d.store.session(m.to_session);
    const to = local ? local.title : m.to_title ?? undefined;
    const sent = first && m.created_ms >= since;
    // Between the first word and the last, a queued message is only on its way: its delivery and its fate are told.
    if (!sent && (state === "queued" || state === "handled")) return;
    const at = local ? m.to_session : from.session_id;
    sayAt({ session: at }, messageLine({ id, from: from.title, to, machine: m.sent_to ?? undefined, state, why: state === "dropped" || state === "held" ? m.reason : undefined, sent }), state === "dropped" ? "warn" : "info");
  }

  return () => { for (const off of offs) off(); for (const o of owed.values()) clearTimeout(o.timer); };
}
