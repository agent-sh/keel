// The session timeline on the client: its page, and the turn another view
// asked it to show (an Activity row's receipt).
import type { turnReceipt } from "../../../src/admin/receipt.ts";
import type { TimelinePage, TimelineRow } from "../../../src/admin/timeline-rows.ts";
import { api } from "./store.ts";
import { getUI, navigate, savePref, setUI } from "./ui.ts";

export type { TimelineKind, TimelineNow, TimelinePage, TimelineRow, Tone } from "../../../src/admin/timeline-rows.ts";
export type Receipt = NonNullable<ReturnType<typeof turnReceipt>>;
export type Only = "" | "failures" | "turns" | "agents";
export const PAGE = 50;

export const fetchTimeline = (sessionId: string, o: { only?: Only; before?: string | null; now?: boolean } = {}) =>
  api<TimelinePage>(`/api/sessions/${sessionId}/timeline?limit=${PAGE}${o.only ? `&only=${o.only}` : ""}${o.before ? `&before=${encodeURIComponent(o.before)}` : ""}${o.now === false ? "&now=0" : ""}`);
export const fetchReceipt = (turnEvent: string) => api<Receipt>(`/api/debug/turns/${turnEvent}/receipt`);

// A fresh first page over what the panel holds. The pages loaded below it stay
// when they still join it; when more arrived than one page holds, they go and
// the list starts again from the top (no gap is ever shown as if it were whole).
export function mergeHead(cur: { rows: TimelineRow[]; next: string | null } | null, head: TimelinePage): { rows: TimelineRow[]; next: string | null } {
  const last = head.rows.at(-1);
  if (!cur || !last || cur.rows.length <= head.rows.length) return { rows: head.rows, next: head.next };
  const older = (r: TimelineRow) => r.ts < last.ts || (r.ts === last.ts && r.id < last.id);
  const top = cur.rows[0];
  if (head.next && top && older(top)) return { rows: head.rows, next: head.next };
  const have = new Set(head.rows.map((r) => r.id));
  return { rows: [...head.rows, ...cur.rows.filter((r) => !have.has(r.id) && older(r))], next: cur.next };
}

// The turn the Timeline panel shows when it opens next.
let focus: string | null = null;
const subs = new Set<() => void>();
export const timelineFocus = {
  get: () => focus,
  set(to: string | null) { focus = to; subs.forEach((f) => f()); },
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
};

// Opens a turn's receipt in its session's Timeline panel.
export function openReceipt(sessionId: string, turnEvent: string) {
  timelineFocus.set(turnEvent);
  setUI({ errors: false });
  if (getUI().panel !== "timeline") savePref("panel", "timeline");
  navigate({ name: "session", id: sessionId });
}
