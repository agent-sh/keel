// The pure parts of dictation and conversation mode: when speech has ended, what goes in the box,
// what is read aloud, and the turns of a conversation (listening, thinking, speaking). Nothing here
// touches the page, a microphone or the daemon, so each rule is tested alone (talk-core.test.ts).
import type { StoredEvent } from "../../../src/core/types.ts";

// ---- when speech has ended ----

// How long quiet after the last words ends a spoken message (Settings > Speech changes it).
export const SILENCE_MS = 1500;
// Quiet before any word is not an end: nothing was said yet.
export function silenceEnded(o: { words: string; lastAt: number | null; now: number; silenceMs: number }): boolean {
  return !!o.words.trim() && o.lastAt !== null && o.now - o.lastAt >= o.silenceMs;
}

// Speech heard by loudness, for a recording that has no recognizer to say where words end.
// `floor` follows the room's own quiet; loud is a clear step above it.
export type Vad = { floor: number; loudAt: number | null; lastLoudAt: number | null; ended: boolean };
export const VAD_START: Vad = { floor: 0.01, loudAt: null, lastLoudAt: null, ended: false };
const FLOOR_MIN = 0.008, STEP = 3, FLOOR_FOLLOW = 0.05, MIN_SPEECH_MS = 250;
export const loudAbove = (floor: number) => Math.max(FLOOR_MIN * STEP, floor * STEP);

export function vadStep(v: Vad, level: number, now: number, silenceMs: number): Vad {
  if (v.ended) return v;
  const loud = level >= loudAbove(v.floor);
  // The floor learns from what is not loud, never from speech.
  const floor = loud ? v.floor : Math.max(FLOOR_MIN, v.floor + (level - v.floor) * FLOOR_FOLLOW);
  if (loud) return { floor, loudAt: v.loudAt ?? now, lastLoudAt: now, ended: false };
  // Speech counts once it lasted a moment (a click or a cough is not a message); then quiet ends it.
  const spoke = v.loudAt !== null && v.lastLoudAt !== null && v.lastLoudAt - v.loudAt >= MIN_SPEECH_MS;
  const ended = spoke && now - v.lastLoudAt! >= silenceMs;
  return { floor, loudAt: spoke ? v.loudAt : v.lastLoudAt !== null && now - v.lastLoudAt > silenceMs ? null : v.loudAt, lastLoudAt: v.lastLoudAt, ended };
}

// ---- the words in the box ----

// What stood before and after the caret when dictation began.
export type Base = { before: string; after: string };
const closes = /^[\s.,;:!?)\]}'"]/;
// The box with the dictated words at the caret: a space between words and what is around them where
// there is none, and the caret at the end of the words.
export function dictated(base: Base, words: string): { text: string; caret: number } {
  const w = words.trim();
  if (!w) return { text: base.before + base.after, caret: base.before.length };
  const lead = base.before && !/\s$/.test(base.before) ? " " : "";
  const trail = base.after && !closes.test(base.after) ? " " : "";
  const head = base.before + lead + w;
  return { text: head + trail + base.after, caret: head.length };
}

// ---- what is read aloud ----

