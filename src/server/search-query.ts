// What a search is limited to besides its words, written in the query itself
// so one line in the palette or on the command line says it all:
//   in:commands        only shell commands a session ran (not their output, not what was said)
//   in:prompts | in:replies | in:output | in:summaries
//   since:1h | since:2d | since:yesterday | since:today | since:2026-11-20   (until: the same)
//   state:failed | state:done | state:working | state:needs-you | ...        the session's state now
// "git push in:commands since:yesterday" is every session that ran git push
// yesterday. A word with a colon that is none of these stays a search word.
// No imports, so the page can load this file for its hint.

export type SearchLimits = {
  words: string; // the query without its limits
  kinds?: string[]; // rows of the index: user, assistant, tool_use, tool_result, summary
  commands?: boolean; // tool_use rows of a shell tool only
  since?: number;
  until?: number;
  state?: string; // a session state (the daemon's name for it)
  said: string[]; // the limits in words, for the answer ("commands", "since Nov 21 00:00")
};

const IN: Record<string, { kinds: string[]; commands?: boolean; said: string }> = {
  commands: { kinds: ["tool_use"], commands: true, said: "commands" }, command: { kinds: ["tool_use"], commands: true, said: "commands" },
  prompts: { kinds: ["user"], said: "prompts" }, prompt: { kinds: ["user"], said: "prompts" },
  replies: { kinds: ["assistant"], said: "replies" }, reply: { kinds: ["assistant"], said: "replies" },
  output: { kinds: ["tool_result"], said: "tool output" }, tools: { kinds: ["tool_use", "tool_result"], said: "tool calls and their output" },
  summaries: { kinds: ["summary"], said: "summaries" }, summary: { kinds: ["summary"], said: "summaries" },
};
// The states a session can be in, by the daemon's names and the words the pages show for them.
export const STATE_WORDS: Record<string, string> = {
  need: "need", "needs-you": "need", work: "work", working: "work", wait: "wait", waiting: "wait", fail: "fail", failed: "fail", declined: "declined",
  resume: "resume", stop: "stop", stopped: "stop", done: "done", idle: "idle", "not-started": "idle",
};
// The shell tools of every tool family: what "a command" is in the index (a tool call's text starts with its tool's name).
export const SHELL_TOOLS = ["Bash", "exec_command", "run_shell_command", "shell", "shell_command", "local_shell", "keel__run_on"];

const two = (n: number) => String(n).padStart(2, "0");
const stamp = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const midnight = (now: number, daysBack = 0) => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - daysBack); return d.getTime(); };

// A time a limit names: a span back from now, a day by name or date (its local midnight), or an ISO time. Null: not a time.
// `end`: for until:, a day means the end of that day.
export function limitTime(v: string, now: number, end = false): number | null {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/i.exec(v);
  if (m) return now - Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2]!.toLowerCase() as "s" | "m" | "h" | "d" | "w"];
  if (v === "today") return midnight(now, end ? -1 : 0);
  if (v === "yesterday") return midnight(now, end ? 0 : 1);
  const day = /^(\d{4})-(\d\d)-(\d\d)$/.exec(v);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + (end ? 1 : 0)).getTime();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function searchLimits(q: string, now = Date.now()): SearchLimits {
  const out: SearchLimits = { words: "", said: [] };
  const words: string[] = [];
  let kind = "", state = "";
  for (const w of q.split(/\s+/).filter(Boolean)) {
    const m = /^(in|kind|since|until|state):(.+)$/i.exec(w);
    const key = m?.[1]!.toLowerCase(), val = m?.[2]!.toLowerCase();
    if (!m || !val) { words.push(w); continue; }
    if (key === "in" || key === "kind") {
      const k = IN[val];
      if (!k) { words.push(w); continue; }
      out.kinds = k.kinds;
      if (k.commands) out.commands = true; else delete out.commands;
      kind = k.said;
    } else if (key === "state") {
      const st = STATE_WORDS[val];
      if (!st) { words.push(w); continue; }
      out.state = st;
      state = val.replace(/-/g, " ");
    } else {
      const t = limitTime(m[2]!, now, key === "until");
      if (t === null) { words.push(w); continue; }
      // "since:yesterday" is that day: from its midnight to the next.
      if (key === "since") { out.since = t; if (val === "yesterday") out.until = midnight(now); }
      else out.until = t;
    }
  }
  // In a fixed order, each limit once (the last one of a kind written wins).
  if (kind) out.said.push(kind);
  if (state) out.said.push(`sessions now: ${state}`);
  if (out.since !== undefined && out.until !== undefined) out.said.push(`from ${stamp(out.since)} to ${stamp(out.until)}`);
  else if (out.since !== undefined) out.said.push(`since ${stamp(out.since)}`);
  else if (out.until !== undefined) out.said.push(`until ${stamp(out.until)}`);
  out.words = words.join(" ");
  return out;
}
