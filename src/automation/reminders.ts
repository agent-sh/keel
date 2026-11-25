import { ownerAwaySince } from "../admin/away.ts";
import { type Alert, deliverTo, openAsks, reminderChannels, channelOf } from "./alerts.ts";
import { capture, D } from "./core.ts";
import { reachLine, reminderWords, step } from "./reminder-schedule.ts";

// A card that waits while the owner is away is told again (src/automation/reminder-schedule.ts says
// when). One reminder a session: the oldest card's words, the count of the others, on the desktop and
// on the phone when one is paired. It is the card's own alert shown again under the session's key, so
// it takes the place of what the desktop showed and the phone posts it under the card's id: never a
// stack. What was told for the card is kept in the store, so a restart keeps the schedule.
// The owner is away by the digest's rule (src/admin/away.ts): no input in any page for the gap. A card
// answered, or read, leaves the schedule; the owner back at a page stops it, and a later absence starts
// the schedule again from its own start.

const LOOK_MS = 30_000;
let lookedAt = 0;

export function migrate() {
  D().store.migrate("CREATE TABLE IF NOT EXISTS card_reminders (card TEXT PRIMARY KEY, anchor INTEGER NOT NULL, sent INTEGER NOT NULL)");
}

// The card an alert is about, as one key: an approval, a plan or a secret by its id, a question by its call in the session that asked.
export function cardOf(a: Alert): string {
  const d = a.data ?? {};
  const asked = d.open_session ?? a.session_id;
  if (d.approval_id) return `approval:${d.approval_id}`;
  if (d.plan_id) return `plan:${asked}:${d.plan_id}`;
  if (d.secret_id) return `secret:${d.secret_id}`;
  return `ask:${asked}:${d.call_id}`;
}

type Row = { card: string; anchor: number; sent: number };

// One look: every card that waits, and the sessions whose reminder is due. Returns the sessions told.
export function tick(now = Date.now(), away: number | null = ownerAwaySince(now), force = false): string[] {
  if (!force && now - lookedAt < LOOK_MS) return [];
  lookedAt = now;
  const told: string[] = [];
  try {
    const db = D().store.db;
    const open = openAsks();
    const kept = new Map(db.query<Row, []>("SELECT card, anchor, sent FROM card_reminders").all().map((r) => [r.card, r]));
    const live = new Set(open.map(cardOf));
    for (const c of kept.keys()) if (!live.has(c)) db.query("DELETE FROM card_reminders WHERE card = ?").run(c);
    if (away === null || !open.length) return told;
    const bySession = new Map<string, Alert[]>();
    for (const a of open) (bySession.get(a.session_id!) ?? bySession.set(a.session_id!, []).get(a.session_id!)!).push(a);
    for (const [session, cards] of bySession) {
      const steps = cards.map((a) => ({ a, card: cardOf(a), s: step(a.ts, away, kept.get(cardOf(a)), now) }));
      const due = steps.filter((x) => x.s.remind);
      if (!due.length) {
        for (const x of steps) save(x.card, x.s.anchor, x.s.sent, kept.get(x.card));
        continue;
      }
      const lead = due[0]!.a; // the card that has waited longest of those due (the list is oldest first)
      const to = reminderChannels(lead.kind);
      if (!to.length) continue;
      // Stored before it is sent: a restart in between tells once less, never twice.
      for (const x of steps) save(x.card, x.s.anchor, x.s.sent, kept.get(x.card));
      const words = reminderWords(lead.title, lead.body, lead.ts, cards.length - 1, now);
      deliverTo({ ...lead, ...words, data: { ...lead.data, in_place: false, reminder: true } }, to, { reminder: true });
      told.push(session);
    }
  } catch (e) {
    capture(e, { at: "card reminders" });
  }
  return told;
}

function save(card: string, anchor: number, sent: number, was: Row | undefined) {
  if (was && was.anchor === anchor && was.sent === sent) return;
  D().store.db.query("INSERT INTO card_reminders (card, anchor, sent) VALUES (?, ?, ?) ON CONFLICT(card) DO UPDATE SET anchor = excluded.anchor, sent = excluded.sent").run(card, anchor, sent);
}

// The time of the next look while a card waits, for the daemon's tick to rest until (undefined when none does).
export function due(now = Date.now()): number | undefined {
  const row = D().store.db.query<{ n: number }, []>("SELECT EXISTS (SELECT 1 FROM alerts WHERE read = 0 AND kind IN ('approval', 'question')) AS n").get();
  return row?.n ? Math.max(now, lookedAt + LOOK_MS) : undefined;
}

// Where reminders reach, for the card, the tray and Settings > Alerts: the line, or null when a phone takes them too.
export function reach(): { line: string | null; paired: boolean; phone: boolean } {
  const push = channelOf("push");
  const paired = push?.paired?.() ?? false;
  const phone = !!push?.available();
  return { line: reachLine({ paired, available: phone }), paired, phone };
}
