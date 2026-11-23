// What a search is limited to besides its words, written in the query itself
// so one line in the palette or on the command line says it all:
//   in:commands        only shell commands a session ran (not their output, not what was said)
//   in:prompts | in:replies | in:output | in:summaries
//   since:1h | since:2d | since:yesterday | since:today | since:2026-11-20   from then on (it sets no end)
//   until:...                                                                up to then (a day: to its end)
//   on:yesterday | on:today | on:monday | on:2026-11-20                      that day alone
//   state:failed | state:done | state:working | state:needs-you | ...        the session's state now
// "git push in:commands on:yesterday" is every session that ran git push
// yesterday. Plain date words are read as the same limits, and said back as
// read: today, yesterday, a weekday (monday: the latest one, today included),
// last monday (before today), this week (the last seven days) and last week
// (the seven days before those and the week before: every calendar week that
// could be "last week" wherever a week starts), this month and last month.
// "compression export yesterday" is "compression export on:yesterday"; in
// quotes ("yesterday") the word is searched. The order of the limits does not matter. A word with a colon
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
  dates?: string[]; // plain words of the query read as a time ("yesterday", "last week"): the page says how to search them instead
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

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// The local midnight of the latest day of this name, today included (`before`: today excluded).
const weekday = (name: string, now: number, before = false): number | null => {
  const want = DAYS.indexOf(name);
  if (want < 0) return null;
  const back = (new Date(now).getDay() - want + 7) % 7;
  return midnight(now, before && back === 0 ? 7 : back);
};
const monthStart = (now: number, back = 0) => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(1); d.setMonth(d.getMonth() - back); return d.getTime(); };

// A plain date word, or two ("last week"), at the start of `w`: the range it reads as and how many words it took.
// `until` undefined: up to now. Null: no date word there.
export function dateWords(w: string[], now: number): { since: number; until?: number; took: number } | null {
  const a = w[0]?.toLowerCase(), b = w[1]?.toLowerCase();
  if (a === "last" || a === "this") {
    if (b === "week") return a === "this" ? { since: midnight(now, 6), took: 2 } : { since: midnight(now, 13), until: midnight(now), took: 2 };
    if (b === "month") return a === "this" ? { since: monthStart(now), took: 2 } : { since: monthStart(now, 1), until: monthStart(now), took: 2 };
    const day = a === "last" && b ? weekday(b, now, true) : null;
    return day === null ? null : { since: day, until: nextDay(day), took: 2 };
  }
  if (!a) return null;
  const day = a === "today" || a === "yesterday" ? dayStart(a, now) : weekday(a, now);
  return day === null ? null : { since: day, until: nextDay(day), took: 1 };
}

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
  if (DAYS.includes(v)) return weekday(v, now);
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
  on: "on: takes today, yesterday, a weekday (monday) or a date (2026-11-20)",
  state: `state: takes ${[...new Set(Object.keys(STATE_WORDS))].join(", ")}`,
};
const refusal = (word: string, takes: string) => `${word} is not a limit this search knows. ${takes}. To search for the text itself, put it in quotes: "${word}"`;

