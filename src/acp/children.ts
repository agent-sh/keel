// An external ACP agent's children as Keel agent rows (docs/protocol/v1/subagents.mdx). The client side of
// src/acp/subagents.ts: what Keel keeps of a child from the agent's `subagent_update`s, and how the child's state
// reads as a row's status. Pure functions of what the agent said; src/acp/external.ts applies them.
import type { AgentStatus } from "../automation/agents.ts";

type Json = any;

// What Keel keeps of the words an agent sends about a child. An agent is another program: its fields reach the
// owner's list, the stored events and every state read, so each is cut to what a row or a note shows.
export const TITLE_MAX = 200;       // a label
export const DESCRIPTION_MAX = 4096; // the task's words on the parent's card
export const MESSAGE_MAX = 8192;     // one message between sessions
export const STATE_MAX = 64;         // a state's name
export const FAILURE_MAX = 1000;     // the error an agent gives for a child
const DIRS_MAX = 32;
// The text cut to `max` characters, never inside a surrogate pair, with a mark where it was cut.
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

// What the parent's updates have said of one child so far. Every field of a `subagent_update` but the child's
// id is a patch: left out keeps the value, null clears it, a value replaces it whole.
export type ChildState = {
  title?: string;
  description?: string;
  // `capabilities` as the agent last gave it: cancel is the only one defined. A child whose capabilities
  // were never sent permits nothing.
  cancel: boolean;
  state?: { state: string; stopReason?: string; error?: { code?: number; message?: string } };
  cwd?: string;
  dirs?: string[];
};

export function patchChild(prev: ChildState | undefined, u: Json): ChildState {
  const next: ChildState = { ...(prev ?? { cancel: false }) };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(u, k);
  const text = (k: "title" | "description") => {
    if (!has(k)) return;
    if (typeof u[k] === "string" && u[k]) next[k] = clip(u[k], k === "title" ? TITLE_MAX : DESCRIPTION_MAX);
    else delete next[k]; // null, or an empty label: the parent's label is gone
  };
  text("title");
  text("description");
  // Replaced as a whole, never merged: null and {} permit nothing, and so does a cancel left out or null.
  if (has("capabilities")) next.cancel = !!u.capabilities && typeof u.capabilities === "object" && !!u.capabilities.cancel && typeof u.capabilities.cancel === "object";
  if (has("state")) {
    if (u.state && typeof u.state === "object" && typeof u.state.state === "string") {
      const e = u.state.error;
      next.state = { state: clip(u.state.state, STATE_MAX), ...(typeof u.state.stopReason === "string" ? { stopReason: clip(u.state.stopReason, STATE_MAX) } : {}),
        ...(e && typeof e === "object" ? { error: { ...(typeof e.code === "number" ? { code: e.code } : {}), ...(typeof e.message === "string" ? { message: clip(e.message, FAILURE_MAX) } : {}) } } : {}) };
    }
    else delete next.state; // cleared: its activity is unconfirmed, not idle
  }
  if (has("cwd")) { if (typeof u.cwd === "string" && u.cwd) next.cwd = clip(u.cwd, 1024); else delete next.cwd; }
  if (has("additionalDirectories")) { if (Array.isArray(u.additionalDirectories)) next.dirs = u.additionalDirectories.filter((d: unknown) => typeof d === "string").slice(0, DIRS_MAX).map((d: string) => clip(d, 1024)); else delete next.dirs; }
  return next;
}

// A child's state as the row shows it. A row is "running" only when the agent said so: a state it never gave, or
// `unknown`, is no confirmed activity (the row waits, with the state kept in `state` for the page to say).
// Idle is not a verdict by itself: its stop reason decides.
export type Reading = { status: AgentStatus; state: string; end_reason?: string | null; failure?: string };
export function readState(s: ChildState["state"]): Reading {
  if (!s) return { status: "waiting", state: "unconfirmed" };
  switch (s.state) {
    case "running": return { status: "running", state: "running", end_reason: null };
    case "requires_action": return { status: "running", state: "requires_action", end_reason: null };
    case "unknown": return { status: "waiting", state: "unknown", end_reason: null };
    case "idle": break;
    // A state this version does not know is kept as it was said, and is no activity.
    default: return { status: "waiting", state: s.state, end_reason: null };
  }
  switch (s.stopReason) {
    case "cancelled": return { status: "stopped", state: "idle", end_reason: null };
    case "error": return { status: "failed", state: "idle", end_reason: "error", failure: s.error?.message || "the agent reported an error" };
    case "max_tokens": return { status: "incomplete", state: "idle", end_reason: "max_tokens" };
    case "refusal": return { status: "incomplete", state: "idle", end_reason: "refusal" };
    case "max_turn_requests": return { status: "incomplete", state: "idle", end_reason: "max_steps" };
    default: return { status: "completed", state: "idle", end_reason: null };
  }
}

// How a child's turn ends in its own transcript (the words of a turn_end).
export const turnReason = (r: Reading): string => (r.status === "stopped" ? "interrupted" : r.status === "failed" ? "error" : r.end_reason === "max_steps" ? "max_steps" : r.end_reason ?? "end_turn");

// A `session_message`'s words: its text blocks, joined; other blocks are named so the entry is not empty.
export function messageText(content: unknown): string {
  const blocks: Json[] = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  const name = (t: unknown) => clip(String(t), STATE_MAX);
  return clip(blocks.slice(0, 64).map((b) => (b?.type === "text" ? clip(String(b.text ?? ""), MESSAGE_MAX) : b?.type ? `[${name(b.type)}]` : "")).filter(Boolean).join("\n"), MESSAGE_MAX);
}
