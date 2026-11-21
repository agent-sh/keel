// Schedules a Loop can have, parsed and stepped without any clock of its own.
// Calendar times are read in the loop's time zone (see nextCron).

export type Schedule =
  | { kind: "interval"; seconds: number; text: string }
  | { kind: "cron"; expr: string; text: string }
  | { kind: "auto"; text: string }
  | { kind: "webhook"; text: string };

const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const UNIT_WORDS: Record<string, string> = {
  sec: "s", secs: "s", second: "s", seconds: "s", min: "m", mins: "m", minute: "m", minutes: "m",
  hr: "h", hrs: "h", hour: "h", hours: "h", day: "d", days: "d", week: "w", weeks: "w",
};
export const YEAR = 366 * 86400;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function unitOf(u: string): string | undefined {
  u = u.toLowerCase();
  return UNIT[u] ? u : UNIT_WORDS[u];
}

function intervalText(sec: number): string {
  for (const [u, n, w] of [["w", 604800, "week"], ["d", 86400, "day"], ["h", 3600, "hour"], ["m", 60, "minute"]] as const) {
    if (sec % n === 0) return sec === n ? `every ${w}` : `every ${sec / n} ${w}s`;
    void u;
  }
  return `every ${sec} seconds`;
}

// The named forms turn into a five-field expression.
function named(s: string): string | undefined {
  const t = s.toLowerCase().trim();
  const hm = (x: string) => {
    const m = x.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return undefined;
    const h = Number(m[1]), mi = Number(m[2]);
    return h < 24 && mi < 60 ? `${mi} ${h}` : undefined;
  };
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(?:every day at|daily at|at)\s+(\d{1,2}:\d{2})$/))) return hm(m[1]!) && `${hm(m[1]!)} * * *`;
  if ((m = t.match(/^weekdays\s+(?:at\s+)?(\d{1,2}:\d{2})$/))) return hm(m[1]!) && `${hm(m[1]!)} * * 1-5`;
  if ((m = t.match(/^weekends\s+(?:at\s+)?(\d{1,2}:\d{2})$/))) return hm(m[1]!) && `${hm(m[1]!)} * * 0,6`;
  if ((m = t.match(/^((?:sun|mon|tue|wed|thu|fri|sat)(?:,(?:sun|mon|tue|wed|thu|fri|sat))*)\s+(?:at\s+)?(\d{1,2}:\d{2})$/))) {
    return hm(m[2]!) && `${hm(m[2]!)} * * ${m[1]}`;
  }
  return undefined;
}

export function parseSchedule(input: string): Schedule {
  const s = input.trim();
  const low = s.toLowerCase();
  if (low === "auto") return { kind: "auto", text: "self-paced" };
  if (low === "webhook") return { kind: "webhook", text: "when its webhook is called" };
  if (low === "hourly") return interval(3600);
  if (low === "daily") return interval(86400);
  if (low === "weekly") return interval(604800);
  const m = low.match(/^(?:every\s+)?(\d+)\s*([a-z]+)$/);
  if (m && unitOf(m[2]!)) return interval(Number(m[1]) * UNIT[unitOf(m[2]!)!]!);
  const expr = named(s) ?? s;
  const fields = parseCron(expr); // throws with the reason
  if (!nextCron(fields, Date.now())) throw new Error(`the schedule "${s}" names no time that comes`);
  return { kind: "cron", expr, text: describeCron(expr) };
}

function interval(seconds: number): Schedule {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("an interval is a positive number");
  // The scheduler counts in minutes: seconds round up to the next minute.
  seconds = Math.ceil(seconds / 60) * 60;
  if (seconds > YEAR) throw new Error("an interval is at most a year");
  return { kind: "interval", seconds, text: intervalText(seconds) };
}

type Fields = { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean };

function field(src: string, lo: number, hi: number, names?: string[]): Set<number> {
  const out = new Set<number>();
  const val = (x: string) => {
    const i = names?.indexOf(x.toLowerCase()) ?? -1;
    const n = i >= 0 ? i + (names === MONTHS ? 1 : 0) : Number(x);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`"${x}" is out of range ${lo}-${hi}`);
    return n;
  };
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let a: number, b: number;
    if (range === "*") [a, b] = [lo, hi];
    else if (range!.includes("-")) { const [x, y] = range!.split("-"); a = val(x!); b = val(y!); }
    else { a = val(range!); b = stepS === undefined ? a : hi; }
    if (a > b) throw new Error(`bad range "${range}"`);
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}

export function parseCron(expr: string): Fields {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`"${expr}" is not a schedule: use 5m, 2h, daily, a five-field cron expression, "weekdays 09:30" or auto`);
  const dow = field(f[4]!, 0, 7, DAYS);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    min: field(f[0]!, 0, 59), hour: field(f[1]!, 0, 23), dom: field(f[2]!, 1, 31),
    mon: field(f[3]!, 1, 12, MONTHS), dow, domAny: f[2] === "*", dowAny: f[4] === "*",
  };
}

