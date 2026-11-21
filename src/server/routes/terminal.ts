// The terminal pane: every command a session ran, newest last, with how it
// ended, its output (colors kept), the ones still running or in the
// background, and the owner's stop and re-run. Built from the session's tool
// calls (the conversation is the record of what was asked) joined with the
// jobs that ran them (how they ran, their whole output). A session placed on a
// machine of the fleet asks that machine's daemon for its jobs.
import { isAbsolute, resolve } from "node:path";
import { contains } from "../../core/paths.ts";
import { SessionMap } from "../../core/session-map.ts";
import type { Session, StoredEvent } from "../../core/types.ts";
import { LinkError } from "../../fleet/link.ts";
import { addNotice, cleanTerm } from "../../tools/jobs.ts";
import { listJobs, logPath, ownerNote, ownerRun, readJobLog, stopOne, TAIL, type TermJob } from "../../tools/terminal.ts";
import type { RouteModule } from "../app.ts";
import { fleet } from "./fleet.ts";
import { presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export type TermEntry = {
  key: string; call_id?: string; tool?: string; by: "model" | "owner"; command: string; description?: string; cwd?: string;
  machine?: string; started: number; ended?: number;
  state: "running" | "background" | "ok" | "failed" | "stopped";
  exit_code?: number | null; signal?: string | null; reason?: string;
  job_id?: string; pty?: boolean; bytes?: number; output: string; output_from?: number; last?: string; log_missing?: boolean; log_removed?: boolean;
};

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).join("\n") : "";

// The command of a tool call, from its input's shape (every family's shell and
// keel__run_on carry `command` or `cmd`).
export function commandOf(input: any): string | null {
  const c = input?.command ?? input?.cmd;
  if (typeof c === "string" && c.trim()) return c;
  if (Array.isArray(c) && c.length && c.every((x) => typeof x === "string")) {
    const [sh = "", flag = "", script = ""] = c as string[];
    if (c.length === 3 && /(^|\/)(ba|z)?sh$/.test(sh) && /^-l?c$/.test(flag)) return script;
    return c.join(" ");
  }
  return null;
}

const EXIT = /(?:exit(?:ed with)? code|Exit code:?|Process exited with code)\s*(-?\d+)/i;

// What the list needs of a transcript: its commands, and how the result of
// each ended. Events never change once stored, so this is kept per session
// and only the events after `seq` are read into it: a list asked for every
// second or two does not walk the whole conversation each time.
type Call = { id: string; tool: string; command: string; description?: string; started: number; machine?: string };
type Result = { error: boolean; ts: number; code?: number; output: string; from: number };
// `chars`: the command texts and result ends held, for the bound on what is kept.
export type Commands = { seq: number; calls: Call[]; ids: Set<string>; results: Map<string, Result>; chars: number };
export const noCommands = (): Commands => ({ seq: 0, calls: [], ids: new Set(), results: new Map(), chars: 0 });
// The commands of a session are kept between lists up to this many characters
// of text. A session with more is read from its events for each list, as
// every session was before: slower for it, and nothing grows without end.
export const COMMANDS_KEPT = 4 * 1024 * 1024;

export function readCommands(c: Commands, events: StoredEvent[]): Commands {
  for (const e of events) {
    c.seq = Math.max(c.seq, e.seq);
    if (e.kind === "assistant") {
      for (const b of e.data.blocks ?? []) {
        if (b.type !== "tool_use") continue;
        const command = commandOf(b.input);
        if (command === null) continue;
        c.ids.add(b.id);
        c.chars += command.length;
        c.calls.push({ id: b.id, tool: b.name, command, description: b.input?.description, started: e.ts, machine: b.name === "keel__run_on" ? String(b.input?.machine ?? "") : undefined });
      }
    } else if (e.kind === "tool_result") {
      // A result follows its call; only a command's result is kept, and of its text the end.
      for (const r of e.data.results ?? []) {
        if (!c.ids.has(r.tool_use_id)) continue;
        const text = textOf(r.content);
        const code = text.match(EXIT)?.[1];
        const output = text.length > TAIL ? text.slice(-TAIL) : text;
        c.chars += output.length - (c.results.get(r.tool_use_id)?.output.length ?? 0);
        c.results.set(r.tool_use_id, { error: !!r.is_error, ts: e.ts, code: code === undefined ? undefined : Number(code), output, from: text.length - output.length });
      }
    }
  }
  return c;
}

