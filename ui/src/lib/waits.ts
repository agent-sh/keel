// What waits on the owner besides approvals and questions: a plan a session
// presented, and a secret it asked for. The page hears of both by frames while
// it is open; for a session that was at work when the page opened it asks
// once (`look`). The home screen reads them from here, so a session that
// waits on a plan or a secret is counted and has a row. (When the daemon
// serves each session's state, this file is what that replaces.)
import { useSyncExternalStore } from "react";
import type { PlanCard } from "../../../src/server/routes/plan.ts";
import { secrets } from "./secrets.ts";
import { api, onFeature, reportUnlessGone } from "./store.ts";

type State = { plans: Record<string, PlanCard[]> };
let state: State = { plans: {} };
const subs = new Set<() => void>();
const set = (plans: State["plans"]) => { state = { plans }; subs.forEach((f) => f()); };
export const usePlans = <T,>(sel: (s: State) => T): T => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));

const step = (list: PlanCard[] = [], f: { state: "open" | "closed"; card: PlanCard }) =>
  f.state === "open" ? [...list.filter((c) => c.id !== f.card.id), f.card] : list.filter((c) => c.id !== f.card.id);

const looked = new Set<string>();
// Ask once what waits in these sessions (the ones at work: a turn that waits on a plan or a secret is one).
export function look(ids: string[]) {
  for (const id of ids) {
    if (looked.has(id)) continue;
    looked.add(id);
    api<{ open: PlanCard[] }>(`/api/sessions/${id}/plan`).then((r) => set({ ...state.plans, [id]: r.open })).catch(reportUnlessGone);
    secrets.load(id).catch(reportUnlessGone);
  }
}

onFeature({
  // What opened while the page was cut off is asked for again.
  reconnect: () => looked.clear(),
  frame(f) {
    const sid = f.session_id as string | undefined;
    if (f.name === "plan" && sid) set({ ...state.plans, [sid]: step(state.plans[sid], f.data) });
  },
});
