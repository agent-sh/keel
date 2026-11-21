// What the home screen says of the sessions: the headline's counts and the
// rows under it, from each session's state and whether the owner has looked
// at a failure since it happened.
import type { Watch } from "../../../src/core/watch.ts";
import { plainAscii } from "./hidden-chars.ts";

export type Row = { id: string; w: Watch };
export type Part = { w: "need" | "resume" | "fail" | "work"; ids: string[] };

// How a count reads in the headline.
export const say = (w: Part["w"], n: number) =>
  w === "need" ? `${n} ${n === 1 ? "needs" : "need"} you`
  : w === "resume" ? `${n} ${n === 1 ? "waits" : "wait"} to resume`
  : w === "fail" ? `${n} failed`
  : `${n} working`;

// `list` is in order of attention. A failed session counts until the owner
// has looked at it (`unseen` holds the ones with an unread failure): after
// that it is a failed session among the recent ones, not news. A turn a
// restart cut and held waits on the owner, so it is counted and listed too:
// the headline never says nothing needs them while a row does.
export function watchSummary(list: Row[], unseen: ReadonlySet<string>): { head: Part[]; attention: Row[]; working: Row[] } {
  const of = (w: Watch) => list.filter((r) => r.w === w);
  const failed = of("fail").filter((r) => unseen.has(r.id));
  const groups: [Part["w"], Row[]][] = [["need", of("need")], ["resume", of("resume")], ["fail", failed], ["work", of("work")]];
  return {
    head: groups.filter(([, rows]) => rows.length).map(([w, rows]) => ({ w, ids: rows.map((r) => r.id) })),
    attention: [...of("need"), ...of("resume"), ...failed],
    working: of("work"),
  };
}

// The rows the screen has room for, in the order of attention. A state the
// headline counts is never pushed off the screen by the ones before it: each
// state present keeps its first row. `more` is what did not fit, by state, so
// the line under the rows says what the headline says.
export function pickRows(rows: Row[], most: number): { shown: Row[]; more: Part[] } {
  if (rows.length <= most) return { shown: rows, more: [] };
  const keep = new Set<string>();
  for (const r of rows) if (keep.size < most && !rows.some((x) => keep.has(x.id) && x.w === r.w)) keep.add(r.id);
  for (const r of rows) if (keep.size < most) keep.add(r.id);
  const hidden = rows.filter((r) => !keep.has(r.id));
  const order: Part["w"][] = ["need", "resume", "fail", "work"];
  return {
    shown: rows.filter((r) => keep.has(r.id)),
    more: order.map((w) => ({ w, ids: hidden.filter((r) => r.w === w).map((r) => r.id) })).filter((p) => p.ids.length),
  };
}
// "3 more: 2 need you, 1 failed".
export const sayMore = (more: Part[]) => `${more.reduce((n, p) => n + p.ids.length, 0)} more: ${more.map((p) => say(p.w, p.ids.length)).join(", ")}`;

// ---- An approval answered from a home row.
// The rule the approval card is held to: an approval is given only for what
// the owner could read. A row offers "Allow once" only for a low-risk shell
// command it shows whole: one line, short enough to wrap in the row, the very
// text the gate will run (the summary of a shell call is its command), and
// made of printable ASCII only, so nothing in it can hide, draw as something
// else or reorder what is shown (a tab, a no-break space, a letter written
// right to left: a row has no place to mark them). Anything else (a long or
// many-line command, an edit, a tool call) is reviewed on its card.
export const WHOLE_MAX = 160;
export function wholeCommand(a: { kind: string; risk: string; summary: string; input?: unknown } | undefined): string | null {
  if (!a || a.risk !== "low" || a.kind !== "shell") return null;
  const input = a.input as { command?: unknown; cmd?: unknown } | undefined;
  const typed = typeof input?.command === "string" ? input.command : typeof input?.cmd === "string" ? input.cmd : null;
  if (typed === null || typed !== a.summary) return null;
  return !plainAscii(typed) || typed.length > WHOLE_MAX ? null : typed;
}

// What a row is, in a word: the kind of thing that waits, not the state again
// (the headline, the mark and the list's own heading say the state).
// `agent`: the request is one of the session's agents', answered on the session's page.
export function rowKind(w: Watch, o: { approval?: { kind: string }; agent?: boolean; asking?: boolean; plan?: boolean; secret?: boolean }): string {
  if (w === "fail") return "Failed";
  if (w === "resume") return "Held after a restart";
  if (w === "work") return "Working";
  const what = o.approval ? (o.approval.kind === "shell" ? "Command" : o.approval.kind === "edit" ? "Edit" : "Tool call") : "";
  if (what) return o.agent ? `Agent's ${what.toLowerCase()}` : what;
  return o.plan ? "Plan" : o.secret ? "Secret" : o.asking ? "Question" : "Not sent";
}

// A session counts as needing the owner when the page's watch says so, and also when it waits on
// something the watch does not read yet: a plan it presented, a secret it asked for, a request of
// one of its agents. (The watch calls those "working".)
export const needs = (w: Watch, o: { plan?: boolean; secret?: boolean; agent?: boolean }): Watch => (w === "work" && (o.plan || o.secret || o.agent) ? "need" : w);

// ---- Failures the owner has looked at.
// A failure is news until its session was shown on some device or its next
// turn started (which ends the failed state). Not until an alert was marked
// read: that is the inbox's own state. The daemon keeps which failure was
// looked at on the session (fail_seen_ms, src/server/routes/marks.ts), so the
// desk, the phone and a fresh browser agree.
type Failing = { id: string; settings: { failed_ms?: number | null; fail_seen_ms?: number | null } };
// The failure a session is in now: the time it failed. One known only from the session's events
// (the daemon made no mark of it) has a stamp of its own, which the session's activity does not move.
export const failStamp = (s: Pick<Failing, "settings">) => s.settings.failed_ms ?? -1;
export const failUnseen = (s: Pick<Failing, "settings">) => s.settings.fail_seen_ms !== failStamp(s);
export const unseenFailures = (list: Failing[], w: Record<string, Watch>) => new Set(list.filter((s) => w[s.id] === "fail" && failUnseen(s)).map((s) => s.id));
