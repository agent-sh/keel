// An approval as every client is given it, and the rule every answer is held
// to. One function builds the form (`cardForm`): the page, the phone API, a
// page on another machine, an editor over ACP and the command line read the
// same text, the same marks and the same hold. The gate refuses an allow that
// does not say the text was shown (`refusal`), so the read-first rule is the
// daemon's and not one client's. No imports but the two files the page loads
// too: the page reads this one as well.
import type { Approval } from "./gate.ts";
import { marked, marksOf, marksSaid, plainAscii, spelled, type Marks } from "./chars.ts";
import { RULE_WORDS } from "./risk-words.ts";
import { partSpan, shownInPart } from "./summary.ts";

// The most of a text a form carries. The gate keeps this much of an input
// (its `clip`), and the page shows this much: a longer one says that only its
// start is here.
export const TEXT_MAX = 20_000;
// One line a home row or a list can show whole: this many printable ASCII
// characters and no line break. Anything longer is opened.
export const SHORT_MAX = 160;
// What a collapsed notification shows of its content text before it is cut:
// Android's guide gives 40 characters as the limit for content text, and one
// line at the system's default size holds about that. A notification carries
// Allow only for a request whose whole line (the tool's name and the text) is
// within it. Wide gaps are refused too: a run of spaces pushes a tail out of
// sight on a line that wraps or scrolls.
export const NOTE_MAX = 40;

// Whether a text is that one line: nothing in it can hide, wrap out of view,
// draw as something else or change the order of what is shown.
export const oneLine = (text: string): boolean => text.length <= SHORT_MAX && plainAscii(text);

// Why an allow of a card needs the text to have been shown whole first:
// - "long": a second line, over 160 characters, or a tab (a gap of any width);
// - "cut": the form carries only the start of it;
// - "marked": hidden characters, letters written right to left, look-alikes,
//   any character outside plain ASCII;
// - "risk": high risk, a call only the owner answers, a refused call;
// - "where": it does not run where a line would let one assume: on another
//   machine, in a folder that is not the session's, with a shell that is not
//   the default one.
export type Hold = "long" | "cut" | "marked" | "risk" | "where";

// Where a call runs. `far`: on another machine than the daemon that asks.
// `cwd`: the folder a command starts in, when that is not the session's own
// folder (or, for another machine, the folder its call names). `sub`: the
// same folder as a path under the session's, when it is one. `away`: it is
// not under the session's folder. `shell`: the program that
// reads the command, when it is not the default shell.
export type Where = { name: string; cwd?: string; sub?: string; shell?: string; far: boolean; away?: true };

export type CardForm = {
  id: string; session_id: string; call_id: string; tool: string; kind: Approval["kind"]; state: Approval["state"];
  text: string;        // all there is to judge: the command, the paths and what the edit writes, the tool's input
  cut?: true;          // `text` is only the start of it
  kept?: true;         // and the rest was not kept anywhere (else the daemon holds it, and the page shows it)
  total?: number;      // how long the whole is, when that is known
  chars: number; lines: number;
  risk: "high" | "low";
  marks: Marks;        // read from `text` once, for every client
  machine?: Where;     // where it runs
  reason?: string;     // why it is asked, and why only once is offered
  rule?: string;       // the class of the policy's rule that asked, when it gave one
  at?: [number, number]; // a chained command: where in `text` the part that asked stands, [from, to)
  hold: Hold[];        // empty: one line shows all of it
  line: string;        // what a notification says of it: the tool, where it runs when not the session's own folder, the start of the text
  glance: boolean;     // that line shows all of it within a collapsed notification: only then may one carry Allow once
  grants: string[];    // the rules a standing answer would store ("echo *"): a client names them on that answer
  choices: ("once" | "session" | "always" | "deny")[];
};

// What an edit writes, as lines under its paths. From the input the gate kept:
// a whole file or a notebook cell as it is, a replacement as what goes and what
// comes, a patch as written. Null when the input names no content this reads.
function editText(input: unknown): string | null {
  if (typeof input === "string") return input || null;
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const whole = typeof i.content === "string" ? i.content : typeof i.new_source === "string" ? i.new_source : null;
  if (whole !== null) return whole || "(an empty file)";
  if (typeof i.old_string === "string" && typeof i.new_string === "string") {
    const side = (text: string, sign: string) => (text ? text.replace(/\n$/, "").split("\n").map((l) => `${sign} ${l}`) : []);
    return [...(i.replace_all ? ["every occurrence:"] : []), ...side(i.old_string, "-"), ...side(i.new_string, "+")].join("\n");
  }
  const patch = typeof i.patch === "string" ? i.patch : typeof i.input === "string" ? i.input : null;
  return patch || null;
}

