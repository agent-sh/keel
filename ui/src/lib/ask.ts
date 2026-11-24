// The helper row on a phone (components/HelperAsk.tsx): a question for the
// helper, typed or spoken, and its answer read back from the daemon
// (POST/GET /api/helper/ask, src/helper/ask.ts). The answer is polled on the
// page's one clock while the helper works, and stops when it is done, the
// page is hidden, or it has not answered in `ANSWER_WAIT_MS` (the row then
// says so, and the owner can look again). The last question is kept, so a
// reload shows its answer.
import { useSyncExternalStore } from "react";
import { every } from "./clock.ts";
import { api } from "./store.ts";

export type AskState = "waiting" | "working" | "done" | "failed" | "stopped";
export type HelperAnswer = {
  id: string;
  chat_id: string;
  state: AskState;
  question: string;
  text: string;
  read: { id: string; title: string; waits: number }[];
  looked: string[];
  ts: number;
};
// `unanswered`: the helper had not answered when the page stopped looking.
type State = { answer: HelperAnswer | null; asking: boolean; error: string; unanswered: boolean };
// How long the page reads an answer that has not come: a helper turn that reads a few sessions answers in
// seconds; past two minutes it is held (a provider's wait, a long turn) and the owner is told, not polled for.
export const ANSWER_WAIT_MS = 2 * 60_000;

const KEPT = "keel.helperAsk";
let state: State = { answer: null, asking: false, error: "", unanswered: false };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export function useAsk<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => sel(state));
}

// What the answer looked at besides single sessions, in words.
const LOOKED: Record<string, string> = { sessions: "the session list", activity: "what happened", mail: "mail", calendar: "the calendar", memory: "its memory" };
// "Read Fix the build, Deploy and the session list": what the answer is from.
export function readLine(a: Pick<HelperAnswer, "read" | "looked">): string {
  const parts = [...a.read.map((r) => r.title), ...a.looked.map((l) => LOOKED[l] ?? l)];
  if (!parts.length) return "";
  return `Read ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`}`;
}
export const pending = (s: AskState | undefined) => s === "waiting" || s === "working";

let stop: (() => void) | null = null;
let since = 0;
async function read(id: string) {
  try {
    const a = await api<HelperAnswer>(`/api/helper/ask/${encodeURIComponent(id)}`);
    // An ask that was queued gets its stored id once delivered; it is read under the id it was given.
    set({ answer: { ...a, id }, error: "" });
    if (!pending(a.state)) { stop?.(); stop = null; }
    else if (Date.now() - since >= ANSWER_WAIT_MS) { stop?.(); stop = null; set({ unanswered: true }); }
  } catch (e) {
    // Gone (the helper's conversation was archived): nothing to follow. A dropped read is read again on the next beat.
    if ((e as { status?: number }).status === 404) { stop?.(); stop = null; localStorage.removeItem(KEPT); set({ answer: null }); }
    else if (!(e as { cut?: boolean }).cut) set({ error: e instanceof Error ? e.message : String(e) });
  }
}
function follow(id: string) {
  stop?.();
  since = Date.now();
  set({ unanswered: false });
  localStorage.setItem(KEPT, id);
  stop = every(1000, () => void read(id));
  void read(id);
}

export async function ask(text: string) {
  const words = text.trim();
  if (!words || state.asking) return;
  set({ asking: true, error: "" });
  try {
    const r = await api<{ id: string; chat_id: string }>("/api/helper/ask", { method: "POST", body: JSON.stringify({ text: words, key: crypto.randomUUID() }) });
    set({ answer: { id: r.id, chat_id: r.chat_id, state: "waiting", question: words, text: "", read: [], looked: [], ts: Date.now() } });
    follow(r.id);
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    set({ asking: false });
  }
}

// Look again for an answer the page stopped waiting for.
export function lookAgain() {
  if (state.answer) follow(state.answer.id);
}

// The answer kept from the last visit, read again once.
export function resume() {
  const id = localStorage.getItem(KEPT);
  if (id && !state.answer) follow(id);
}
export function dismiss() {
  stop?.(); stop = null;
  localStorage.removeItem(KEPT);
  set({ answer: null, error: "", unanswered: false });
}