export function searchLimits(q: string, now = Date.now()): SearchLimits {
  const out: SearchLimits = { words: "", said: [] };
  const words: string[] = [];
  let kind = "", state = "";
  let on: number | undefined, since: number | undefined, until: number | undefined;
  let date: { since: number; until?: number; words: string } | undefined;
  const all = q.split(/\s+/).filter(Boolean);
  for (let i = 0; i < all.length; i++) {
    const w = all[i]!;
    // A plain date word (no quotes, no colon) is a time limit, said back as read.
    const d = dateWords(all.slice(i, i + 2), now);
    if (d) {
      const words = all.slice(i, i + d.took).join(" ").toLowerCase();
      date = { since: d.since, ...(d.until !== undefined ? { until: d.until } : {}), words };
      (out.dates ??= []).push(words);
      i += d.took - 1;
      continue;
    }
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
  // A date word is the day or the range it reads as; on: written as a limit wins over it.
  if (on !== undefined) { out.since = on; out.until = nextDay(on); }
  else if (date) { out.since = date.since; if (date.until !== undefined) out.until = date.until; }
  if (since !== undefined) out.since = since;
  if (until !== undefined) out.until = until;
  if (out.since !== undefined && out.until !== undefined && out.since >= out.until) out.error ??= `The search's time range is empty: it starts ${stamp(out.since)} and ends ${stamp(out.until)}. since: is where it starts, until: where it ends`;
  // In a fixed order, each limit once (the last one of a kind written wins). Times are local, with the zone said once.
  if (kind) out.said.push(kind);
  if (state) out.said.push(`sessions now: ${state}`);
  // A range read from a date word alone names the word it was read from.
  const read = date && on === undefined && since === undefined && until === undefined ? `${date.words}: ` : "";
  // A day by its word is said as the word and its date ("yesterday, 2026-11-21"): its times are its local midnights.
  if (read && out.until !== undefined && out.until === nextDay(out.since!)) out.said.push(`${date!.words}, ${stamp(out.since!).slice(0, 10)}`);
  else if (out.since !== undefined && out.until !== undefined) { const [a, b] = zonedPair(out.since, out.until, stamp); out.said.push(`${read}from ${a} to ${b}`); }
  else if (out.since !== undefined) out.said.push(`${read}since ${stamp(out.since)} ${zoneLabel(out.since)}`);
  else if (out.until !== undefined) out.said.push(`until ${stamp(out.until)} ${zoneLabel(out.until)}`);
  out.words = words.join(" ");
  return out;
}

// The words of a search matched by their stem, not as typed: "compressed exports" finds
// "compression export". The index keeps the words as written (unicode61), and each English
// word of the query is searched as its stem's prefix, so the index needs no second form of
// every word, and a word half typed ("compre") still finds what it begins. A stem is the
// word without one inflection's ending, never shorter than three letters and never without a
// vowel ("string" is no "str"): a prefix shorter would match most of the index. It errs toward
// finding more ("based" is searched as "bas"), since the other words and the ranking narrow it. Other words (numbers, paths, other scripts) are
// searched as typed, the last one as a prefix.
const ENDINGS: [string, number][] = [
  ["ations", 3], ["ation", 3], ["ments", 3], ["ment", 3], ["ness", 3], ["ings", 3], ["ing", 3], ["ions", 4], ["ion", 4],
  ["ies", 3], ["ied", 3], ["ers", 4], ["er", 4], ["ed", 3], ["ly", 4],
];
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (!/^[a-z]{4,}$/.test(w)) return w;
  for (const [end, keep] of ENDINGS) {
    if (!w.endsWith(end) || w.length - end.length < keep || (end === "ed" && w.endsWith("eed"))) continue;
    let s = w.slice(0, -end.length);
    if (!/[aeiouy]/.test(s)) continue;
    // A consonant doubled before the ending is one: stopped, committed, running.
    if ((end === "ed" || end === "ing") && /([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss|zz|ff)$/.test(s) && s.length > 3) s = s.slice(0, -1);
    return s;
  }
  // "used" is "use"; "fixes" is "fix", "classes" is "class", "files" is "file"; "class" and "status" keep
  // their s. ("uses", "cases" and "bases" lose only their s: "us", "cas" and "bas" would find far more.)
  if (w.endsWith("ed") && !w.endsWith("eed")) return w.slice(0, -1);
  if (/(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

// The query's words as FTS5 terms: an English word of four letters or more as its stem's prefix,
// any other word as typed (the last one as a prefix: "deb func" finds "debounce function").
export function searchTerms(q: string): string[] {
  const words = q.normalize("NFKC").split(/\s+/).map((w) => w.replace(/"/g, "")).filter(Boolean);
  return words.map((w, i) => (/^[a-z]{4,}$/i.test(w) ? `"${stem(w)}"*` : `"${w}"${i === words.length - 1 ? "*" : ""}`));
}

// Whether a text's words hold a query word, by the same rule as the index: an English word by
// its stem's prefix, any other as typed, inside a word or not. `hay` is folded already.
export function holdsWord(hay: string, word: string): boolean {
  if (hay.includes(word)) return true;
  if (!/^[a-z]{4,}$/.test(word)) return false;
  const s = stem(word);
  return hay.split(/[^\p{L}\p{N}]+/u).some((t) => t.startsWith(s));
}
