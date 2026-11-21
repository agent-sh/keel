// The session timeline on the client: its page, how a refresh joins what the
// panel holds, and the turn another view asked it to show (an Activity row's
// receipt).
import type { turnReceipt } from "../../../src/admin/receipt.ts";
import type { TimelinePage } from "../../../src/admin/timeline-rows.ts";
import { api } from "./store.ts";
import { getUI, navigate, savePref, setUI } from "./ui.ts";

export type { TimelineKind, TimelineNow, TimelinePage, TimelineRow, Tone } from "../../../src/admin/timeline-rows.ts";
export type Receipt = NonNullable<ReturnType<typeof turnReceipt>>;
export type Only = "" | "failures" | "turns" | "agents";
export const PAGE = 50;
export { mergePlaced, mergeSince, refreshFrom, unplacedFrom, type Held } from "./timeline-merge.ts";

export const fetchTimeline = (sessionId: string, o: { only?: Only; before?: string | null; since?: number; now?: boolean; limit?: number } = {}) =>
  api<TimelinePage>(`/api/sessions/${sessionId}/timeline?limit=${o.limit ?? PAGE}${o.only ? `&only=${o.only}` : ""}${o.before ? `&before=${encodeURIComponent(o.before)}` : ""}${o.since ? `&since=${Math.floor(o.since)}` : ""}${o.now === false ? "&now=0" : ""}`);
export const fetchReceipt = (turnEvent: string) => api<Receipt>(`/api/debug/turns/${turnEvent}/receipt`);

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

// What the panel showed for a session, kept while another panel is open in
// its place (a trace opened from a receipt): coming back is where it was left.
export type View = { only: Only; open: string | null; active: string | null; top: number };
const views = new Map<string, View>();
export const viewOf = (sessionId: string): View => views.get(sessionId) ?? { only: "", open: null, active: null, top: 0 };
export function keepView(sessionId: string, v: View) {
  views.delete(sessionId);
  views.set(sessionId, v);
  if (views.size > 20) views.delete(views.keys().next().value!);
}