// The whole of what a card asks for, before any bound. `kept`: only the start
// of the input was kept, so the text ends where the gate cut it.
function wholeText(a: Approval): { text: string; kept?: true } {
  const clipped = a.input && typeof a.input === "object" && typeof a.input._clipped === "string" ? (a.input._clipped as string) : null;
  if (a.kind === "edit") {
    if (clipped !== null) return { text: `${a.summary}\n${clipped}`, kept: true };
    const body = editText(a.input);
    // An edit whose content this cannot read is shown as the input it was sent with.
    return { text: `${a.summary}\n${body ?? JSON.stringify(a.input ?? {}, null, 2)}` };
  }
  // A command, a message to a session, a card with a text of its own: the summary is the whole.
  if (!shownInPart(a)) return { text: a.summary };
  if (clipped !== null) return { text: clipped, kept: true };
  return { text: JSON.stringify(a.input ?? {}, null, 2) };
}

const lineCount = (text: string) => text.replace(/\n$/, "").split("\n").length;

// `here`: where the session's tools run, as the daemon knows it (its own name,
// or the fleet machine the session works on).
export function cardForm(a: Approval, here?: { name: string; far?: boolean }): CardForm {
  const w = wholeText(a);
  const over = w.text.length > TEXT_MAX;
  const text = over ? w.text.slice(0, TEXT_MAX) : w.text;
  const cut = over || !!w.kept;
  const marks = marksOf(text);
  // A command sent to another machine of the fleet names it in its input: the same text is another act there.
  const named = a.kind === "shell" && a.input && typeof a.input === "object" && typeof a.input.machine === "string" && a.input.machine
    ? { name: spelled(a.input.machine, ""), ...(typeof a.input.cwd === "string" && a.input.cwd ? { cwd: spelled(a.input.cwd, "") } : {}), far: true } : undefined;
  // Where the gate found the command to start, and what reads it (kept with the card when it opened).
  const at = a.at ? { ...(a.at.cwd ? { cwd: spelled(a.at.cwd, "") } : {}), ...(a.at.sub ? { sub: spelled(a.at.sub, "") } : {}), ...(a.at.shell ? { shell: spelled(a.at.shell, "") } : {}), ...(a.at.away ? { away: true as const } : {}) } : {};
  const machine: Where | undefined = named ?? (here || a.at ? { name: here?.name ?? "", far: !!here?.far, ...at } : undefined);
  const reason = [a.risk === "high" ? `High risk${a.why ? `: ${a.why}` : ""}` : a.why, a.notice].filter(Boolean).map((s) => String(s).replace(/[.\s]+$/, "")).join(". ");
  const hold: Hold[] = [];
  const lines = lineCount(text);
  if (lines > 1 || text.length > SHORT_MAX || text.includes("\t")) hold.push("long");
  if (cut) hold.push("cut");
  // (A tool's name is another server's word too: one that is not plain ASCII can hide, reorder or pass for another.)
  if (marked(marks) || !plainAscii(text.replace(/[\n\t]/g, "")) || !plainAscii(a.tool)) hold.push("marked");
  if (a.risk !== "low" || a.once || a.kind === "refused") hold.push("risk");
  if (machine?.far || machine?.away || machine?.shell) hold.push("where");
  const standing = a.risk === "low" && !a.once && a.suggest.length > 0;
  // The notification's line: where it runs is said before the text, so a cut
  // never hides it. A folder under the session's is named by its path from
  // there, and counts in what the line may hold. The tool's name is spelled as
  // the text is: an MCP server names its own tools.
  const place = machine?.far ? ` on ${machine.name}${machine.cwd ? ` in ${machine.cwd}` : ""}` : machine?.cwd ? ` in ${machine.away ? machine.cwd : machine.sub ?? machine.cwd}` : "";
  // A chained command asked by one of its parts: the notification starts with that part (the rest of the line is
  // not on it, so it carries no Allow once).
  const span = partSpan(text, a.part);
  const asked = span && (span[0] > 0 || span[1] < text.length) ? span : undefined;
  const line = `${spelled(a.tool, "")}${place}: ${asked ? `${spelled(text.slice(asked[0], asked[1]))} (part of a longer command)` : spelled(a.summary)}`.slice(0, 500);
  return {
    id: a.id, session_id: a.session_id, call_id: a.call_id, tool: a.tool, kind: a.kind, state: a.state,
    text, ...(cut ? { cut: true as const } : {}), ...(w.kept ? { kept: true as const } : {}),
    // (An input the gate cut says how long it was; a text the form cut is counted here.)
    ...(w.kept ? (typeof a.input_len === "number" ? { total: a.input_len } : {}) : over ? { total: w.text.length } : {}),
    chars: text.length, lines,
    ...(asked ? { at: asked } : {}),
    risk: a.risk, marks, ...(machine ? { machine } : {}), ...(reason ? { reason: `${reason}.` } : {}), ...(a.rule ? { rule: a.rule } : {}),
    // Every character of the line is one column of a notification: plain ASCII, the tool's name included.
    hold, line, glance: !asked && hold.length === 0 && a.risk === "low" && !GRAVE.test(a.rule ?? "") && line.length <= NOTE_MAX && plainAscii(line) && !/ {2}/.test(line),
    grants: standing ? a.suggest.map((r) => r.pattern) : [],
    choices: ["once", ...(standing ? (["session", "always"] as const) : []), "deny"],
  };
}

