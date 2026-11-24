// A failed tool result in one line. For a shell command that is the line it
// printed that names the cause, with how it ended: "Exit code 4" alone names
// no cause, and seven failures that read the same cannot be told apart. The
// cause is the last line shaped like an error (`error:`, `SomeError:`,
// `fatal:`, `panic`, FAILED), else the last line that names a place in a file
// (file:line:col), else the last line that says anything: a compiler's caret
// line, a runtime's version line, a test runner's tally or a tool's "a
// complete log is in" come after the cause and are not it. Any other result
// is its first line.
// Pure: read by the telemetry's examples and the turn receipt. What stores
// the line scrubs it as it scrubs any error text (src/admin/telemetry.ts).

const text = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (b?.type === "text" ? b.text : "")).join("\n") : "";
// What hooks add after a result (memory, reminders) is not the tool's output.
const own = (t: string) => t.replace(/<(memory|system-reminder)\b[\s\S]*?<\/\1>/g, "");
// One printable line: no escape sequences (colors, cursor moves), of a line redrawn with carriage returns
// its last frame, and no other control character.
const printable = (l: string) => l
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_]?/g, "")
  .replace(/\r+$/, "").replace(/^.*\r/, "").replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, "").trim();
const lines = (t: string) => own(t).split("\n").map(printable).filter(Boolean);
// Lines the shell tools write around the output: no cause is in them.
const NOISE = /^(Shell cwd was reset to .*|\[\.\.\. \d+ characters cut \.\.\.\]|\(empty\)|\(no output\))$/;
// How a shell result says the command ended: Claude's Bash leads with it, Gemini's ends with it.
const HEAD = /^(Exit code -?\d+|Killed by \w+|Command (was|did) .*)$/;
const TAIL = /^(Exit Code: .*|Signal: .*)$/;
// A line shaped like an error, and one that names a place in a file.
const ERROR = /\b\w*(?:error|Error|ERROR)(?:\s?[\[A-Z][\w\]]{0,12})?:|\b(?:fatal|FATAL|panic|PANIC)\b|\bFAILED\b|\bFAIL\b|^npm (?:error|ERR!) (?!A complete log|To see a list)\S/;
const PLACE = /[\w./-]+:\d+:\d+/;
// A frame of a stack names a place, not the cause.
const FRAME = /^at\s/;

// The exit code a shell result names, if it names one.
export function exitOf(content: unknown): number | undefined {
  const ls = lines(text(content));
  const m = ls[0]?.match(/^Exit code (-?\d+)$/) ?? (ls[0]?.startsWith("Command: ") ? ls.findLast((l) => /^Exit Code: -?\d+$/.test(l))?.match(/(-?\d+)$/) : null);
  return m ? Number(m[1]) : undefined;
}

// How a shell result ended and what its output said: `how` as the words after "(", `head` as the result's own
// first line, `body` the output's lines. `how` is undefined for a result that is not a shell failure.
function shell(content: unknown) {
  const ls = lines(text(content));
  const head = ls[0] ?? "";
  let how: string | undefined;
  let body: string[] = [];
  let lead = head;
  if (HEAD.test(head)) {
    how = head.charAt(0).toLowerCase() + head.slice(1);
    body = ls.slice(1);
  } else if (head.startsWith("Command: ") && ls.some((l) => /^Exit Code: /.test(l))) {
    const from = ls.findIndex((l) => l.startsWith("Output: "));
    const to = ls.findLastIndex((l) => /^Exit Code: /.test(l));
    how = `exit code ${ls[to]!.slice("Exit Code: ".length)}`;
    body = from >= 0 && to > from ? [ls[from]!.slice("Output: ".length).trim(), ...ls.slice(from + 1, to)] : [];
    lead = `Exit code ${ls[to]!.slice("Exit Code: ".length)}`;
  }
  const said = body.filter((l) => l && !NOISE.test(l) && !TAIL.test(l));
  const cause = said.findLast((l) => ERROR.test(l) && !FRAME.test(l)) ?? said.findLast((l) => PLACE.test(l) && !FRAME.test(l)) ?? said.at(-1);
  return { head, lead, how, cause };
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(n - 3, 0))}...` : s);

// `silent`: the command that failed prints nothing when it fails (shellMessage): no line of the output is the cause.
export function reasonLine(content: unknown, max = 140, silent = false): string {
  const { head, how, cause } = shell(content);
  if (how === undefined) return clip(head, max);
  return cause && !silent ? `${clip(cause, max - how.length - 3)} (${how})` : clip(head, max);
}

// A failed shell result as the message a failure is grouped and told by: how it ended, then the one line of the
// output that names the cause (the same line as reasonLine). The first lines of the output are not it: a command
// line is often several commands, and what the early ones printed (a source line, a commit subject) is not why the
// last one failed. `silent`: the command that failed prints nothing when it fails (a yes-or-no answer), so
// everything in the output is from before it and no line is the cause. A result that is not a shell failure is
// returned as it is.
export function shellMessage(content: unknown, silent = false, max = 200): string {
  const { lead, how, cause } = shell(content);
  const own = typeof content === "string" ? content : text(content);
  if (how === undefined) return own;
  return cause && !silent ? `${lead}\n${clip(cause, max)}` : lead;
}
