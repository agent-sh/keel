// A session's plans of lanes (src/automation/lane-plans.ts): read when the Lane plan panel shows the
// session, again when the daemon says one of them changed (a lane started, its agent moved, a lane
// was told it strayed), and after the owner's own act. Nothing is read while the panel is closed.
import { useEffect, useSyncExternalStore } from "react";
import type { PlanView } from "../../../src/automation/lane-plans.ts";
import { api, onFeature, reportUnlessGone } from "./store.ts";

export type { LaneView, PlanView } from "../../../src/automation/lane-plans.ts";

let byId: Record<string, PlanView[] | undefined> = {};
const shown = new Map<string, number>();
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const reading = new Map<string, Promise<void>>();

export function loadPlans(id: string): Promise<void> {
  const out = reading.get(id);
  if (out) return out;
  const read = (async () => {
    const r = await api<{ plans: PlanView[] }>(`/api/sessions/${id}/lane-plans`);
    byId = { ...byId, [id]: r.plans };
    subs.forEach((f) => f());
  })().finally(() => { if (reading.get(id) === read) reading.delete(id); });
  reading.set(id, read);
  return read;
}

export function usePlans(id: string): PlanView[] | undefined {
  useEffect(() => {
    shown.set(id, (shown.get(id) ?? 0) + 1);
    loadPlans(id).catch(reportUnlessGone);
    return () => { const n = (shown.get(id) ?? 1) - 1; if (n > 0) shown.set(id, n); else shown.delete(id); };
  }, [id]);
  return useSyncExternalStore(subscribe, () => byId[id]);
}

export async function makePlan(sessionId: string, lanes: { title: string; brief: string; files: string[] }[]): Promise<PlanView> {
  const v = await api<PlanView>(`/api/sessions/${sessionId}/lane-plans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lanes }) });
  await loadPlans(sessionId);
  return v;
}

export async function startPlan(sessionId: string, plan: string, how: "order" | "all" | number[]) {
  const r = await api<{ started: number[]; waiting: number[]; failed: { idx: number; why: string }[] }>(`/api/lane-plans/${plan}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Array.isArray(how) ? { lanes: how } : { how }) });
  await loadPlans(sessionId);
  return r;
}

export async function dropPlan(sessionId: string, plan: string) {
  await api(`/api/lane-plans/${plan}`, { method: "DELETE" });
  await loadPlans(sessionId);
}

// The owner's plan as typed: lanes apart by a line of three dashes, each its title on its first line,
// a line "files: a, b" for what it touches, and the rest its brief.
export function parseLanes(text: string): { title: string; brief: string; files: string[] }[] {
  return text.split(/^\s*---\s*$/m).map((block) => {
    const lines = block.split("\n");
    while (lines.length && !lines[0]!.trim()) lines.shift();
    const title = (lines.shift() ?? "").trim();
    const files: string[] = [];
    const rest: string[] = [];
    for (const l of lines) {
      const m = /^\s*files\s*:\s*(.*)$/i.exec(l);
      if (m) files.push(...m[1]!.split(/[\s,]+/).filter(Boolean));
      else rest.push(l);
    }
    const brief = rest.join("\n").trim();
    return { title, brief: brief || title, files };
  }).filter((l) => l.title || l.brief);
}

onFeature({
  frame(f) {
    if (f.name === "lane_plan" && f.session_id && shown.has(f.session_id)) loadPlans(f.session_id).catch(reportUnlessGone);
  },
  reconnect() {
    for (const id of shown.keys()) loadPlans(id).catch(reportUnlessGone);
  },
});
