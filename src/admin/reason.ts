// A failed tool result in one line. For a shell command that is the last line
// it printed that says something (what it wrote before it gave up), with how
// it ended: "Exit code 4" alone names no cause, and seven failures that read
// the same cannot be told apart. Any other result is its first line.
// Pure: read by the telemetry's examples and the turn receipt.

const text = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (b?.type === "text" ? b.text : "")).join("\n") : "";
// What hooks add after a result (memory, reminders) is not the tool's output.
const own = (t: string) => t.replace(/<(memory|system-reminder)\b[\s\S]*?<\/\1>/g, "");
const lines = (t: string) => own(t).split("\n").map((l) => l.trim()).filter(Boolean);
// Lines the shell tools write around the output: no cause is in them.
const NOISE = /^(Shell cwd was reset to .*|\[\.\.\. \d+ characters cut \.\.\.\]|\(empty\)|\(no output\))$/;
// How a shell result says the command ended: Claude's Bash leads with it, Gemini's ends with it.
const HEAD = /^(Exit code -?\d+|Killed by \w+|Command (was|did) .*)$/;
const TAIL = /^(Exit Code: .*|Signal: .*)$/;

// The exit code a shell result names, if it names one.
export function exitOf(content: unknown): number | undefined {
  const ls = lines(text(content));
  const m = ls[0]?.match(/^Exit code (-?\d+)$/) ?? (ls[0]?.startsWith("Command: ") ? ls.findLast((l) => /^Exit Code: -?\d+$/.test(l))?.match(/(-?\d+)$/) : null);
  return m ? Number(m[1]) : undefined;
}

export function reasonLine(content: unknown, max = 140): string {
  const ls = lines(text(content));
  const head = ls[0] ?? "";
  let how: string | undefined;
  let body: string[] = [];
  if (HEAD.test(head)) {
    how = head.charAt(0).toLowerCase() + head.slice(1);
    body = ls.slice(1);
  } else if (head.startsWith("Command: ") && ls.some((l) => /^Exit Code: /.test(l))) {
    const from = ls.findIndex((l) => l.startsWith("Output: "));
    const to = ls.findLastIndex((l) => /^Exit Code: /.test(l));
    how = `exit code ${ls[to]!.slice("Exit Code: ".length)}`;
    body = from >= 0 && to > from ? [ls[from]!.slice("Output: ".length).trim(), ...ls.slice(from + 1, to)] : [];
  }
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(n - 3, 0))}...` : s);
  if (how === undefined) return clip(head, max);
  const last = body.filter((l) => l && !NOISE.test(l) && !TAIL.test(l)).at(-1);
  return last ? `${clip(last, max - how.length - 3)} (${how})` : clip(head, max);
}
