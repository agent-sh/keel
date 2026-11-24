// The pure part of the heavy-command pool (src/tools/heavy.ts): which commands
// are heavy, how many of them the machine has room for now, and who goes next.
//
// One pool for the whole daemon. A heavy command (a test suite, a build, a
// browser: the owner's patterns, `heavy` in the daemon settings) takes a slot
// before it starts; with none free its tool call waits in line. The room is
// read from the machine as it is, not from a count fixed in advance:
//
//   busy   the load on the processors this daemon may use, over the last
//          few seconds: the time their tasks ran and waited to run, from
//          /proc/schedstat, a second of it a task (what the load average
//          counts, without its minute of lag: a dozen commands could all
//          pass a load gate in the same minute). Where that is not there,
//          the processes that run now (/proc/stat), then the load average.
//   limit  the processors this daemon may use (its affinity: a cpuset or a
//          unit's AllowedCPUs) times `load_share`
//   young  slots given less than `cost.ramp_s` and a sample window ago,
//          whose command's load is not in the mean yet: each counts as its
//          command's cost on top of busy
//   gone   slots given back less than a sample window ago, whose load still
//          shows in the mean of busy: each counts as its cost off it
//
// Each pattern has its cost (cores and memory at its peak; a pattern given as
// text costs `cost`). The next command may start while busy plus its cost
// stays under the limit and free memory stays above `free_mb` after its
// memory. At most what fits the limit at each holder's cost run at once (or
// `slots`, when the owner sets a number), and one always may when none runs:
// the line moves even while other work fills the machine.
//
// The owner's own commands (typed in the terminal pane) never wait: they take
// a slot when one is free and run over the pool when none is. In line, a
// session's own command goes before an agent's, and an agent's before a check
// Keel runs by itself beside an agent ("beside", src/checks/beside-run.ts);
// each kind keeps its order. A session's command can still wait for the
// agents' commands that run. Work Keel starts for a later look (the pictures
// of a branch, src/pictures/run.ts) goes after every command in line.
import { basename } from "node:path";
import type { Simple } from "../safety/shell.ts";

export type Who = "owner" | "session" | "agent" | "beside" | "background";
// What a command is counted at: the cores and the memory it takes at its peak.
export type Cost = { cores: number; memory_mb: number };
// A pattern with its own cost; a pattern given as text costs `cost`.
export type Pattern = { pattern: string; cores: number; memory_mb: number };
export type PoolConfig = { patterns: (string | Pattern)[]; load_share: number; free_mb: number; cost: Cost & { ramp_s: number }; slots: number | null };
export type Reading = { cores: number; load1: number; runnable?: number; mem_available_mb: number; at: number };
export type Held = { key: string; who: Who; since: number; cost: Cost };
export type Gone = { at: number; cost: Cost };
export type Waiting = { key: string; who: Who; at: number };
// `cause`: what holds the next command (room: nothing does).
export type Cause = "room" | "slots" | "load" | "memory";
export type Room = { slots: number; free: number; limit: number; busy: number; cause: Cause; why: string };
// The pattern that named a command heavy, what the command is counted at, and
// the simple command it matched (its words, wrappers taken off).
export type Match = { pattern: string; cost: Cost; line: string };
type Compiled = { re: RegExp; source: string; cost: Cost };

