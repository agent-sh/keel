// Whether the harness that wrote a transcript still works on something, from
// three kinds of evidence: what its last records leave open (a call with no
// result yet, a subagent, a turn), the processes it started that still run,
// and the state the harness itself reports where it reports one. The age of
// the file is never used: a long foreground command or a subagent's shell
// writes nothing for as long as it runs.
//
// Pure: the readers of the process table and of the harness's own state are in
// src/fleet/hands-sessions.ts.
import { clip, type Harness } from "./types.ts";

export type Call = { id: string; name: string; kind: "tool" | "subagent"; label: string; command?: string; ts: number };

// What the records since the harness started leave open.
export type Tail = {
  open: Call[];        // asked for and not answered yet, oldest first
  background: Call[];  // started in the background and not reported finished
  shells: Call[];      // every shell command of the window, newest first: it names a process
  turn: "open" | "closed" | "unknown";
};

export type Proc = { pid: number; ppid: number; pgid: number; started_ms: number; args: string };
// A process group the harness started outside its own: a tool's shell, a job.
export type Group = { pgid: number; pid: number; started_ms: number; command: string; args: string[]; shared?: boolean; members?: Pick<Proc, "pid" | "started_ms">[] };

export type Signals = {
  alive: boolean;                               // the harness process of this session runs
  status?: string;         // its own word, where it gives one
  waiting_for?: string;
  tail: Tail;
  groups: Group[];
};

export type InFlight = { kind: "job" | "tool" | "subagent" | "turn" | "prompt"; label: string; command?: string; pid?: number; pgid?: number; since_ms?: number };
export type Helper = { pid: number; pgid: number; command: string; since_ms: number };
// `why` is a sentence part for a sheet and a note; `brief` the same in a few words, for a row.
export type Activity = { state: "ended" | "idle" | "active"; in_flight: InFlight[]; helpers: Helper[]; why: string; brief: string };

// Wait for the turn and prompts, not independent background jobs.
export const atWork = (a: Activity) => a.in_flight.some((i) => i.kind !== "job");

const INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]$/;
const SHELLS = new Set(["Bash", "shell", "exec_command", "shell_command", "local_shell", "container.exec", "run_shell_command"]);
const SUBAGENTS = new Set(["Agent", "Task", "spawn_agent"]);
const HINTS = ["file_path", "path", "url", "query", "pattern", "prompt", "skill", "name"];

function callOf(id: string, name: string, input: any, ts: number): Call {
  const raw = input?.command ?? input?.cmd;
  const command = SHELLS.has(name) ? (Array.isArray(raw) ? raw.join(" ") : typeof raw === "string" ? raw : undefined) : undefined;
  if (SUBAGENTS.has(name)) return { id, name, kind: "subagent", label: clip(`${input?.subagent_type ?? input?.agent_type ?? "subagent"}: ${input?.description ?? input?.prompt ?? ""}`, 160), ts };
  const hint = command ?? HINTS.map((k) => input?.[k]).find((v) => typeof v === "string" && v);
  const described = command && typeof input?.description === "string" && input.description ? `${input.description}: ` : "";
  return { id, name, kind: "tool", label: clip(`${name}${hint ? ` (${described}${hint})` : ""}`, 200), command, ts };
}

// A reader of records newest first: `push` answers true once nothing older
// matters (a record from before `since`, the time the harness process started:
// nothing older can be in flight in it), `done` gives what was left open.
export type TailReader = { push(r: any): boolean; done(): Tail };

// Claude Code: a call is open until its tool_result; a call started in the
// background until the task-notification that names it; a turn ends with a
// turn_duration record (or a reply that stopped by itself).
export function claudeTail(since = 0): TailReader {
  const answered = new Set<string>();
  const finished = new Set<string>();
  const t: Tail = { open: [], background: [], shells: [], turn: "unknown" };
  let past = false; // older than the end of a turn, or than an interruption: no call there is still asked for
  const decide = (turn: "open" | "closed") => { if (t.turn === "unknown") t.turn = turn; };
  return {
    push(r) {
      const ts = Date.parse(r?.timestamp ?? "") || 0;
      if (ts && ts < since) return true;
      if (!r || r.isSidechain) return false;
      if (r.type === "system" && (r.subtype === "turn_duration" || r.subtype === "stop_hook_summary")) { decide("closed"); past = true; return false; }
      const c = r.message?.content;
      const blocks: any[] = Array.isArray(c) ? c : [];
      if (r.type === "user") {
        const text = typeof c === "string" ? c : blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
        if (text.includes("<task-notification>")) for (const m of text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) finished.add(m[1]!);
        if (INTERRUPTED.test(text.trim())) { decide("closed"); past = true; return false; }
        for (const b of blocks) if (b?.type === "tool_result") answered.add(b.tool_use_id);
        if (!r.isMeta) decide("open");
      } else if (r.type === "assistant") {
        const uses = blocks.filter((b) => b?.type === "tool_use");
        const stop = r.message?.stop_reason;
        decide(!uses.length && (stop === "end_turn" || stop === "stop_sequence") ? "closed" : "open");
        for (const b of uses.reverse()) {
          const call = callOf(b.id, b.name, b.input, ts);
          if (call.command) t.shells.push(call);
          if (b.input?.run_in_background === true && answered.has(b.id)) { if (!finished.has(b.id)) t.background.push(call); }
          else if (!past && !answered.has(b.id)) t.open.push(call);
        }
      }
      return false;
    },
    done: () => ({ ...t, open: [...t.open].reverse(), background: [...t.background].reverse() }),
  };
}

