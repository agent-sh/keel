// What the daemon says of a provider that cannot be reached (src/providers/outage.ts):
// one line in Activity when the outage is known and one when it is over, with
// its length; and to a session whose agents wait in it, one line with its next
// request ("12 agents wait: the provider cannot be reached since 16:56") and
// one more when they went on. Never a line per agent or per try, and it starts
// no turn: the parent can do nothing about it, and its agents go on by
// themselves.
import { say } from "../admin/daemon-log.ts";
import { zonedClock } from "../core/clock.ts";
import { agentsWaitLine, agentsWentOnLine, outageBegan, outageEnded } from "../core/state-words.ts";
import { span } from "../core/watch.ts";
import type { Outage } from "../providers/outage.ts";
import { addNotice, hasNotice } from "../tools/jobs.ts";
import * as activity from "./activity.ts";
import { readWhere } from "./alerts.ts";
import { D, capture } from "./core.ts";
import * as incidents from "./incidents.ts";

const keyOf = (o: Pick<Outage, "provider" | "since">) => `outage:${o.provider}:${o.since}`;

// The session an agent's wait is told to: its parent, unless the agent is one its parent does not follow.
function parentOf(sessionId: string): string | undefined {
  const { store } = D();
  const s = store.session(sessionId);
  if (!s?.parent_id) return undefined;
  const a = store.db.query<{ def: string | null }, [string]>("SELECT def FROM agents WHERE session_id = ?").get(sessionId);
  if (!a) return undefined;
  try { if (a.def && JSON.parse(a.def).silent) return undefined; } catch {}
  return s.parent_id;
}

const agentsOf = (parent: string, o: Outage) => o.sessions.filter((id) => parentOf(id) === parent).length;

// Lines the notice up for a parent that has none for this outage. Written when
// it is sent, from the agents that wait then; dropped when the outage is over
// by then (nothing happened that the parent needs to know).
function tellParent(parent: string, o: Outage) {
  const key = keyOf(o);
  if (hasNotice(parent, key) || D().providers.outages.parentTold(o, parent)) return;
  let n = 0;
  addNotice(parent, "", {
    key,
    fresh: () => {
      const now = D().providers.outages.list().find((x) => x.provider === o.provider && x.since === o.since);
      n = now ? agentsOf(parent, now) : 0;
      return n ? `[harness] ${agentsWaitLine(n, zonedClock(o.since))}. Keel tries again by itself and they go on when it answers: nothing to send them, and none of them failed.` : undefined;
    },
    stored: () => D().providers.outages.tellParent(o, parent, n),
  });
}

export function bind() {
  const { providers, bus } = D();
  const label = (id: string) => providers.get(id)?.label ?? id;
  const rows = new Map<string, string>();
  const began = (o: Outage) => outageBegan(label(o.provider), zonedClock(o.since), o.sessions.length);
  providers.outages.listen({
    // The state of the session (and of the sessions above it) is read again: it waits, or it went on.
    waiting: (session, o) => {
      bus.emit({ t: "feature", name: "outage", session_id: session, data: o ? { provider: o.provider, since: o.since } : null });
      try {
        if (o?.confirmed) {
          const key = keyOf(o);
          let id = rows.get(key);
          // A resumed outage can still grow. Its original row is close to its start.
          if (!id) {
            id = D().store.db.query<{ id: string }, [number, string, number]>(`SELECT id FROM activity WHERE ts >= ? AND kind = 'daemon' AND sub = 'outage'
              AND json_extract(data, '$.provider') = ? AND json_extract(data, '$.since') = ? ORDER BY ts LIMIT 1`).get(o.since, o.provider, o.since)?.id;
            if (id) rows.set(key, id);
          }
          if (id) activity.outageCount(id, o.sessions.length, began(o));
        }
        // The incident across sessions holds the sessions that wait now.
        incidents.syncHeld();
        const parent = o?.confirmed ? parentOf(session) : undefined;
        if (o && parent) tellParent(parent, o);
      } catch (e) { capture(e, { at: "outage notice" }); }
    },
    open: (o) => {
      const text = began(o);
      say(`[provider] ${text}`, "warn");
      try {
        const row = activity.record("daemon", "outage", null, text, { provider: o.provider, since: o.since, sessions: o.sessions.length, message: o.message });
        if (row) rows.set(keyOf(o), row.id);
        for (const parent of new Set(o.sessions.map(parentOf))) if (parent) tellParent(parent, o);
      } catch (e) { capture(e, { at: "outage began" }); }
      incidents.syncHeld();
    },
    // It lasts: the owner is told once, by the incident's alert (an alert of this kind raised by an
    // older daemon is still read below when the wait ends).
    long: (o) => incidents.syncHeld(o),
    close: (o, ms, answered, parents) => {
      const text = outageEnded(label(o.provider), span(ms), answered);
      say(`[provider] ${text}`);
      const key = keyOf(o);
      rows.delete(key);
      try { readWhere("provider_outage", key); } catch (e) { capture(e, { at: "outage alert" }); }
      try { incidents.outageOver(o, ms, answered); } catch (e) { capture(e, { at: "outage incident" }); }
      try {
        activity.record("daemon", "outage_over", null, text, { provider: o.provider, since: o.since, ms, answered });
        // Only a parent that read the first line gets the second.
        if (answered) for (const [parent, n] of parents) addNotice(parent, `[harness] ${agentsWentOnLine(n, span(ms))}.`);
      } catch (e) { capture(e, { at: "outage ended" }); }
    },
  });
}
