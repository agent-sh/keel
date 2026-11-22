// An approval as every client is given it, and the rule every answer is held
// to. One function builds the form (`cardForm`): the page, the phone API, a
// page on another machine, an editor over ACP and the command line read the
// same text, the same marks and the same hold. The gate refuses an allow that
// does not say the text was shown (`refusal`), so the read-first rule is the
// daemon's and not one client's. No imports but the two files the page loads
// too: the page reads this one as well.
import type { Approval } from "./gate.ts";
import { marked, marksOf, marksSaid, plainAscii, spelled, type Marks } from "./chars.ts";
import { shownInPart } from "./summary.ts";

// The most of a text a form carries. The gate keeps this much of an input
// (its `clip`), and the page shows this much: a longer one says that only its
// start exists.
export const TEXT_MAX = 20_000;
// One line a notification, a home row or a list can show whole: this many
// printable ASCII characters and no line break. Anything longer is opened.
export const SHORT_MAX = 160;

// Whether a text is that one line: nothing in it can hide, wrap out of view,
// draw as something else or change the order of what is shown.
export const oneLine = (text: string): boolean => text.length <= SHORT_MAX && plainAscii(text);

// Why an allow of a card needs the text to have been shown whole first:
// - "long": more than the one line above (a second line, a tab, over 160 characters);
// - "cut": the daemon holds only the start of it;
// - "marked": hidden characters, letters written right to left, or look-alikes;
// - "risk": high risk, a call only the owner answers, a refused call.
export type Hold = "long" | "cut" | "marked" | "risk";

export type Where = { name: string; cwd?: string; far: boolean };

export type CardForm = {
  id: string; session_id: string; call_id: string; tool: string; kind: Approval["kind"]; state: Approval["state"];
  text: string;        // all there is to judge: the command, the paths and what the edit writes, the tool's input
  cut?: true;          // `text` is only the start of it
  total?: number;      // how long the whole is, when that is known
  chars: number; lines: number;
  risk: "high" | "low";
  marks: Marks;        // read from `text` once, for every client
  machine?: Where;     // where it runs: `far` when that is not the daemon that asks
  reason?: string;     // why it is asked, and why only once is offered
  hold: Hold[];        // empty: one line shows all of it, and a notification may carry Allow
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
  const machine: Where | undefined = named ?? (here ? { name: here.name, far: !!here.far } : undefined);
  const reason = [a.risk === "high" ? `High risk${a.why ? `: ${a.why}` : ""}` : a.why, a.notice].filter(Boolean).map((s) => String(s).replace(/[.\s]+$/, "")).join(". ");
  const hold: Hold[] = [];
  if (!oneLine(text)) hold.push("long");
  if (cut) hold.push("cut");
  if (marked(marks)) hold.push("marked");
  if (a.risk !== "low" || a.once || a.kind === "refused") hold.push("risk");
  const standing = a.risk === "low" && !a.once && a.suggest.length > 0;
  return {
    id: a.id, session_id: a.session_id, call_id: a.call_id, tool: a.tool, kind: a.kind, state: a.state,
    text, ...(cut ? { cut: true as const } : {}), ...(over ? { total: w.text.length } : w.kept && typeof a.input_len === "number" ? { total: a.input_len } : {}),
    chars: text.length, lines: lineCount(text),
    risk: a.risk, marks, ...(machine ? { machine } : {}), ...(reason ? { reason: `${reason}.` } : {}),
    hold, choices: ["once", ...(standing ? (["session", "always"] as const) : []), "deny"],
  };
}

// The sentence a client shows when an allow is refused for a card it did not show whole.
export const HOLD_SAYS = "Open the request to read it first";
const WHY: Record<Hold, (f: CardForm) => string> = {
  long: (f) => (f.lines > 1 ? `it is ${f.lines} lines long` : `it is ${f.chars} characters on one line`),
  cut: () => "only its start is kept",
  marked: () => "it holds characters that can mislead",
  risk: () => "it is high risk",
};
export const holdSaid = (f: CardForm): string => (f.hold.length ? `${HOLD_SAYS}: ${f.hold.map((h) => WHY[h](f)).join(", ")}.` : "");

// The rule. A deny is taken from anywhere at once. An allow of a card that one
// line does not show whole is taken only with the client's word that it showed
// all of the text (`seen: "whole"`): otherwise the sentence to show, and the card stays open.
export function refusal(f: CardForm, choice: string, seen: unknown): string | null {
  if (choice === "deny" || !f.hold.length || seen === "whole") return null;
  return holdSaid(f);
}

// Who answered, kept with the answer. No address and no key: a kind, and a name the owner gave.
// - "page": the workbench in a browser; "phone": the phone app's card;
//   "notification": an action of a notification; "cli": keel approve, keel attach;
//   "script": a program over a run's stream; "acp": an editor; "api": a caller that named none.
// - `device`: the paired phone's name. `peer`: the linked machine the answer came through.
export const CLIENTS = ["page", "phone", "notification", "cli", "script", "acp", "api"] as const;
export type Client = (typeof CLIENTS)[number];
export type AnsweredBy = { client: Client; device?: string; peer?: string; seen?: "whole" };

const FROM: Record<Client, string> = {
  page: "the page", phone: "the phone", notification: "a notification", cli: "the command line", script: "a script", acp: "an editor", api: "the API",
};
// Where an answer was given, in words: "the phone (Pixel)", "the page on studio",
// and whether the client said it showed the whole text: "the page, its text shown whole".
export function fromSaid(by: AnsweredBy | undefined): string {
  if (!by) return "";
  return `${FROM[by.client] ?? "the API"}${by.device ? ` (${spelled(by.device, "").slice(0, 60)})` : ""}${by.peer ? ` on ${spelled(by.peer, "").slice(0, 60)}` : ""}${by.seen === "whole" ? ", its text shown whole" : ""}`;
}

// A card as lines for a place that draws plain text (a terminal, an editor's
// request): what it is, where it runs, why it is asked, then the text with
// every hidden character written out, and what the text holds that misleads.
export function cardLines(f: CardForm): { head: string; notes: string[]; text: string } {
  const thing = f.kind === "shell" ? "command" : "text";
  const notes = [
    ...(f.reason ? [f.reason] : []),
    ...(f.machine?.far ? [`Runs on ${f.machine.name}${f.machine.cwd ? `, in ${f.machine.cwd}` : ""}.`] : []),
    ...marksSaid(f.marks, thing),
    ...(f.cut ? [f.total ? `Only its start is kept: ${f.chars} of ${f.total} characters.` : "Only its start is kept: the rest is not shown anywhere."] : []),
  ];
  const size = f.lines > 1 ? `${f.lines} lines` : f.chars > SHORT_MAX ? `${f.chars} characters` : "";
  return { head: `${f.tool}${f.risk === "high" ? ", high risk" : ""}${size ? `, ${size}` : ""}`, notes, text: spelled(f.text) };
}