// Codex: a turn is between task_started and task_complete (or turn_aborted);
// a call is open until its output.
export function codexTail(since = 0): TailReader {
  const answered = new Set<string>();
  const t: Tail = { open: [], background: [], shells: [], turn: "unknown" };
  let past = false;
  return {
    push(r) {
      const ts = Date.parse(r?.timestamp ?? "") || 0;
      if (ts && ts < since) return true;
      const p = r?.payload;
      if (!p) return false;
      if (r.type === "event_msg") {
        if (["task_complete", "turn_complete", "turn_aborted"].includes(p.type)) { if (t.turn === "unknown") t.turn = "closed"; past = true; }
        else if (p.type === "task_started" || p.type === "turn_started") { if (t.turn === "unknown") t.turn = "open"; past = true; }
      } else if (r.type === "response_item") {
        if (typeof p.type === "string" && p.type.endsWith("_output")) answered.add(p.call_id);
        else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
          let input: any = p.type === "local_shell_call" ? { command: p.action?.command } : p.type === "custom_tool_call" ? { input: p.input } : p.arguments;
          if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = {}; } }
          const call = callOf(p.call_id, p.type === "local_shell_call" ? "shell" : String(p.name ?? "tool"), input, ts);
          if (call.command) t.shells.push(call);
          if (!past && !answered.has(p.call_id)) t.open.push(call);
        }
      }
      return false;
    },
    done: () => ({ ...t, open: [...t.open].reverse() }),
  };
}

export const tailReader = (harness: Harness, since = 0): TailReader => (harness === "codex" ? codexTail(since) : claudeTail(since));

export function tailOf(harness: Harness, newestFirst: Iterable<any>, since = 0): Tail {
  const r = tailReader(harness, since);
  for (const rec of newestFirst) if (r.push(rec)) break;
  return r.done();
}

// The process groups a harness started outside its own group: its tool shells
// and jobs. Its own group holds what serves it for as long as it runs (MCP
// servers), which is not work. `extra`: processes that carry its session in
// their environment and are no longer under it (a job whose shell ended).
export function groupsUnder(procs: Proc[], harnessPid: number, extra: number[] = []): Group[] {
  const by = new Map(procs.map((p) => [p.pid, p]));
  const root = by.get(harnessPid);
  if (!root) return [];
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const under = new Set<number>();
  const walk = (pid: number) => { for (const k of kids.get(pid) ?? []) if (!under.has(k.pid)) { under.add(k.pid); walk(k.pid); } };
  walk(harnessPid);
  for (const pid of extra) if (by.has(pid) && pid !== harnessPid) under.add(pid);
  const groups = new Map<number, Proc[]>();
  for (const pid of under) {
    const p = by.get(pid)!;
    if (p.pgid === root.pgid) {
      // A tool or subagent can run in the terminal's group. Never signal that group.
      groups.set(-p.pid, [p]);
      continue;
    }
    groups.set(p.pgid, [...(groups.get(p.pgid) ?? []), p]);
  }
  return [...groups.entries()].map(([pgid, ps]) => {
    ps.sort((a, b) => a.started_ms - b.started_ms || a.pid - b.pid);
    const lead = ps.find((p) => p.pid === pgid) ?? ps[0]!;
    return { pgid: lead.pgid, shared: pgid < 0, members: ps.map(({ pid, started_ms }) => ({ pid, started_ms })), pid: lead.pid, started_ms: lead.started_ms, command: lead.args, args: ps.map((p) => p.args) };
  }).sort((a, b) => a.started_ms - b.started_ms);
}