// A reply as a voice reads it: code and tables are not read out, links read as their words, the
// marks of markdown are dropped.
export function spokenText(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?(```|$)/g, "\n(code omitted)\n")
    .replace(/<[^>\n]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/g, "a link")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/(^|[\s(])[*_]+([^*_\n]+)[*_]+/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s*([-*_]\s*){3,}$/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?:;])\s*\.\s/g, "$1 ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// The text in pieces a speech route takes, cut after a sentence where one ends before the limit.
export function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max);
    const at = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("\n"));
    const cut = at > max / 2 ? at + 1 : Math.max(head.lastIndexOf(" "), 1);
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ---- the reply of the turn a spoken message started ----

export type Reply = { done: false } | { done: true; text: string; reason: string };
// The turn that started after `seq`: not done until it ends; then its last reply's text blocks.
export function replyOf(events: StoredEvent[] | undefined, seq: number): Reply {
  const after = (events ?? []).filter((e) => e.seq > seq);
  const end = after.find((e) => e.kind === "turn_end");
  if (!end) return { done: false };
  const reply = after.filter((e) => e.kind === "assistant" && e.seq < end.seq).findLast((e) => (e.data?.blocks ?? []).some((b: any) => b.type === "text" && String(b.text ?? "").trim()));
  const text = reply ? (reply.data.blocks as any[]).filter((b) => b.type === "text").map((b) => String(b.text)).join("\n\n") : "";
  return { done: true, text, reason: String(end.data?.reason ?? "") };
}

// ---- the turns of a conversation ----

export type Phase = "off" | "listening" | "thinking" | "speaking";
export type Talk = { phase: Phase; final: string; interim: string; lastAt: number | null; error?: string };
export const OFF: Talk = { phase: "off", final: "", interim: "", lastAt: null };

export type TalkEvent =
  | { t: "start"; busy: boolean }                       // the mode is turned on; `busy`: a turn is running
  | { t: "words"; final: string; interim: string; at: number }  // what the recognizer holds now
  | { t: "tick"; now: number; silenceMs: number }
  | { t: "captured" }                                   // a recording ended: it is being turned into words
  | { t: "said"; text: string }                         // the words of that recording (none: nothing was said)
  | { t: "send-failed" }                                // the message could not go: listen again
  | { t: "reply"; text: string }                        // the turn ended; its words to read, if any
  | { t: "spoken" }
  | { t: "recognizer-ended" }                           // the recognizer stopped by itself while listening
  | { t: "failed"; why: string }
  | { t: "stop" };
export type Effect = "listen" | "unlisten" | "hush" | { send: string } | { speak: string };

const join = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(" ");

export function talkStep(s: Talk, e: TalkEvent): { talk: Talk; effects: Effect[] } {
  const same = { talk: s, effects: [] as Effect[] };
  switch (e.t) {
    case "start":
      return e.busy ? { talk: { ...OFF, phase: "thinking" }, effects: [] } : { talk: { ...OFF, phase: "listening" }, effects: ["listen"] };
    case "stop":
      return s.phase === "off" ? same : { talk: OFF, effects: ["unlisten", "hush"] };
    case "failed":
      return s.phase === "off" ? same : { talk: { ...OFF, error: e.why }, effects: ["unlisten", "hush"] };
    case "words": {
      if (s.phase !== "listening") return same;
      const changed = join(e.final, e.interim) !== join(s.final, s.interim);
      return { talk: { ...s, final: e.final, interim: e.interim, lastAt: changed ? e.at : s.lastAt }, effects: [] };
    }
    case "tick": {
      if (s.phase !== "listening") return same;
      const words = join(s.final, s.interim);
      if (!silenceEnded({ words, lastAt: s.lastAt, now: e.now, silenceMs: e.silenceMs })) return same;
      return { talk: { ...OFF, phase: "thinking" }, effects: ["unlisten", { send: words }] };
    }
    case "captured":
      return s.phase === "listening" ? { talk: { ...OFF, phase: "thinking" }, effects: [] } : same;
    case "said": {
      if (s.phase !== "thinking") return same;
      return e.text.trim() ? { talk: s, effects: [{ send: e.text.trim() }] } : { talk: { ...OFF, phase: "listening" }, effects: ["listen"] };
    }
    case "send-failed":
      return s.phase === "thinking" ? { talk: { ...OFF, phase: "listening" }, effects: ["listen"] } : same;
    case "reply": {
      if (s.phase !== "thinking") return same;
      return e.text.trim() ? { talk: { ...OFF, phase: "speaking" }, effects: [{ speak: e.text }] } : { talk: { ...OFF, phase: "listening" }, effects: ["listen"] };
    }
    case "spoken":
      return s.phase === "speaking" ? { talk: { ...OFF, phase: "listening" }, effects: ["listen"] } : same;
    case "recognizer-ended":
      return s.phase === "listening" ? { talk: s, effects: ["listen"] } : same;
  }
}
