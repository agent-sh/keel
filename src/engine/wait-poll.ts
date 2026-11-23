// A wait polled again inside the turn. A shell call that only waits (a
// waitfor, a bare sleep, a `--watch` command, an empty write_stdin poll)
// costs a model request each time it comes back, and that request reads the
// whole context again. When the step before was the same wait, the result
// says that the daemon's wait tool wakes the session when the condition holds
// and takes no steps meanwhile. A first wait is left alone, and so is a wait
// in front of real work (`waitfor --capacity ... && bun test`).

// The shell tools of each family, by the field that holds the command.
const SHELLS: Record<string, string> = { Bash: "command", run_shell_command: "command", exec_command: "cmd" };

// A command line split into its simple commands, outside quotes: `;`, `&&`,
// `||`, `|`, `&` and newlines end one. `op` is the separator before each.
function parts(command: string): { text: string; op: string }[] {
  const out: { text: string; op: string }[] = [];
  let cur = "", op = "", quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < command.length) { cur += c + command[++i]; continue; }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") { out.push({ text: cur, op }); cur = ""; op = two; i++; continue; }
    // `2>&1` and `>&2` are redirections, not a background `&`.
    if (c === "&" && /[<>]$/.test(cur)) { cur += c; continue; }
    if (c === ";" || c === "\n" || c === "|" || c === "&") { out.push({ text: cur, op }); cur = ""; op = c === "\n" ? ";" : c; continue; }
    cur += c;
  }
  out.push({ text: cur, op });
  return out.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text);
}

// The words of a simple command, without redirections, leading assignments and a `timeout N` in front.
function words(text: string): string[] {
  const w = text.split(/\s+/).filter((x) => x && !/^\d*[<>]/.test(x) && !/^&>/.test(x));
  while (w.length && /^[A-Za-z_]\w*=/.test(w[0]!)) w.shift();
  if (w[0] === "timeout") { w.shift(); while (w[0]?.startsWith("-")) w.shift(); w.shift(); }
  return w;
}

// What a simple command is to a poll: a wait, nothing (a `true`, an echo, a
// filter of the wait's output after a pipe), or work.
function kind(text: string, op: string): "wait" | "none" | "work" {
  const w = words(text);
  const cmd = w[0]?.replace(/^.*\//, "") ?? "";
  if (cmd === "sleep") return w.length === 2 && /^\d+(\.\d+)?[smh]?$/.test(w[1]!) ? "wait" : "work";
  // A capacity gate waits for the machine, which no wait tool watches: what follows it is the work.
  if (cmd === "waitfor") return w.includes("--capacity") ? "work" : "wait";
  if (w.includes("--watch") || (cmd === "gh" && w[1] === "run" && w[2] === "watch")) return "wait";
  if (cmd === "true" || cmd === ":" || cmd === "echo" || cmd === "date") return "none";
  if (op === "|" && ["tail", "head", "grep", "cat"].includes(cmd)) return "none";
  return "work";
}

// The wait a call is, as a key (the same key twice in a row is the same wait
// polled again), or null for a call that does more than wait.
export function waitKey(tool: string, input: unknown): string | null {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "write_stdin") return i.chars ? null : `write_stdin\0${String(i.session_id ?? "")}`;
  const field = SHELLS[tool];
  const command = field ? i[field] : undefined;
  if (typeof command !== "string" || !command.trim()) return null;
  const kinds = parts(command).map((p) => kind(p.text, p.op));
  if (kinds.includes("work") || !kinds.includes("wait")) return null;
  return `${tool}\0${command.trim().replace(/\s+/g, " ")}`;
}

// The line a result gets: when this call is the same wait as the step before
// it, and the session offers a wait tool (`waitTool`, as its family names it).
export function pollNote(prev: string | null | undefined, key: string | null, waitTool: string | undefined): string | null {
  if (!key || !prev || key !== prev || !waitTool) return null;
  return `[harness] This is the same wait as your last step, and each poll is a model request. ${waitTool} wakes you when the condition holds (a file, a log line, a process ending, a timer, pull request checks) and takes no steps meanwhile: call it and end your turn instead of polling.`;
}

// The last call of each session in this turn, as a wait key (null: it was not a wait).
const last = new Map<string, string | null>();
// After a call: the line for its result, if any. Every call is seen, so any
// other call between two waits breaks the run.
export function observeWait(sessionId: string, tool: string, input: unknown, waitTool: string | undefined): string | null {
  const key = waitKey(tool, input);
  const note = pollNote(last.get(sessionId), key, waitTool);
  last.set(sessionId, key);
  return note;
}
export const resetWait = (sessionId: string) => void last.delete(sessionId);