// Words that run the command after them: a pattern is matched against that command.
const WRAPPERS = new Set(["env", "nice", "ionice", "timeout", "time", "command", "exec", "nohup", "stdbuf", "xvfb-run", "chrt", "taskset", "caffeinate", "unbuffer"]);
// What these launch is the next word's program.
const LAUNCHERS: Record<string, string[]> = { bunx: [], npx: [], pnpx: [], "pnpm": ["exec", "dlx"], "yarn": ["dlx", "exec"], "uv": ["run"], "uvx": [], "poetry": ["run"] };
// Programs that run their command on another machine: its load is not this one's.
const ELSEWHERE = new Set(["ssh", "mosh", "scp", "rsync", "kubectl", "docker-machine"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

// The words of one simple command with what wraps it taken off: assignments,
// wrappers and their options, a package runner. Empty when it runs elsewhere.
export function bareWords(words: string[]): string[] {
  let w = words.slice();
  for (let guard = 0; guard < 16 && w.length; guard++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) { w = w.slice(1); continue; }
    const p = basename(w[0]!);
    if (p === "systemd-run" || p === "sudo" || p === "doas") {
      const i = w.indexOf("--");
      w = i >= 0 ? w.slice(i + 1) : w.slice(1);
      while (i < 0 && w.length && w[0]!.startsWith("-")) w.shift();
      continue;
    }
    if (WRAPPERS.has(p)) {
      w = w.slice(1);
      // Its options, and a wrapper's own operand (timeout's duration, nice's -n N).
      while (w.length && w[0]!.startsWith("-")) { const o = w.shift()!; if (/^-[a-zA-Z]$/.test(o) && w.length && !w[0]!.startsWith("-") && p !== "env" && p !== "time") w.shift(); }
      if (p === "timeout" && w.length && /^\d+(\.\d+)?[smhd]?$/.test(w[0]!)) w = w.slice(1);
      if (p === "taskset" && w.length && /^[0-9a-fx,-]+$/i.test(w[0]!)) w = w.slice(1);
      continue;
    }
    if (p in LAUNCHERS) {
      const sub = LAUNCHERS[p]!;
      if (!sub.length) { w = w.slice(1); while (w.length && w[0]!.startsWith("-")) w.shift(); continue; }
      if (w[1] && sub.includes(w[1])) { w = w.slice(2); continue; }
    }
    break;
  }
  if (!w.length || ELSEWHERE.has(basename(w[0]!))) return [];
  return [basename(w[0]!), ...w.slice(1)];
}

// The pattern of the owner's list that names a command as heavy, or nothing.
// Each simple command of it (after `&&`, `;`, a pipe, inside `$(...)`) is
// read with its wrappers taken off; `bash -c '...'` is read inside. A pattern
// is a regular expression matched from the start of a command's words. A
// command that only looks heavy (light, below) is not.
export function heavyPattern(parts: Simple[] | null, patterns: Compiled[], split: (cmd: string) => Simple[] | null, depth = 0): Match | undefined {
  if (!parts || !patterns.length) return undefined;
  for (const s of parts) {
    let w = bareWords(s.words);
    if (!w.length) continue;
    if (SHELLS.has(w[0]!) && depth < 3) {
      const i = w.findIndex((x) => /^-[a-z]*c$/.test(x));
      if (i > 0 && w[i + 1]) { const inner = heavyPattern(split(w[i + 1]!), patterns, split, depth + 1); if (inner) return inner; continue; }
      // `bash script.sh ...`: the script is the command.
      const rest = w.slice(1);
      while (rest.length && rest[0]!.startsWith("-")) rest.shift();
      if (rest.length) w = [basename(rest[0]!), ...rest.slice(1)];
    }
    if (light(w)) continue;
    const line = w.join(" ");
    for (const p of patterns) if (p.re.test(line)) return { pattern: p.source, cost: p.cost, line: line.slice(0, 200) };
  }
  return undefined;
}

// Forms of a heavy program that are not a heavy command:
//   - one that stays up for later: a watcher (--watch, tsc/vite/bun -w), a
//     dev server or a preview (serve, dev, preview, start, watch as the script
//     of a script runner, the target of a make, or the command of a server
//     such as vite or next). It holds a slot for as long as it lives, so on a
//     small machine every other heavy command, the same session's next one
//     included, would wait for it forever; its load, while it works, is in
//     the busy count. Only those programs: in `bun test dev`, `cargo test
//     start` or `docker build --target dev` the word is an argument, and a
//     command whose word is test, build, check, vet or compile is pooled.
//   - one that says something and ends: --version, --help, a make or ninja
//     dry run, a clean.
const WATCHERS = new Set(["tsc", "vite", "bun", "esbuild", "rollup", "webpack", "tsup", "nodemon", "deno"]);
const STAYS = new Set(["serve", "dev", "preview", "start", "watch"]);
const WORKS = new Set(["test", "build", "check", "vet", "compile"]);
// Script runners: `npm run dev`, `npm start`, `yarn dev`, `bun run serve`, `deno task dev`.
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "deno"]);
const TARGETS = new Set(["make", "gmake", "just"]);
const SERVERS = new Set(["vite", "next", "nuxt", "nuxi", "astro", "ng", "webpack", "webpack-dev-server", "wrangler", "hugo", "gatsby", "docusaurus", "react-scripts", "expo", "remix", "svelte-kit", "vue-cli-service", "parcel", "eleventy", "jekyll", "storybook", "turbo"]);
const MAKES = new Set(["make", "gmake", "ninja"]);
export function stays(prog: string, args: string[]): boolean {
  const words = args.filter((a) => !a.startsWith("-") && !a.includes("="));
  const first = words[0];
  if (!first || WORKS.has(first)) return false;
  if (RUNNERS.has(prog)) {
    const script = first === "run" || first === "task" || first === "run-script" ? words[1] : first;
    return !!script && STAYS.has(script);
  }
  if (TARGETS.has(prog) || SERVERS.has(prog)) return STAYS.has(first);
  return false;
}
export function light(w: string[]): boolean {
  const prog = w[0]!;
  const args = w.slice(1);
  if (args.some((a) => /^--(watch|watchAll|serve|ui)(=|$)/.test(a) || a === "--version" || a === "--help" || a === "--dry-run")) return true;
  if (WATCHERS.has(prog) && args.includes("-w")) return true;
  if (args.includes("-h") || args.includes("-V") || args[0] === "help") return true;
  if (stays(prog, args)) return true;
  if (MAKES.has(prog)) {
    if (args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a) || a === "--just-print" || a === "--recon" || a === "-q" || a === "--question" || a === "-t")) return true;
    const targets = args.filter((a) => !a.startsWith("-") && !a.includes("="));
    if (targets.length && targets.every((t) => /^(clean|distclean|mostlyclean|help)$/.test(t))) return true;
  }
  return false;
}

