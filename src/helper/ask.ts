// A question for the helper from its row at the top of a phone (the app's
// push to talk, or the phone page's box): the owner's words, stored in the
// helper's conversation as any prompt of theirs is, marked `ask`. The turn it
// starts only reads: while the owner's newest words to the helper are an ask,
// a tool that can change something outside Keel is refused (`askRefusal`), so
// what the answer offers (open a session, answer what it waits on) is done by
// the owner's tap, through the routes and permissions the phone already has.
// The answer is read back from the conversation: the reply's words, and the
// sessions its tools read, named (`answerOf`). Pure, over the helper's branch.
import { ownerPrompt } from "../core/owner.ts";
import type { Session, StoredEvent } from "../core/types.ts";

// Where an ask came from: the app, or the page on a phone.
export const ASK_FROM = ["phone", "page"] as const;
export type AskFrom = (typeof ASK_FROM)[number];

// An ask's id as a route has it: a stored prompt's id, or `q:<row>` for one that waits in the queue
// (its colon may come percent-encoded).
export const askId = (raw: string) => { try { return decodeURIComponent(raw); } catch { return raw; } };

// What the turn's note tells the model (src/helper/helper.ts note()), the same bytes each time.
export const ASK_LINE =
  "<ask>\nThe owner asked this from the helper row on their phone and reads the answer there as text. Answer from what you read: their sessions (helper__sessions, helper__session_read), what happened (helper__activity), your memory, mail and calendar. This turn only reads: nothing that changes something runs (no message to a session, no mail sent or labeled). When a step would help, say it in one line; the row offers the owner to open each session you read, or answer what it waits on, with a tap. Be short: the first line is the answer.\n</ask>";

// The refusal a changing tool gets in an ask's turn.
export const ASK_REFUSAL = "Refused: the owner asked this from the helper row on their phone, and that answer only reads. Say the step in one line instead; the owner opens the session or answers it with a tap.";

const askOf = (e: StoredEvent | undefined): AskFrom | undefined => {
  const a = e?.data?.ask;
  return typeof a === "string" && (ASK_FROM as readonly string[]).includes(a) ? (a as AskFrom) : undefined;
};

// The owner's newest words to the helper on this branch (their prompt, typed, steered or asked).
// A wake, a digest or another input of the harness is not theirs and leaves the answer as it was.
export function newestOwnWords(line: readonly StoredEvent[]): StoredEvent | undefined {
  for (let i = line.length - 1; i >= 0; i--) {
    const e = line[i]!;
    if (e.kind === "user" && ownerPrompt(e.data)) return e;
  }
  return undefined;
}

// Why a tool does not run in the helper's turn now: the owner's newest words are an ask and the tool
// can change something outside Keel. Undefined: it runs as it would.
export function askRefusal(line: readonly StoredEvent[], tool: { name: string; readOnly: boolean }): string | undefined {
  if (tool.readOnly) return undefined;
  return askOf(newestOwnWords(line)) ? ASK_REFUSAL : undefined;
}

// A session a tool named (an id, or a part of a title naming one), as the helper's tools find it.
export function namedSession(ref: unknown, sessions: readonly Session[]): Session | undefined {
  const r = String(ref ?? "").trim();
  if (!r) return undefined;
  const exact = sessions.find((s) => s.id === r);
  if (exact) return exact;
  const hits = sessions.filter((s) => !s.settings.helper && s.title.toLowerCase().includes(r.toLowerCase()));
  return hits.length === 1 ? hits[0] : undefined;
}

// What an answer looked at besides single sessions, by the tool's word.
const LOOKED: Record<string, string> = {
  helper__sessions: "sessions",
  helper__activity: "activity",
  mail__search: "mail",
  mail__read: "mail",
  calendar__events: "calendar",
  helper__memory_get: "memory",
  helper__memory_find: "memory",
};

export type AskState = "waiting" | "working" | "done" | "failed" | "stopped";
export type Answer = {
  state: AskState;
  question: string;
  text: string;
  // The sessions its tools read, in the order first read.
  read: Session[];
  // The other things it looked at: sessions (the list), activity, mail, calendar, memory.
  looked: string[];
  ts: number;
};

// The answer to the ask `askId` on the helper's branch: the reply's last words up to the end of the
// turn the ask was in, and what its tools read. A turn a restart cut goes on: its end is not the answer's.
// `running`: the helper's turn runs now.
export function answerOf(line: readonly StoredEvent[], askId: string, sessions: readonly Session[], running: boolean): Answer | undefined {
  const at = line.findIndex((e) => e.id === askId);
  if (at < 0) return undefined;
  const ask = line[at]!;
  const read: Session[] = [];
  const looked: string[] = [];
  let text = "";
  let end: StoredEvent | undefined;
  for (const e of line.slice(at + 1)) {
    if (e.kind === "turn_end") {
      if (e.data?.reason === "restart") continue;
      end = e;
      break;
    }
    if (e.kind !== "assistant") continue;
    const words = (e.data?.blocks ?? []).filter((b: any) => b?.type === "text").map((b: any) => String(b.text)).join("\n").trim();
    if (words) text = words;
    for (const b of e.data?.blocks ?? []) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "helper__session_read") {
        const s = namedSession(b.input?.session, sessions);
        if (s && !s.settings.helper && !read.some((x) => x.id === s.id)) read.push(s);
      } else if (LOOKED[b.name] && !looked.includes(LOOKED[b.name]!)) looked.push(LOOKED[b.name]!);
    }
  }
  const state: AskState = end ? (end.data?.reason === "error" ? "failed" : end.data?.reason === "interrupted" ? "stopped" : "done") : running ? "working" : "waiting";
  return { state, question: String(ask.data?.text ?? ""), text, read, looked, ts: end?.ts ?? ask.ts };
}
