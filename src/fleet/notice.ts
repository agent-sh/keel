// A notice when another session is next idle (keel__session_send with
// notify_when_idle): a zero-token wait of the automation lane, kind "session".
// Watching costs the watched session nothing; the watcher wakes once.
// - Watch only: fires when the session is idle (at once if it already is).
// - Send and watch: fires when that message was handled, by the receiver's own
//   record of it (held, dropped, waiting, or its turn ran and the session is
//   idle again). A link lost meanwhile changes nothing: the next probe asks
//   the receiver again, and a message it never got is never "handled".
import type { Store } from "../core/store.ts";
import type { Engine } from "../engine/turn.ts";
import { create, registerWaitKind, type WaitRecord, type WaitSpec } from "../automation/waits.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError, linkJson } from "./link.ts";
import type { Messages } from "./messages.ts";

export const NOTICE_SECONDS = 12 * 3600; // one notice is wanted today, not next week
const REMOTE_ASK_MS = 30_000; // a remote disposition is asked when its session shows idle, else every 30 s

type Spec = Extract<WaitSpec, { kind: "session" }>;
type Disposition = ReturnType<Messages["disposition"]>;

export function bindNotices(fleet: Fleet, msgs: Messages, store: Store, engine: Engine) {
  const lastAsk = new Map<string, number>();

  const outcome = (spec: Spec, d: Disposition, who: string): string | undefined => {
    if (d.state === "unknown") throw new Error(`${who} has no record of the message`);
    if (d.state === "dropped") return `Your message to ${who} was dropped${d.reason ? `: ${d.reason}` : ""}. It will not be handled.`;
    if (d.reason === "its session is gone") return `${who} is gone; your message was not handled.`;
    if (d.state === "held") throw new Error(`held for the owner on ${who}'s side`);
    return d.handled ? `${who} handled your message and is idle.` : undefined;
  };

  async function probe(w: WaitRecord, signal?: AbortSignal): Promise<string | undefined> {
    const spec = w.spec as Spec;
    const who = spec.title || spec.session;
    if (spec.machine === "local") {
      const s = store.session(spec.session);
      if (!s || s.archived) return `${who} is gone (deleted or archived).`;
      if (spec.message_id) return outcome(spec, msgs.disposition(spec.message_id), who);
      return s.phase !== "working" && !engine.isRunning(s.id) ? `${who} is idle.` : undefined;
    }
    const m = fleet.row(spec.machine);
    if (!m) return `The machine of ${who} was removed from the fleet.`;
    const r = fleet.remoteSessions(m.id);
    const s = r.sessions.find((x) => x.id === spec.session);
    if (!spec.message_id) {
      if (r.stale) throw new Error(`${m.name} is not reachable; its last state is not current`);
      if (!s) return `${who} on ${m.name} is gone.`;
      return s.phase !== "working" ? `${who} on ${m.name} is idle.` : undefined;
    }
    // Only the receiver knows whether it handled the message: ask it when its
    // session looks idle, and now and then whatever the relay shows.
    const looksIdle = !!s && s.phase !== "working" && !r.stale;
    if (!looksIdle && Date.now() - (lastAsk.get(w.id) ?? 0) < REMOTE_ASK_MS) return undefined;
    lastAsk.set(w.id, Date.now());
    try {
      const d = await linkJson<Disposition>(await fleet.peer(m.id), `/api/fleet/messages/${encodeURIComponent(spec.message_id)}/disposition`, { signal });
      const out = outcome(spec, d, `${who} on ${m.name}`);
      if (out) lastAsk.delete(w.id);
      return out;
    } catch (e) {
      if (e instanceof LinkError) throw new Error(`${m.name} is not reachable: ${e.message}`);
      throw e;
    }
  }

  registerWaitKind("session", {
    every: 2_000,
    normalize(spec: any): WaitSpec {
      if (!spec.machine || !spec.session) throw new Error("a session notice needs a machine and a session");
      return { kind: "session", machine: String(spec.machine), session: String(spec.session), title: spec.title ? String(spec.title).slice(0, 200) : undefined, message_id: spec.message_id ? String(spec.message_id) : undefined };
    },
    probe,
  });

  return {
    // One notice for the watcher; returns what the tool says.
    watch(watcher: string, target: { machine: string; machine_name: string; session: string; title?: string }, messageId?: string): string {
      const spec: Spec = { kind: "session", machine: target.machine, session: target.session, title: target.title, message_id: messageId };
      const where = target.machine === "local" ? "" : ` on ${target.machine_name}`;
      const w = create(watcher, spec, { timeout_seconds: NOTICE_SECONDS, note: "" }); // the outcome says it all, once
      return messageId
        ? `You will get one notice (wait ${w.id}) when it has handled this message, at most 12 hours from now. Nothing else to do meanwhile.`
        : `You will get one notice (wait ${w.id}) when ${target.title || target.session}${where} is next idle, at most 12 hours from now.`;
    },
  };
}