// Calendar times are read in a named zone (IANA), the loop's own, so a loop
// keeps its times when the daemon moves to a machine in another zone.
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export function checkZone(tz: string): string {
  try {
    if (typeof tz !== "string") throw new Error("not a name");
    // The name as the zone database writes it (europe/paris is Europe/Paris).
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`"${tz}" is not a time zone: use an IANA name such as Europe/Paris or UTC`);
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
type Wall = { y: number; mo: number; d: number; h: number; mi: number; dow: number };
function wall(t: number, tz: string): Wall {
  let f = formats.get(tz);
  if (!f) formats.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })));
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(t)) p[x.type] = x.value;
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour! % 24, mi: +p.minute!, dow: DAYS.indexOf(p.weekday!.toLowerCase().slice(0, 3)) };
}
const wallUtc = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);

// The instant a wall time names in `tz`. A time the autumn change repeats is
// its first occurrence; a time the spring change skips is the first instant
// after the gap (02:30 becomes 03:00), as cron runs a skipped job at the change.
function resolve(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  const off = (t: number) => wallUtc(wall(t, tz)) - Math.floor(t / 60_000) * 60_000;
  const before = target - off(target - 43_200_000), after = target - off(target + 43_200_000);
  const hits = [before, after].filter((c) => wallUtc(wall(c, tz)) === target);
  if (hits.length) return Math.min(...hits);
  let lo = Math.min(before, after), hi = Math.max(before, after);
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 120_000) * 60_000;
    if (wallUtc(wall(mid, tz)) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

// crontab(5): when both day fields are restricted, either one matching is enough.
const dayOk = (f: Fields, dom: number, dow: number) => {
  const domOk = f.dom.has(dom), dowOk = f.dow.has(dow);
  return f.domAny && f.dowAny ? true : f.domAny ? dowOk : f.dowAny ? domOk : domOk || dowOk;
};

// The first matching minute strictly after `after`, within about a year, in
// `tz` (the machine's zone when not given). Every hour of the day named (`*`):
// each minute that passes on the clock, so the repeated autumn hour runs twice
// like any hour. Named hours: once a day per wall time (see resolve).
export function nextCron(f: Fields, after: number, tz = localZone()): number | undefined {
  const limit = after + YEAR * 1000 + 86400_000;
  const mins = [...f.min].sort((a, b) => a - b);
  if (f.hour.size === 24) {
    let t = Math.floor(after / 60_000) * 60_000 + 60_000;
    while (t < limit) {
      const w = wall(t, tz);
      if (!f.mon.has(w.mo) || !dayOk(f, w.d, w.dow)) { t = resolve(w.y, w.mo, w.d + 1, 0, 0, tz); continue; }
      if (f.min.has(w.mi)) return t;
      const m = mins.find((x) => x > w.mi);
      t += ((m ?? 60) - w.mi) * 60_000;
    }
    return undefined;
  }
  const hours = [...f.hour].sort((a, b) => a - b);
  const w0 = wall(after, tz);
  for (let day = 0; day <= 400; day++) {
    const date = new Date(Date.UTC(w0.y, w0.mo - 1, w0.d + day));
    const y = date.getUTCFullYear(), mo = date.getUTCMonth() + 1, d = date.getUTCDate();
    if (!f.mon.has(mo) || !dayOk(f, d, date.getUTCDay())) continue;
    for (const h of hours) for (const m of mins) {
      const t = resolve(y, mo, d, h, m, tz);
      if (t > after) return t < limit ? t : undefined;
    }
  }
  return undefined;
}

export function nextRuns(expr: string, after: number, n = 3, tz?: string): number[] {
  const f = parseCron(expr);
  const out: number[] = [];
  let t = after;
  while (out.length < n) {
    const x = nextCron(f, t, tz);
    if (!x) break;
    out.push(x);
    t = x;
  }
  return out;
}

export function describeCron(expr: string): string {
  const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const at = /^\d+$/.test(mi!) && /^\d+$/.test(h!) ? `at ${h!.padStart(2, "0")}:${mi!.padStart(2, "0")}` : undefined;
  const days = dow === "*" ? "" : dow === "1-5" ? "weekdays" : dow === "0,6" || dow === "6,0" ? "weekends" : `on ${dow}`;
  if (at && dom === "*" && mon === "*") return [days || "every day", at].join(" ");
  const step = mi!.match(/^\*\/(\d+)$/);
  if (step && h === "*" && dom === "*" && mon === "*" && dow === "*") return `every ${step[1]} minutes`;
  if (/^\d+$/.test(mi!) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `every hour at :${mi!.padStart(2, "0")}`;
  return `cron ${expr}`;
}

// `/loop [interval] [prompt]` as Claude Code reads it: a leading interval token
// or a trailing "every <n> <unit>" sets a fixed interval; no interval means the
// model paces itself; no prompt means the default maintenance prompt.
export function parseLoopCommand(text: string): { schedule: string; prompt: string } | undefined {
  const m = text.trim().match(/^\/loop\b\s*([\s\S]*)$/);
  if (!m) return undefined;
  let rest = m[1]!.trim();
  let schedule = "auto";
  const lead = rest.match(/^(\d+)\s*([a-z]+)\b\s*/i);
  if (lead && unitOf(lead[2]!)) {
    schedule = `${lead[1]}${unitOf(lead[2]!)}`;
    rest = rest.slice(lead[0].length);
  } else {
    const tail = rest.match(/\s*,?\s*every\s+(\d+)\s*([a-z]+)\s*$/i);
    if (tail && unitOf(tail[2]!)) {
      schedule = `${tail[1]}${unitOf(tail[2]!)}`;
      rest = rest.slice(0, tail.index);
    }
  }
  return { schedule, prompt: rest.trim() };
}
