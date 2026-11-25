// When a card that waits on the owner is told again. Pure: the schedule, the words, and the line that
// says where a reminder can reach.
//
// A card (an approval, a question, a plan, a secret) is told once when it is raised. If the owner is
// away and it still waits, it is told again at growing gaps counted from the start of the absence (or
// from the card, when that is later): 15 minutes, 1 hour, 4 hours, then every 4 hours. Nothing else
// here repeats a notice: Codex notifies once per request, and a desktop or phone notification that is
// shown again under the same key replaces the earlier one, so a reminder never stacks. The first gap
// is longer than the away gap (5 minutes), so a walk to the kitchen is never told; the later ones
// grow so that a night away costs a handful of notices, not dozens.
export const REMIND_MS = [15 * 60_000, 60 * 60_000, 4 * 3600_000] as const;
export const REPEAT_MS = 4 * 3600_000;
// Two readings of "when the owner last did something" this close are one absence: a page that keeps
// reporting an idle owner moves the reading by a few milliseconds each time.
export const SAME_ABSENCE_MS = 60_000;

// How long after the anchor the n-th reminder (1-based) is due.
export const offsetOf = (n: number): number =>
  n <= 0 ? 0 : n <= REMIND_MS.length ? REMIND_MS[n - 1]! : REMIND_MS[REMIND_MS.length - 1]! + (n - REMIND_MS.length) * REPEAT_MS;

// How many reminders are due by `elapsed` after the anchor.
export function dueCount(elapsed: number): number {
  let n = REMIND_MS.filter((m) => elapsed >= m).length;
  if (n === REMIND_MS.length) n += Math.floor((elapsed - offsetOf(n)) / REPEAT_MS);
  return n;
}

export type Kept = { anchor: number; sent: number };
export type Step = { anchor: number; sent: number; remind: boolean; nextAt: number };

// The card's step now. `asked`: when the card was first asked. `lastInput`: when the owner last did
// something in a page (they are away, so it is where this absence began). `kept`: what an earlier look
// stored for the card. One told for this absence is not told again for the same gap: a late look (a
// restart, a busy loop) sends one reminder, not one for each gap it missed.
export function step(asked: number, lastInput: number, kept: Kept | undefined, now: number): Step {
  const anchor = Math.max(asked, lastInput);
  const same = !!kept && Math.abs(kept.anchor - anchor) < SAME_ABSENCE_MS;
  const was = same ? kept!.sent : 0;
  const due = dueCount(now - anchor);
  const remind = due > was;
  const sent = remind ? due : was;
  return { anchor: same ? kept!.anchor : anchor, sent, remind, nextAt: (same ? kept!.anchor : anchor) + offsetOf(sent + 1) };
}

// "20 min", "1 h 5 min", "7 h".
export function waited(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// What a reminder says. `first`: the card that has waited longest of the session's; `others`: how many
// more cards of the session wait.
export function reminderWords(title: string, body: string, askedAt: number, others: number, now: number): { title: string; body: string } {
  const more = others > 0 ? ` ${others} more ${others === 1 ? "card waits" : "cards wait"} in this session.` : "";
  return { title: `Still waiting: ${title}`.slice(0, 200), body: `Waiting ${waited(now - askedAt)}.${more}\n${body}`.slice(0, 500) };
}

// Where a reminder reaches: said on the card, the tray and Settings > Alerts. Nothing when a phone
// takes them too.
export function reachLine(phone: { paired: boolean; available: boolean }): string | null {
  if (!phone.paired) return "No phone paired: reminders reach this desktop only";
  if (!phone.available) return "Phone push is not set up: reminders reach this desktop only";
  return null;
}
