// Side questions: client state, the side panel tab and the /btw command.
import { MessageCircleQuestion } from "lucide-react";
import { createElement, lazy } from "react";
import type { Usage } from "../../../src/core/types.ts";
import { panels, slash } from "./extend.ts";
import { registerCommand } from "./keys.ts";
import { api, getState } from "./store.ts";
import { getUI, savePref } from "./ui.ts";

export type SideExchange = { id: number; thread_id: string; question: string; answer: string; ts: number; model: string; usage: Usage; ran_tools: boolean };
export type SideThread = { id: string; created_ms: number; exchanges: SideExchange[] };
export type SideState = {
  threads: Record<string, SideThread[]>;
  current: Record<string, string | undefined>; // the thread a follow-up continues
  pending: Record<string, string | undefined>; // the question being answered
  error: Record<string, string | undefined>;
};

// Clears per session: an answer asked before the newest clear is dropped.
const cleared = new Map<string, number>();
let st: SideState = { threads: {}, current: {}, pending: {}, error: {} };
const subs = new Set<() => void>();
const set = (p: Partial<SideState>) => { st = { ...st, ...p }; subs.forEach((f) => f()); };

export const side = {
  state: () => st,
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  async load(id: string) {
    const { threads } = await api<{ threads: SideThread[] }>(`/api/sessions/${id}/side`);
    set({ threads: { ...st.threads, [id]: threads }, current: { ...st.current, [id]: st.current[id] ?? threads.at(-1)?.id } });
  },
  async ask(id: string, question: string) {
    const at = cleared.get(id) ?? 0;
    set({ pending: { ...st.pending, [id]: question }, error: { ...st.error, [id]: undefined } });
    try {
      const r = await api<{ thread_id: string; exchange: SideExchange }>(`/api/sessions/${id}/side`, {
        method: "POST", body: JSON.stringify({ question, thread_id: st.current[id] }),
      });
      if ((cleared.get(id) ?? 0) !== at) return; // cleared meanwhile: its answer is forgotten too
      const list = [...(st.threads[id] ?? [])];
      const t = list.find((x) => x.id === r.thread_id);
      if (t) list[list.indexOf(t)] = { ...t, exchanges: [...t.exchanges, r.exchange] };
      else list.push({ id: r.thread_id, created_ms: r.exchange.ts, exchanges: [r.exchange] });
      set({ threads: { ...st.threads, [id]: list }, current: { ...st.current, [id]: r.thread_id } });
    } catch (e) {
      if ((cleared.get(id) ?? 0) !== at || (e as { body?: { cleared?: boolean } }).body?.cleared) return;
      set({ error: { ...st.error, [id]: (e as Error).message } });
      throw e;
    } finally {
      if ((cleared.get(id) ?? 0) === at) set({ pending: { ...st.pending, [id]: undefined } });
    }
  },
  newThread: (id: string) => set({ current: { ...st.current, [id]: undefined } }),
  async clear(id: string) {
    await api(`/api/sessions/${id}/side`, { method: "DELETE" });
    cleared.set(id, (cleared.get(id) ?? 0) + 1);
    set({ threads: { ...st.threads, [id]: [] }, current: { ...st.current, [id]: undefined }, pending: { ...st.pending, [id]: undefined } });
  },
};

const open = () => savePref("panel", "side");

panels.add({
  id: "side",
  label: "Aside",
  icon: createElement(MessageCircleQuestion, { className: "size-4" }),
  order: 30,
  component: lazy(() => import("../components/SideQuestions.tsx").then((m) => ({ default: m.SideQuestions }))),
});

slash.add({
  id: "btw",
  label: "Ask a side question that stays out of the conversation",
  hint: "<question>",
  when: ({ session }) => !!session,
  run: (arg, { session }) => {
    open();
    if (arg.trim()) side.ask(session!.id, arg.trim()).catch(() => {}); // the panel shows the error
  },
});

registerCommand({
  id: "side-questions",
  label: "Side questions",
  group: "Session",
  words: "btw ask aside",
  when: () => getUI().route.name === "session" && !!getState().sessions[(getUI().route as any).id],
  run: open,
});
