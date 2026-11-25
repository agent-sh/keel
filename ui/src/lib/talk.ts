// Conversation mode, as the page sees it: what the box and the message line show (the phase, what is
// heard, the labels, an error) and the ways to start and end it. The mode itself, the microphone and the
// voice, is talk-run.ts: its code is fetched with the first press of the button or the key, or when the
// pointer is over the button. The turns are talk-core.ts's (pure).
import { useSyncExternalStore } from "react";
import type { Phase } from "./talk-core.ts";

export type Conversation = {
  sid: string | null;
  phase: Phase;
  heard: string;                  // what is being heard now, as words
  recording: "recording" | "transcribing" | null;
  listenLabel: string;
  sayLabel: string | null;        // null: replies are not read aloud (note says why)
  note: string | null;
  error: string | null;
  // The reply waits on a voice: the owner is asked to pick one. `text`: what the provider said (or that it lists
  // voices); `voices`: the names it lists, if it lists any, else the owner types one.
  voiceAsk: { text: string; voices: string[] } | null;
};
export const IDLE: Conversation = { sid: null, phase: "off", heard: "", recording: null, listenLabel: "", sayLabel: null, note: null, error: null, voiceAsk: null };
export let view = IDLE;
const subs = new Set<() => void>();
export const publish = (v: Partial<Conversation>) => { view = { ...view, ...v }; subs.forEach((f) => f()); };
export const useConversation = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => view);
export const conversation = () => view;

let run: typeof import("./talk-run.ts") | null = null;
const engine = () => import("./talk-run.ts").then((m) => (run = m));
export const warmConversation = () => void engine().catch(() => {});

export async function startConversation(sid: string): Promise<void> {
  if (view.phase !== "off") return;
  await (run ?? (await engine())).startConversation(sid);
}
// Ends the mode at once: the microphone closes and the voice stops (nothing runs before the first start).
export function stop() { run?.stop(); }
export const toggleConversation = (sid: string) => (view.phase === "off" && !view.error ? void startConversation(sid) : stop());
// The voice the owner picked for a held reply, or "not this time" (only while the mode runs, so its code is loaded).
export const chooseVoice = (name: string) => run?.chooseVoice(name);
export const skipVoice = () => run?.skipVoice();
export const dismissConversationError = () => publish({ error: null });