// The processors of a list as the kernel writes it ("0-3,8,10-11").
export function cpuList(text: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.trim().split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    for (let c = Number(m[1]); c <= Number(m[2] ?? m[1]); c++) out.add(c);
  }
  return out;
}

// The time the tasks of these processors ran and waited to run, in ns, from
// /proc/schedstat (a cpu line's 7th and 8th numbers: rq_cpu_time, run_delay).
export function schedTime(text: string, cpus?: Set<number>): number | undefined {
  let sum = 0, seen = 0;
  for (const m of text.matchAll(/^cpu(\d+)((?: \d+){9})/gm)) {
    if (cpus && !cpus.has(Number(m[1]))) continue;
    const f = m[2]!.trim().split(" ").map(Number);
    sum += f[6]! + f[7]!;
    seen++;
  }
  return seen ? sum : undefined;
}

// The load between two readings of schedTime: tasks running or waiting, on average.
export const loadBetween = (a: { at: number; ns: number }, b: { at: number; ns: number }) => (b.at > a.at ? Math.max(0, (b.ns - a.ns) / 1e6 / (b.at - a.at)) : undefined);

// The owner's patterns as expressions, each with its cost; one that does not
// compile is left out (the settings check refuses it, so only an older file can hold one).
export function compile(patterns: PoolConfig["patterns"], cost: Cost): Compiled[] {
  const out: Compiled[] = [];
  for (const p of patterns) {
    const source = typeof p === "string" ? p : p.pattern;
    const c = typeof p === "string" ? { cores: cost.cores, memory_mb: cost.memory_mb } : { cores: p.cores, memory_mb: p.memory_mb };
    try { out.push({ re: new RegExp(`^(?:${source})(?![\\w.-])`), source, cost: c }); } catch {}
  }
  return out;
}

const sum = (xs: Cost[], k: keyof Cost) => xs.reduce((a, x) => a + x[k], 0);

// How many heavy commands the machine has room for now, and how many of them
// are free, for a next command of cost `next` (the head of the line's).
export function room(r: Reading, held: Held[], cfg: PoolConfig, gone: Gone[] = [], windowMs = 0, next: Cost = cfg.cost): Room {
  const limit = r.cores * cfg.load_share;
  const cost = Math.max(0.1, next.cores);
  const busyNow = r.runnable ?? r.load1;
  const young = held.filter((h) => r.at - h.since < cfg.cost.ramp_s * 1000 + windowMs).map((h) => h.cost);
  const left = gone.filter((g) => r.at - g.at < windowMs).map((g) => g.cost);
  const busy = Math.max(0, busyNow + sum(young, "cores") - sum(left, "cores"));
  const cpu = Math.floor((limit - busy) / cost);
  const memLeft = r.mem_available_mb - sum(young, "memory_mb") + sum(left, "memory_mb") - cfg.free_mb;
  const mem = next.memory_mb > 0 ? Math.floor(memLeft / next.memory_mb) : Infinity;
  const more = Math.max(0, Math.min(cpu, mem));
  const counted = held.length;
  // At most what fits the limit at each command's own peak, or the owner's number.
  const cap = cfg.slots ?? Math.max(1, counted + Math.floor((limit - sum(held.map((h) => h.cost), "cores")) / cost));
  const slots = Math.max(1, Math.min(cap, counted + more));
  const free = Math.max(0, slots - counted);
  const cause: Cause = free > 0 ? "room" : counted >= cap ? "slots" : mem < cpu ? "memory" : "load";
  const why = { room: "room", slots: cap === 1 ? "the one slot is taken" : `all ${cap} slots are taken`, memory: `free memory under ${cfg.free_mb + next.memory_mb} MB`, load: `load ${busy.toFixed(1)} of ${limit.toFixed(1)}` }[cause];
  return { slots, free, limit, busy, cause, why };
}

