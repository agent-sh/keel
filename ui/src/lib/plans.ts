// The plans that wait for the owner's approval, by session, as far as this
// page knows: every plan that opened or closed while the page was connected
// (the daemon tells all pages), and the open plans of each session it shows.
// The answering sequence reads it (components/AnswerQueue.tsx).
import { useSyncExternalStore } from "react";
import { onFeature } from "./store.ts";

let open: Record<string, string[]> = {};
const subs = new Set<() => void>();
const set = (session: string, ids: string[]) => {
  if ((open[session] ?? []).join() === ids.join()) return;
  open = { ...open, [session]: ids };
  subs.forEach((f) => f());
};
// A session's view read its open plans.
export const setOpenPlans = set;
export const usePlans = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => open);

onFeature({
  frame(f) {
    if (f.name !== "plan" || !f.session_id) return;
    const { state, card } = f.data as { state: "open" | "closed"; card: { id: string } };
    const rest = (open[f.session_id] ?? []).filter((id) => id !== card.id);
    set(f.session_id, state === "open" ? [...rest, card.id] : rest);
  },
});