// The policy's classes of rule that a notification never allows, whatever the
// risk it rates them: what destroys, reaches another host or machine, exposes
// something, or hides what it does. Read from the class word the policy gives
// with its ask (`Ask.rule`), so a class the policy adds is held here with it.
// (The ask's rule is the class in the policy's few words, "sends credentials out", or an older rule's own:
// both are read, the class by its words.)
const GRAVE = { test: (rule: string) => /\b(destroys|remote|exposes|hidden|machine)\b/.test(rule) || Object.values(RULE_WORDS).some((w) => rule.startsWith(w)) };

// The first thing in a text that is not plain: a hidden character by its code point, a look-alike by itself and its code.
function firstMark(f: CardForm): string {
  for (const ch of plainAscii(f.text.replace(/[\n\t]/g, "")) ? f.tool : f.text) {
    if (ch === "\n" || ch === "\t" || plainAscii(ch)) continue;
    const s = spelled(ch, "");
    return s !== ch ? s.slice(1, -1) : `${ch} U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return "";
}

// The sentence a client shows when an allow is refused for a card it did not show whole.
export const HOLD_SAYS = "Open the request to read it first";
const WHY: Record<Hold, (f: CardForm) => string> = {
  long: (f) => (f.lines > 1 ? `it is ${f.lines} lines long` : f.chars > SHORT_MAX ? `it is ${f.chars} characters on one line` : "it holds a tab"),
  cut: (f) => (f.kept ? "only its start is kept" : `only its start is shown here${f.total ? ` (${f.chars} of ${f.total} characters)` : ""}`),
  marked: (f) => `it holds characters that can mislead${firstMark(f) ? ` (${firstMark(f)})` : ""}`,
  risk: () => "it is high risk",
  where: (f) => (f.machine?.far ? `it runs on ${f.machine.name}` : f.machine?.away ? `it runs in ${f.machine.cwd}, not the session's folder` : `it runs with ${f.machine?.shell}, not the default shell`),
};
export const holdSaid = (f: CardForm): string => (f.hold.length ? `${HOLD_SAYS}: ${f.hold.map((h) => WHY[h](f)).join(", ")}.` : "");

// The rule. A deny is taken from anywhere at once. An allow of a card that one
// line does not show whole is taken only with the client's word that it showed
// all of the text (`seen: "whole"`): otherwise the sentence to show, and the
// card stays open. A notification shows a line and no more: its action allows
// once, and only a request whose whole line fits a collapsed notification
// (`glance`), whatever it says it showed. A standing answer is not its to give.
export function refusal(f: CardForm, choice: string, seen: unknown, client?: Client): string | null {
  if (choice === "deny") return null;
  if (client === "notification") {
    if (choice !== "once") return "A notification allows once or denies. Open the request to give a standing answer.";
    return f.glance ? null : holdSaid(f) || `${HOLD_SAYS}: a notification shows only its start.`;
  }
  if (!f.hold.length || seen === "whole") return null;
  return holdSaid(f);
}

// Who answered, kept with the answer. No address and no key: a kind, and a name the owner gave.
// - "page": the workbench in a browser; "phone": the phone app's card;
//   "notification": an action of a notification; "cli": keel approve, keel attach;
//   "script": a program over a run's stream; "acp": an editor; "api": a caller that named none.
// - `device`: the paired phone's name. `peer`: the linked machine the answer came through.
// - `seen`: the client said the whole text was shown (a script and an editor were handed it).
// - `grant`: the card was not answered itself: a standing answer this client gave on another card covers it.
// - "helper": the owner's helper, on his standing instruction (src/safety/delegate.ts). No route takes it from a
//   client: only the helper's own tool answers as it, and the gate checks the card's class first.
export const CLIENTS = ["page", "phone", "notification", "cli", "script", "acp", "api"] as const;
export type Client = (typeof CLIENTS)[number] | "helper";
// What the helper's answer is kept with: its conversation and the call that answered (who), the instruction it
// answered on and where the owner gave it, and the reason it gave.
export type HelperAnswer = { session: string; call?: string; instruction: string; source: string; reason?: string };
export type AnsweredBy = { client: Client; device?: string; peer?: string; seen?: "whole"; grant?: true; helper?: HelperAnswer };
// How the helper's answers are said, on the card, in the timeline and in the audit chain.
export const HELPER_SAID = "the Helper, on the owner's standing instruction";

const FROM: Record<Client, string> = {
  page: "the page", phone: "the phone", notification: "a notification", cli: "the command line", script: "a script", acp: "an editor", api: "the API",
  helper: HELPER_SAID,
};
// Where an answer was given, in words: "the phone (Pixel)", "the page on studio",
// and how: "the page, its text shown whole", "a script, its text given whole" (a
// program and an editor are handed the text; what they showed is not known),
// "the phone (Pixel), by its rule for another request" for a card another card's standing answer settled.
// The place alone: "the phone (Pixel)", "the page on studio".
export const whereSaid = (by: AnsweredBy): string =>
  `${FROM[by.client] ?? "the API"}${by.device ? ` (${spelled(by.device, "").slice(0, 60)})` : ""}${by.peer ? ` on ${spelled(by.peer, "").slice(0, 60)}` : ""}`;
// How long ago, in the largest unit that fits: "3 s ago", "4 min ago", "2 h ago".
export const agoSaid = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};

