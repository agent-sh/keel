// The next-look queue on the page: what waits on the owner, the costliest
// wait first (src/core/wait-rank.ts says the cost and the rule). The Inbox's
// "Needs you" part lists it, and the key that goes to what waits steps through
// its sessions in the same order (components/AnswerQueue.tsx).
//
// What waits: an ask whose card still waits (the daemon's `open`), and a
// failure that stopped a session the owner has not looked at since (its alert
// unread, the session still failed). Looking at it is what that one asks for.
import type { Alert } from "./automation.ts";
import { rankWaiting } from "../../../src/core/wait-rank.ts";

type Told = Record<string, { watch?: string } | undefined>;

// The session an alert is about: an agent's own when an agent asked or failed.
export const askerOf = (a: Pick<Alert, "session_id" | "data">): string | null => a.data?.child_session ?? a.data?.open_session ?? a.session_id;

export function waitsOnOwner(a: Alert, told: Told): boolean {
  if (a.open) return true;
  if (a.kind !== "failed" || a.read || a.data?.far) return false;
  const asker = askerOf(a);
  return !!asker && told[asker]?.watch === "fail";
}

export const nextLook = <T,>(xs: readonly T[], alert: (x: T) => Alert): T[] =>
  rankWaiting(xs, (x) => { const a = alert(x); return { id: a.id, ts: a.ts, wait: a.data?.wait }; });

// The rows as they stood when the owner's pointer or keyboard came into the list (`held`, by id),
// then what came since, in its own order: nothing moves under the pointer. What left is gone.
export function holdOrder<T>(xs: readonly T[], id: (x: T) => string, held: readonly string[] | null): T[] {
  if (!held) return [...xs];
  const at = new Map(held.map((h, i) => [h, i]));
  const kept = xs.filter((x) => at.has(id(x))).sort((a, b) => at.get(id(a))! - at.get(id(b))!);
  return [...kept, ...xs.filter((x) => !at.has(id(x)))];
}

// Each session's place in the queue, for the key that goes to what waits: the key and the time of
// the costliest wait it holds (an ask of an agent counts for the agent's own session).
export function sessionCosts(alerts: readonly Alert[], told: Told): Map<string, { key: number; ts: number }> {
  const out = new Map<string, { key: number; ts: number }>();
  for (const a of alerts) {
    if (!waitsOnOwner(a, told)) continue;
    const s = askerOf(a);
    if (!s) continue;
    const key = a.data?.wait?.key ?? 0;
    const was = out.get(s);
    if (!was || key > was.key || (key === was.key && a.ts < was.ts)) out.set(s, { key, ts: a.ts });
  }
  return out;
}
