// What the home screen says of the sessions: the headline's counts and the
// rows under it, from the state the daemon serves of each session
// (src/core/watch.ts) and whether the owner has looked at a failure since it
// happened.
import { askThing, whyText, type SessionState, type Watch } from "../../../src/core/watch.ts";
import { backgroundWord, countWord, inBackground, stateLabel, stateWords, waitsOnOwner } from "../../../src/core/state-words.ts";
import { plainAscii } from "./hidden-chars.ts";

export type Row = { id: string; w: Watch };
// The headline's parts. `wait` is every session that goes on by itself: one
// that waits on something it set up, and one a restart cut that Keel resumes.
// `kind`: the part's own name (a part of sessions that only keep a command going in the background has the mark of work). `text`: how it reads.
export type Part = { w: "need" | "fail" | "declined" | "work" | "wait" | "stop"; kind: Part["w"] | "background"; ids: string[]; n: number; text: string };

// How a count reads in the headline: the vocabulary's count words (src/core/state-words.ts).
export const say = (w: Part["w"], n: number) => countWord(w, n);

// `list` is in order of attention.
// - What needs the owner is counted by the things that wait, as the tab's
//   title counts them: a session with three requests is three.
// - A failed or declined session counts until the owner has looked at it
//   (`unseen`): after that it is a failed session in the list, not news.
// - A stopped session counts when it stopped by itself or holds prompts for
//   the owner (the daemon says why); one the owner stopped is at rest.
// The headline never says nothing needs them while a row does.
type Told = { id: string; st: SessionState };
export function watchSummary(list: Told[], unseen: ReadonlySet<string>): { head: Part[]; attention: Row[]; working: Row[] } {
  const of = (...w: Watch[]) => list.filter((r) => w.includes(r.st.watch));
  const by = new Map(list.map((r) => [r.id, r.st]));
  const news = (w: Watch) => of(w).filter((r) => unseen.has(r.id));
  const stopped = of("stop").filter((r) => !!r.st.why);
  const groups: [Part["w"], Told[]][] = [["need", of("need")], ["fail", news("fail")], ["declined", news("declined")], ["work", of("work")], ["wait", of("wait", "resume")], ["stop", stopped]];
  const rows = (g: Told[]): Row[] => g.map((r) => ({ id: r.id, w: r.st.watch }));
  return {
    head: groups.filter(([, g]) => g.length).map(([w, g]) => ({ w, kind: w, ids: g.map((r) => r.id), n: w === "need" ? waitsOnOwner(g.map((r) => r.st)) : g.length, text: "" }))
      // A session that only keeps a command going in the background is counted apart from the ones a turn or an agent works in.
      .flatMap((p): Part[] => {
        if (p.w !== "work") return [p];
        const bg = p.ids.filter((id) => inBackground(by.get(id)));
        const rest = p.ids.filter((id) => !bg.includes(id));
        return [...(rest.length ? [{ ...p, ids: rest, n: rest.length }] : []), ...(bg.length ? [{ ...p, kind: "background" as const, ids: bg, n: bg.length }] : [])];
      })
      .map((p) => ({ ...p, text: p.kind === "background" ? backgroundWord(p.n) : say(p.w, p.n) })),
    attention: rows([...of("need"), ...news("fail"), ...news("declined"), ...stopped]),
    working: rows([...of("work"), ...of("wait", "resume")]),
  };
}

// The rows the screen has room for, in the order of attention. A state the
// headline counts is never pushed off the screen by the ones before it: each
// state present keeps its first row. `more` is what did not fit, by state, so
// the line under the rows says what the headline says.
type More = { w: Part["w"]; ids: string[] };
export function pickRows(rows: Row[], most: number): { shown: Row[]; more: More[] } {
  if (rows.length <= most) return { shown: rows, more: [] };
  const keep = new Set<string>();
  for (const r of rows) if (keep.size < most && !rows.some((x) => keep.has(x.id) && x.w === r.w)) keep.add(r.id);
  for (const r of rows) if (keep.size < most) keep.add(r.id);
  const hidden = rows.filter((r) => !keep.has(r.id));
  const order: Part["w"][] = ["need", "fail", "declined", "stop", "work", "wait"];
  const part = (w: Watch) => (w === "resume" ? "wait" : w);
  return {
    shown: rows.filter((r) => keep.has(r.id)),
    more: order.map((w) => ({ w, ids: hidden.filter((r) => part(r.w) === w).map((r) => r.id) })).filter((p) => p.ids.length),
  };
}
// "3 more: 2 need you, 1 failed".
export const sayMore = (more: More[]) => `${more.reduce((n, p) => n + p.ids.length, 0)} more: ${more.map((p) => say(p.w, p.ids.length)).join(", ")}`;

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
// (the headline, the mark and the list's own heading say the state). It comes
// from the daemon's reason (`why`). `card`: the kind of the approval card,
// where the page holds it (a command, an edit, another call). A request of one
// of the session's agents says whose it is; a failure says its class.
const ASKED: Record<string, string> = { question: "Question", plan: "Plan", secret: "Secret", resume: "Held after a restart", unsent: "Not sent", owner: "Your answer" };
const CARD: Record<string, string> = { shell: "Command", edit: "Edit" };
export function rowKind(st: Pick<SessionState, "watch" | "why" | "cls" | "child">, card?: string): string {
  if (st.watch === "need") {
    const what = st.why === "approval" ? (card ? CARD[card] ?? "Tool call" : "Approval") : ASKED[st.why ?? ""] ?? "Waits for you";
    return st.child ? `Agent's ${what.toLowerCase()}` : what;
  }
  if (st.watch === "fail") return stateWords(st).phrase;
  return st.watch === "done" || st.watch === "idle" ? "" : stateLabel({ watch: st.watch });
}

// A row's line: what the daemon says the state stands on, without the words the row's kind already says.
export const rowLine = (st: SessionState, now = Date.now()): string => askThing({ ...st, text: whyText(st, now) });

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
// (A turn the model declined is a failure under its own word: news the same way.)
export const isFailure = (w: Watch | undefined) => w === "fail" || w === "declined";
export const unseenFailures = (list: Failing[], w: Record<string, Watch>) => new Set(list.filter((s) => isFailure(w[s.id]) && failUnseen(s)).map((s) => s.id));