const RANK: Record<Who, number> = { owner: 0, session: 1, agent: 2, beside: 3, background: 4 };
// How many in line go before one of this kind asking now.
export const before = (line: Waiting[], who: Who) => line.filter((x) => RANK[x.who] <= RANK[who]).length;
// The line in the order slots go: a session's own command before an agent's,
// each kind by when it asked. Slots go from its head only: a command that
// does not fit yet is not passed by a smaller one behind it.
export function order<T extends Waiting>(line: T[]): T[] {
  return line.slice().sort((a, b) => RANK[a.who] - RANK[b.who] || a.at - b.at);
}

// A command that holds a slot and has gone quiet gives the slot back: its
// processes used under IDLE_SHARE of the cores it was counted at, over
// IDLE_MS straight (a browser left open for later, a run that hangs on a
// lock). What it does afterwards shows in the busy count like any other load.
// Decided from samples of its processor time, ms against ms of clock.
export const IDLE_MS = 15_000;
export const IDLE_SHARE = 0.1;
const QUIET_GAP_MS = 10_000;
export type Quiet = { from: number; cpu: number; at: number };
export function nextQuiet(prev: Quiet | undefined, s: { at: number; cpu: number }, cores: number): Quiet {
  // A sample long after the last (no one waited between them) starts the count again.
  if (!prev || s.at <= prev.from || s.cpu < prev.cpu || s.at - prev.at > QUIET_GAP_MS) return { from: s.at, cpu: s.cpu, at: s.at };
  if ((s.cpu - prev.cpu) / (s.at - prev.from) > IDLE_SHARE * cores) return { from: s.at, cpu: s.cpu, at: s.at };
  return { ...prev, at: s.at };
}
export const quiet = (q: Quiet | undefined) => !!q && q.at - q.from >= IDLE_MS;

// The one line a held command's session is told: its place, what holds the
// slots and why it waits. No live number in it, so it changes only when the
// place, the holders or the cause do.
const CAUSE: Record<Cause, string> = { room: "a slot is freeing", slots: "every slot is taken", load: "the machine is busy", memory: "free memory is low" };
export function placeLine(ahead: number, holders: string[], cause: Cause): string {
  const place = ahead === 0 ? "next in line" : `${ahead} ahead`;
  const named = holders.slice(0, 3).join(", ") + (holders.length > 3 ? ` and ${holders.length - 3} more` : "");
  const by = holders.length ? `held by ${named}` : "none held";
  return `Waiting for a heavy-command slot: ${place}, ${by}; ${CAUSE[cause]}`;
}

export function checkConfig(v: any): string | undefined {
  const entry = (p: any) => typeof p === "string" ? p.trim() !== "" : !!p && typeof p === "object" && typeof p.pattern === "string" && p.pattern.trim() !== "" && p.cores > 0 && p.memory_mb >= 0;
  if (!Array.isArray(v.patterns) || !v.patterns.every(entry)) return "patterns is a list of regular expressions, each a text or { pattern, cores (above 0), memory_mb }";
  for (const p of v.patterns) { const src = typeof p === "string" ? p : p.pattern; try { new RegExp(src); } catch (e) { return `pattern ${src} is not a regular expression: ${(e as Error).message}`; } }
  if (!(typeof v.load_share === "number" && v.load_share > 0 && v.load_share <= 4)) return "load_share is a number above 0 (a share of the cores)";
  if (!(Number.isInteger(v.free_mb) && v.free_mb >= 0)) return "free_mb is a whole number of MB";
  const c = v.cost;
  if (!c || typeof c !== "object" || !(c.cores > 0) || !(c.memory_mb >= 0) || !(c.ramp_s >= 0)) return "cost holds cores (above 0), memory_mb and ramp_s";
  if (!(v.slots === null || (Number.isInteger(v.slots) && v.slots >= 1))) return "slots is a whole number of at least 1, or null to size the pool from the machine";
  return undefined;
}
