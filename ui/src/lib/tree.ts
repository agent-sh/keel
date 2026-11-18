// The session's branch tree and labels: client state, the side panel tab and
// a bookmark button under prompts and replies.
import { Bookmark, ListTree } from "lucide-react";
import { createElement, lazy } from "react";
import { panels, rowActions, slash } from "./extend.ts";
import { registerCommand } from "./keys.ts";
import { lineage } from "../../../src/core/tree.ts";
import { actions, api, getState } from "./store.ts";
import { getUI, savePref, setUI } from "./ui.ts";

export type TreeNode = {
  event_id: string; parent_event_id: string | null; kind: "prompt" | "summary"; preview: string;
  ts_ms: number; seq: number; label: string | null; active: boolean; head_event_id: string;
};
export type TreeLabel = { event_id: string; label: string; created_ms: number; preview?: string; active?: boolean };
export type TreeState = { trees: Record<string, { nodes: TreeNode[]; labels: TreeLabel[] }>; editing: string | null };

let st: TreeState = { trees: {}, editing: null };
const subs = new Set<() => void>();
const set = (p: Partial<TreeState>) => { st = { ...st, ...p }; subs.forEach((f) => f()); };

export const tree = {
  state: () => st,
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  async load(id: string) {
    const r = await api<{ nodes: TreeNode[]; labels: TreeLabel[] }>(`/api/sessions/${id}/tree`);
    set({ trees: { ...st.trees, [id]: r } });
  },
  async label(id: string, eventId: string, label: string | null) {
    await api(`/api/sessions/${id}/events/${eventId}/label`, { method: "POST", body: JSON.stringify({ label }) });
    set({ editing: null });
    await tree.load(id);
  },
  edit: (eventId: string | null) => set({ editing: eventId }),
  // Show the branch that holds the event and scroll to it.
  async go(id: string, eventId: string, branchEnd?: string) {
    await actions.setHead(id, branchEnd ?? eventId, !branchEnd);
    setUI({ focusEvent: eventId });
    await tree.load(id);
  },
};

const open = () => savePref("panel", "tree");

panels.add({
  id: "tree",
  label: "Branches",
  icon: createElement(ListTree, { className: "size-4" }),
  order: 35,
  component: lazy(() => import("../components/BranchTree.tsx").then((m) => ({ default: m.BranchTree }))),
});

const bookmark = (eventId: string) => { open(); tree.edit(eventId); };
rowActions.add(
  { id: "label", label: "Label this message", icon: createElement(Bookmark, { className: "size-3.5" }), on: "user", run: (e) => bookmark(e.id) },
  { id: "label-reply", label: "Label this message", icon: createElement(Bookmark, { className: "size-3.5" }), on: "assistant", run: (e) => bookmark(e.id) },
);

const current = () => {
  const r = getUI().route;
  return r.name === "session" ? getState().sessions[r.id] : undefined;
};
slash.add({
  id: "tree",
  label: "Show the branches of this session",
  when: ({ session }) => !!session,
  run: () => open(),
});
slash.add({
  id: "label",
  label: "Label the newest message of the branch shown",
  hint: "<name>",
  when: ({ session }) => !!session?.head,
  run: (arg, { session }) => {
    const last = lineage(getState().events[session!.id] ?? [], session!.head).findLast((e) => e.kind === "user" || e.kind === "assistant");
    if (!last) throw new Error("No message to label yet.");
    if (!arg.trim()) return bookmark(last.id);
    return tree.label(session!.id, last.id, arg.trim()).then(open);
  },
});
registerCommand({ id: "branch-tree", label: "Branches of this session", group: "Session", words: "tree labels bookmarks versions", when: () => !!current(), run: open });