// What became of a request, in words a list can show: "allowed once from the page", "denied from
// the phone (Pixel)", "allowed by your rule for another request", "closed with no answer" (its turn
// was stopped). Undefined while it waits.
const CHOICE_SAID: Record<string, string> = { once: "allowed once", session: "allowed for the session", always: "allowed always", deny: "denied" };
export function answerSaid(a: { state: string; choice?: string; by?: AnsweredBy }): string | undefined {
  if (a.state === "pending") return undefined;
  if (a.state === "cancelled") return "closed with no answer";
  if (a.state === "allowed" && a.by?.grant) return `allowed by your rule for another request, from ${whereSaid(a.by)}`;
  if (a.by?.client === "helper") return `${a.state === "denied" ? "denied" : "allowed once"} by ${HELPER_SAID}`;
  const said = CHOICE_SAID[a.choice ?? ""] ?? (a.state === "denied" ? "denied" : "allowed");
  return a.by ? `${said} from ${whereSaid(a.by)}` : said;
}

export function fromSaid(by: AnsweredBy | undefined): string {
  if (!by) return "";
  if (by.client === "helper") return `${HELPER_SAID}${by.helper?.reason ? ` (its reason: ${spelled(by.helper.reason, "").slice(0, 200)})` : ""}`;
  const handed = by.client === "script" || by.client === "acp";
  const where = whereSaid(by);
  return by.grant ? `${where}, by its rule for another request` : `${where}${by.seen === "whole" ? `, its text ${handed ? "given" : "shown"} whole` : ""}`;
}

// A card as lines for a place that draws plain text (a terminal, an editor's
// request): what it is, where it runs, why it is asked, then the text with
// every hidden character written out, and what the text holds that misleads.
export function cardLines(f: CardForm): { head: string; notes: string[]; text: string; at?: [number, number] } {
  const thing = f.kind === "shell" ? "command" : "text";
  const m = f.machine;
  const notes = [
    ...(f.reason ? [f.reason] : []),
    ...(m?.far ? [`Runs on ${m.name}${m.cwd ? `, in ${m.cwd}` : ""}.`] : m?.cwd ? [m.away ? `Runs in ${m.cwd}, which is not the session's folder.` : `Runs in ${m.cwd}.`] : []),
    ...(m?.shell ? [`Runs with ${m.shell}, not the default shell.`] : []),
    ...marksSaid(f.marks, thing),
    ...(plainAscii(f.tool) ? [] : [`The tool's name is not plain ASCII: ${spelled(f.tool, "")}.`]),
    ...(!f.cut ? [] : f.kept ? [f.total ? `Only its start is kept: ${f.chars} of ${f.total} characters.` : "Only its start is kept: the rest is not shown anywhere."]
      : [`Only its start is shown here: ${f.chars} of ${f.total ?? "more"} characters. The page shows all of it.`]),
  ];
  const size = f.lines > 1 ? `${f.lines} lines` : f.chars > SHORT_MAX ? `${f.chars} characters` : "";
  return { head: `${spelled(f.tool, "")}${f.risk === "high" ? ", high risk" : ""}${size ? `, ${size}` : ""}`, notes, text: spelled(f.text), ...(f.at ? { at: [spelled(f.text.slice(0, f.at[0])).length, spelled(f.text.slice(0, f.at[1])).length] as [number, number] } : {}) };
}