// Calls and jobs joined: a job names its call; a call with no job here (a
// command of keel__run_on, or one older than its job records) stands on its result.
export function entries(c: Commands, jobs: TermJob[], live: boolean, machineOf: (callId: string) => string | undefined): TermEntry[] {
  const byCall = new Map(jobs.filter((j) => j.call_id).map((j) => [j.call_id!, j]));
  const out: TermEntry[] = [];
  const used = new Set<string>();
  for (const call of c.calls) {
    const j = byCall.get(call.id);
    if (j) used.add(j.id);
    out.push(fromJob(j, { key: call.id, call_id: call.id, tool: call.tool, command: call.command, description: call.description, started: call.started, machine: machineOf(call.id) ?? call.machine }, c.results.get(call.id), live));
  }
  for (const j of jobs) if (!used.has(j.id) && (j.by === "owner" || !j.call_id)) out.push(fromJob(j, { key: j.id, command: j.command, description: j.description, started: j.started }, undefined, live));
  return out.sort((a, b) => a.started - b.started);
}

function fromJob(j: TermJob | undefined, base: Pick<TermEntry, "key" | "command" | "started"> & Partial<TermEntry>, r: Result | undefined, live: boolean): TermEntry {
  const by = j?.by === "owner" ? "owner" : "model";
  if (j) {
    const state: TermEntry["state"] = j.running ? (j.background ? "background" : "running")
      : j.stop_reason || j.signal ? "stopped"
      : j.exit_code === 0 ? "ok"
      : j.exit_code == null && j.ended === undefined ? (r ? (r.error ? "failed" : "ok") : "stopped")
      : "failed";
    return {
      ...base, by, cwd: j.cwd, started: j.started, ended: j.ended, state, exit_code: j.exit_code, signal: j.signal,
      reason: j.stop_reason ?? (j.ended === undefined && !j.running ? "its daemon stopped before it ended" : undefined),
      job_id: j.id, pty: j.pty, bytes: j.bytes, output: j.tail, output_from: j.tail_from, last: j.last, log_missing: j.log_missing, log_removed: j.log_removed,
    };
  }
  if (!r) return { ...base, by, state: live ? "running" : "stopped", reason: live ? undefined : "it never ran, or its turn was stopped", output: "" };
  return { ...base, by, ended: r.ts, state: r.error ? "failed" : "ok", exit_code: r.code, output: r.output, output_from: r.from };
}

