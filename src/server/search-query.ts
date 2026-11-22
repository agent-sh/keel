// What a search is limited to besides its words, written in the query itself
// so one line in the palette or on the command line says it all:
//   in:commands        only shell commands a session ran (not their output, not what was said)
//   in:prompts | in:replies | in:output | in:summaries
//   since:1h | since:2d | since:yesterday | since:today | since:2026-11-20   from then on (it sets no end)
//   until:...                                                                up to then (a day: to its end)
//   on:yesterday | on:today | on:2026-11-20                                  that day alone
//   state:failed | state:done | state:working | state:needs-you | ...        the session's state now
// "git push in:commands on:yesterday" is every session that ran git push
// yesterday. The order of the limits does not matter. A word with a colon
// whose name is none of these stays a search word; one of these names with a
// value it does not know is refused with what it takes (`error`), never
// searched as a word: a typo would silently search for nothing. In quotes it
// is a word: "since:lastweek".
// Imports only clock.ts (which imports nothing), so the page can load this file for its hint.
import { zonedPair, zoneLabel } from "../core/clock.ts";

export type SearchLimits = {
  words: string; // the query without its limits
  kinds?: string[]; // rows of the index: user, assistant, tool_use, tool_result, summary
  commands?: boolean; // tool_use rows of a shell tool only
  since?: number;
  until?: number;
  state?: string; // a session state (the daemon's name for it)
  said: string[]; // the limits in words, for the answer ("commands", "since 2026-11-21 00:00 UTC+02:00")
  error?: string; // a limit that was not understood, with what its name takes: the search is not run
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
// The furthest back a span reaches: older than anything Keel holds, and a number a date can carry.
const SPAN_MAX_MS = 10 * 365 * 86_400_000;

// A time a limit names: a span back from now, a day by name or date (its local midnight), or an ISO time. Null: not a time.
// `end`: for until:, a day means the end of that day.
export function limitTime(v: string, now: number, end = false): number | null {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/i.exec(v);
  if (m) {
    const back = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2]!.toLowerCase() as "s" | "m" | "h" | "d" | "w"];
    return Number.isFinite(back) && back <= SPAN_MAX_MS ? now - back : null;
  }
  const t = dayStart(v, now);
  if (t !== null) return end ? nextDay(t) : t;
  const iso = /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : NaN;
  return Number.isFinite(iso) ? iso : null;
}
// The local midnight a day's name or date begins at. Null: not a day.
function dayStart(v: string, now: number): number | null {
  if (v === "today") return midnight(now);
  if (v === "yesterday") return midnight(now, 1);
  const day = /^(\d{4})-(\d\d)-(\d\d)$/.exec(v);
  if (!day) return null;
  const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  // A date that is none (2026-02-31) rolls over in a Date: it is refused.
  return d.getMonth() === Number(day[2]) - 1 && d.getDate() === Number(day[3]) ? d.getTime() : null;
}
const nextDay = (t: number) => { const d = new Date(t); d.setDate(d.getDate() + 1); return d.getTime(); };

// What each name takes, for a refusal.
const TAKES = {
  in: `in: takes ${["commands", "prompts", "replies", "output", "tools", "summaries"].join(", ")}`,
  since: "since: and until: take a span back (90s, 2h, 3d, 1w, ten years at most), today, yesterday, a date (2026-11-20) or an ISO time",
  on: "on: takes today, yesterday or a date (2026-11-20)",
  state: `state: takes ${[...new Set(Object.keys(STATE_WORDS))].join(", ")}`,
};
const refusal = (word: string, takes: string) => `${word} is not a limit this search knows. ${takes}. To search for the text itself, put it in quotes: "${word}"`;

export function searchLimits(q: string, now = Date.now()): SearchLimits {
  const out: SearchLimits = { words: "", said: [] };
  const words: string[] = [];
  let kind = "", state = "";
  let on: number | undefined, since: number | undefined, until: number | undefined;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    const m = /^(in|kind|since|until|on|state):(.+)$/i.exec(w);
    const key = m?.[1]!.toLowerCase(), val = m?.[2]!.toLowerCase();
    if (!m || !val) { words.push(w); continue; }
    if (key === "in" || key === "kind") {
      const k = IN[val];
      if (!k) { out.error ??= refusal(w, TAKES.in); continue; }
      out.kinds = k.kinds;
      if (k.commands) out.commands = true; else delete out.commands;
      kind = k.said;
    } else if (key === "state") {
      const st = STATE_WORDS[val];
      if (!st) { out.error ??= refusal(w, TAKES.state); continue; }
      out.state = st;
      state = val.replace(/-/g, " ");
    } else if (key === "on") {
      const t = dayStart(val, now);
      if (t === null) { out.error ??= refusal(w, TAKES.on); continue; }
      on = t;
    } else {
      const t = limitTime(m[2]!, now, key === "until");
      if (t === null) { out.error ??= refusal(w, TAKES.since); continue; }
      if (key === "since") since = t; else until = t;
    }
  }
  // A day alone is from its midnight to the next; since: and until: written beside it narrow or widen it,
  // wherever in the query they stand. since: sets no end by itself.
  if (on !== undefined) { out.since = on; out.until = nextDay(on); }
  if (since !== undefined) out.since = since;
  if (until !== undefined) out.until = until;
  if (out.since !== undefined && out.until !== undefined && out.since >= out.until) out.error ??= `The search's time range is empty: it starts ${stamp(out.since)} and ends ${stamp(out.until)}. since: is where it starts, until: where it ends`;
  // In a fixed order, each limit once (the last one of a kind written wins). Times are local, with the zone said once.
  if (kind) out.said.push(kind);
  if (state) out.said.push(`sessions now: ${state}`);
  if (out.since !== undefined && out.until !== undefined) { const [a, b] = zonedPair(out.since, out.until, stamp); out.said.push(`from ${a} to ${b}`); }
  else if (out.since !== undefined) out.said.push(`since ${stamp(out.since)} ${zoneLabel(out.since)}`);
  else if (out.until !== undefined) out.said.push(`until ${stamp(out.until)} ${zoneLabel(out.until)}`);
  out.words = words.join(" ");
  return out;
}