// A command and a process's arguments as plain words: a shell wraps the
// command it is given in quotes and its own setup.
const plain = (s: string) => s.replace(/[\\'"]/g, "").replace(/\s+/g, " ").trim();
const INTERPRETER = /^(\S*\/)?(env|nohup|setsid|sh|bash|zsh|dash|python3?|node|bun)( -\S+)*\s+/;

// Whether a process runs a command the transcript names: the command inside
// the shell's arguments, or the process's own words inside the command (a
// script the command started with nohup or setsid).
export function runs(args: string, command: string): boolean {
  const a = plain(args);
  const c = plain(command);
  if (!a || !c) return false;
  if (a.includes(c)) return true;
  let core = a;
  for (let m = core.match(INTERPRETER); m; m = core.match(INTERPRETER)) core = core.slice(m[0].length);
  return core.length >= 3 && c.includes(core);
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function classify(s: Signals): Activity {
  const { tail } = s;
  if (!s.alive) {
    const left = tail.open.length ? `; ${count(tail.open.length, "call")} of its last turn never got a result` : "";
    return { state: "ended", in_flight: [], helpers: [], why: `its process is not running${left}`, brief: "not running" };
  }
  const named = (g: Group, calls: Call[]) => calls.find((c) => c.command && g.args.some((a) => runs(a, c.command!)));
  const jobs: InFlight[] = [];
  const helpers: Helper[] = [];
  const unclassified: InFlight[] = [];
  const running = new Map<string, Group>();
  for (const g of s.groups) {
    const fg = named(g, tail.open.filter((c) => !running.has(c.id)));
    if (fg) { running.set(fg.id, g); continue; }
    const job = !g.shared && (named(g, tail.background) ?? named(g, tail.shells));
    if (job) jobs.push({ kind: "job", label: clip(job.label, 200), command: clip(g.command, 300), pid: g.pid, pgid: g.pgid, since_ms: g.started_ms });
    else unclassified.push({ kind: "tool", label: `Child process: ${clip(g.command, 200)}`, pid: g.pid, pgid: g.shared ? undefined : g.pgid, since_ms: g.started_ms });
  }
  // A call the transcript leaves open counts while its process runs, or while
  // the harness says it works; with no word from the harness, while its turn is open.
  const asked = s.status === "busy" || (s.status === undefined && tail.turn !== "closed");
  const calls: InFlight[] = tail.open.filter((c) => running.has(c.id) || asked).map((c) => {
    const g = running.get(c.id);
    return { kind: c.kind, label: c.label, command: c.command && clip(c.command, 300), pid: g?.pid, pgid: g?.shared ? undefined : g?.pgid, since_ms: g?.started_ms ?? c.ts };
  });
  calls.push(...unclassified);
  // A subagent started in the background has no process of its own.
  const agents: InFlight[] = tail.background.filter((c) => c.kind === "subagent").map((c) => ({ kind: "subagent", label: c.label, since_ms: c.ts }));
  const rest: InFlight[] = [];
  if (!calls.length && (s.status === "busy" || (s.status === undefined && tail.turn === "open"))) rest.push({ kind: "turn", label: "a reply is being written" });
  if (s.status && !["idle", "busy", "waiting"].includes(s.status)) rest.push({ kind: "turn", label: `harness state: ${clip(s.status, 80)}` });
  if (!s.status && tail.turn === "unknown" && !calls.length) rest.push({ kind: "turn", label: "the harness has not confirmed it is idle" });
  if (s.status === "waiting") rest.push({ kind: "prompt", label: `it waits on ${s.waiting_for || "a prompt"} where it runs` });
  const in_flight = [...jobs, ...calls, ...agents, ...rest];
  const parts = [
    jobs.length ? count(jobs.length, "background job") : "",
    calls.filter((c) => c.kind === "tool").length ? `${count(calls.filter((c) => c.kind === "tool").length, "call")} running` : "",
    calls.filter((c) => c.kind === "subagent").length + agents.length ? count(calls.filter((c) => c.kind === "subagent").length + agents.length, "subagent") : "",
    ...rest.map((r) => r.label),
  ].filter(Boolean);
  const subagents = calls.filter((c) => c.kind === "subagent").length + agents.length;
  const brief = [
    jobs.length ? count(jobs.length, "job") : "",
    calls.filter((c) => c.kind === "tool").length ? count(calls.filter((c) => c.kind === "tool").length, "call") : "",
    subagents ? count(subagents, "subagent") : "",
    rest.some((r) => r.kind === "turn") ? "replying" : "",
    rest.some((r) => r.kind === "prompt") ? "on a prompt" : "",
  ].filter(Boolean).join(", ");
  return { state: in_flight.length ? "active" : "idle", in_flight, helpers, why: parts.join(", ") || (s.status === "idle" ? "it says it is idle" : "nothing is in flight"), brief: brief || "idle" };
}