export const terminalRoutes: RouteModule = (deps) => {
  const { store, engine, errors } = deps;
  const spillRoot = `${store.stateDir}/spill`;
  // The commands read so far of the sessions listed last (read again from the events when dropped).
  const commands = new SessionMap<Commands>(8);
  const commandsOf = (id: string) => {
    const c = commands.get(id) ?? noCommands();
    readCommands(c, store.events(id, c.seq));
    if (c.chars > COMMANDS_KEPT) commands.delete(id);
    else commands.set(id, c);
    return c;
  };

  // The session's machine, when its tools run on one of the fleet.
  const placed = (s: Session) => (s.machine && fleet ? fleet.row(s.machine) : undefined);
  async function onPeer(s: Session, op: string, extra: Record<string, unknown> = {}, timeout?: number): Promise<any> {
    const m = placed(s)!;
    const r = await fleet!.hands(m.id, "/api/fleet/hands/terminal", { method: "POST", body: JSON.stringify({ op, session: s.id, root: m.workspace_root, ...extra }), timeout, idempotent: op !== "run" && op !== "stop" });
    const b = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || b.error) throw Object.assign(new Error(b.error ?? `HTTP ${r.status}`), { status: r.status === 200 ? 400 : r.status });
    return b;
  }
  const guard = async (f: () => Promise<Response>) => {
    try { return await f(); } catch (e) {
      if (e instanceof LinkError) return json({ error: `the session's machine does not answer: ${e.message}` }, 502);
      const st = (e as { status?: number }).status;
      if (st && st >= 400 && st < 500) return json({ error: (e as Error).message }, st);
      throw e;
    }
  };

  // After the owner ran a command: the model hears of it at its next request.
  const tell = (s: Session, j: TermJob | undefined, log: string) => {
    if (!j) return;
    addNotice(s.id, ownerNote({ ...j, tail: cleanTerm(j.tail) }, log));
  };

  return {
    "/api/sessions/:id/terminal": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        let jobs: TermJob[] = [];
        let note: string | undefined;
        if (placed(s)) {
          try { jobs = (await onPeer(s, "list")).jobs ?? []; } catch (e) {
            if (!(e instanceof LinkError)) throw e;
            note = `${placed(s)!.name} does not answer; commands are shown from the conversation only.`;
          }
        } else jobs = listJobs(spillRoot, s.id);
        const steps = fleet?.steps(s.id) ?? {};
        const list = entries(commandsOf(s.id), jobs, engine.isRunning(s.id), (c) => steps[c]?.name);
        const name = placed(s)?.name;
        if (name) for (const e of list) e.machine ??= name;
        return json({ commands: list, machine: name, note });
      }),
    },
    "/api/sessions/:id/terminal/:job/log": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const from = Number(new URL(req.url).searchParams.get("from") ?? 0);
        const r = placed(s) ? (await onPeer(s, "log", { job: req.params.job, from })).log : readJobLog(spillRoot, s.id, req.params.job, from);
        return r ? json(r) : json({ error: "no such job" }, 404);
      }),
    },
    "/api/sessions/:id/terminal/:job/stop": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const stopped = placed(s) ? (await onPeer(s, "stop", { job: req.params.job })).stopped : await stopOne(s.id, req.params.job);
        return json({ stopped });
      }),
    },
    // The owner runs a command again (or a new one) in the session's folder.
    "/api/sessions/:id/terminal/run": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        if (presence && !presence.allows(req, "terminal-run")) return json({ error: "this needs your passkey from a remote device", presence: { action: "terminal-run" } }, 428);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as { command?: string; cwd?: string };
        const command = String(b.command ?? "").trim();
        if (!command || command.length > 20_000) return json({ error: "command must be 1-20000 characters" }, 400);
        const m = placed(s);
        const root = m ? m.workspace_root! : s.workspace;
        const cwd = b.cwd ? (isAbsolute(b.cwd) ? resolve(b.cwd) : resolve(s.workspace, b.cwd)) : s.workspace;
        if (!contains(root, cwd)) return json({ error: `${cwd} is outside the session's directory` }, 400);
        if (m) {
          const r = await onPeer(s, "run", { command, cwd });
          // The far daemon runs it; this one waits for its end to tell the model.
          (async () => {
            for (let i = 0; i < 144; i++) { // 12 hours of 5-minute waits at most
              const w = await onPeer(s, "wait", { job: r.job.id }, 6 * 60_000);
              if (w.job && !w.job.running) return tell(s, w.job, `${m.name}:${w.log ?? ""}`);
            }
          })().catch((e) => { if (!(e instanceof LinkError)) errors.capture("server", e, { at: "terminal owner run", machine: m.id }); });
          return json({ job: r.job }, 201);
        }
        const job = ownerRun(spillRoot, s.id, command, cwd, (j) => tell(s, j, logPath(spillRoot, s.id, j.id)));
        return json({ job: { id: job.id, command, cwd } }, 201);
      }),
    },
  };
};
