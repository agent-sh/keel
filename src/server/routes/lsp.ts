// Diagnostics after an edit (src/lsp): the type errors and other compiler
// diagnostics an edit caused go into that edit's own result, from the
// language server of the file's project. Every family's edit tools pass
// through here, by what a call is (an edit, with the files it names), never
// by a tool's name.
//
//   GET  /api/lsp?cwd=          the servers that can serve a folder, the ones running, the settings in force
//   POST /api/lsp/restart       { id, root }: start a server again (clears a failure's pause)
//   POST /api/lsp/trust         { cwd, trusted }: the owner trusts a repository's language servers, or takes it back
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { registerSettings, settings } from "../../admin/settings.ts";
import { registerHooks, type ToolCall } from "../../engine/hooks.ts";
import { bytesPerToken, utf8Bytes } from "../../engine/compact.ts";
import type { Session, ToolResultBlock } from "../../core/types.ts";
import { BLOCK_MAX, type DiagLevel, renderDiagnostics, roomUnder } from "../../lsp/diff.ts";
import { LspManager, MAX_MEMORY_MB, MAX_SERVERS, type Perm } from "../../lsp/manager.ts";
import { checkOverrides } from "../../lsp/servers.ts";
import { classifyCall } from "../../safety/gate.ts";
import { confine, inScope, sandboxStatus } from "../../safety/sandbox.ts";
import { rootOf } from "../../safety/trust.ts";
import { toolEnv } from "../../tools/jobs.ts";
import { OUTPUT_CAP } from "../../tools/spill.ts";
import type { RouteModule } from "../app.ts";
import { tracer } from "./observe.ts";
import { gate, presence } from "./permissions.ts";
import { trustRef } from "./trust.ts";
import { readOptsFor } from "../../safety/sandbox-config.ts";
import { programPaths, sandboxScope } from "../../safety/sandbox-view.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

// `mode`: what the model is told. `workspaces`: a folder's own mode.
// `wait_ms`: how long an edit's result waits for the server (measured: the
// TypeScript 7 server answers a change in a 2,600 line file within 300 ms on
// a busy machine; five times that covers a slower server and a cold start).
// The mode is off unless the owner turns it on: a server costs 0.6 to 1.2 GB
// on a medium TypeScript repository, and what it gives is not measured on the
// owner's own work yet.
// `max_servers`, `max_memory_mb`: the servers alive at once and the memory
// they hold together, across the daemon; the least recently used ends first.
// `idle_minutes`: a server nobody edited through for this long ends (the
// TypeScript 7 server is back within a second, and holds 0.5 to 1 GB on a
// repository of 1,900 files meanwhile). `min_free_mb`: no server starts
// while the machine has less memory available (twice what one was measured
// to grow to).
const MODES = ["off", "errors", "warnings"] as const;
type Mode = (typeof MODES)[number];
export const WAIT_MS = 1500;
registerSettings(
  "diagnostics",
  { mode: "off", workspaces: {}, servers: {}, wait_ms: WAIT_MS, idle_minutes: 5, min_free_mb: 2048, max_servers: MAX_SERVERS, max_memory_mb: MAX_MEMORY_MB },
  (v) => {
    if (!MODES.includes(v.mode)) return "mode is off, errors or warnings";
    if (!v.workspaces || typeof v.workspaces !== "object" || Array.isArray(v.workspaces)) return "workspaces maps a folder to a mode";
    for (const [dir, m] of Object.entries(v.workspaces)) if (!isAbsolute(dir) || !MODES.includes(m as Mode)) return `workspaces: ${dir} is an absolute folder and its mode off, errors or warnings`;
    if (!(Number.isInteger(v.wait_ms) && v.wait_ms >= 100 && v.wait_ms <= 30_000)) return "wait_ms is a whole number of milliseconds from 100 to 30000";
    if (!(typeof v.idle_minutes === "number" && v.idle_minutes >= 1 && v.idle_minutes <= 24 * 60)) return "idle_minutes is from 1 to 1440";
    if (!(Number.isInteger(v.min_free_mb) && v.min_free_mb >= 0)) return "min_free_mb is a whole number of megabytes, 0 for no limit";
    if (!(Number.isInteger(v.max_servers) && v.max_servers >= 1 && v.max_servers <= 64)) return "max_servers is a whole number from 1 to 64";
    if (!(Number.isInteger(v.max_memory_mb) && v.max_memory_mb >= 256)) return "max_memory_mb is a whole number of megabytes, at least 256";
    return checkOverrides(v.servers);
  },
);

// The mode in force in a folder: its own, its repository's, else the owner's.
export function modeFor(workspace: string): Mode {
  const d = settings().diagnostics ?? { mode: "off", workspaces: {} };
  const root = rootOf(workspace);
  return (d.workspaces?.[workspace] ?? (root ? d.workspaces?.[root] : undefined) ?? d.mode) as Mode;
}

// Since this daemon started: what the feature did and what it cost. The same
// facts per edit are spans of the turn (kind "wait", name "diagnostics").
const stats = { edits: 0, answered: 0, timed_out: 0, with_new: 0, late: 0, errors: 0, warnings: 0, fixed: 0, tokens: 0, wait_ms: 0 };

// The files a call names, for a read as for an edit: a late answer rides on the next call on its file.
function namedPaths(call: ToolCall): string[] {
  const out: string[] = [];
  for (const k of ["file_path", "path", "notebook_path"]) {
    const v = call.input?.[k];
    if (typeof v === "string" && v) out.push(isAbsolute(v) ? v : resolve(call.tool.cwdOf?.(call.ctx, call.input) ?? call.ctx.cwd, v));
  }
  return out;
}

function append(result: ToolResultBlock, text: string) {
  if (typeof result.content === "string") result.content = result.content ? `${result.content}\n\n${text}` : text;
  else result.content = [...result.content, { type: "text", text }];
}

export let lsp: LspManager | undefined;

export const lspRoutes: RouteModule = ({ store, bus, errors, workspace }) => {
  // Under `bun --hot` this module runs again: the old servers end first.
  const g = globalThis as { __keelLsp?: LspManager; __keelLspOff?: () => void };
  g.__keelLsp?.dispose();
  g.__keelLspOff?.();
  const m = new LspManager({
    stateDir: store.stateDir,
    overrides: () => settings().diagnostics?.servers ?? {},
    get idleMs() { return (settings().diagnostics?.idle_minutes ?? 5) * 60_000; },
    minFreeMb: () => settings().diagnostics?.min_free_mb ?? 0,
    maxServers: () => settings().diagnostics?.max_servers ?? MAX_SERVERS,
    maxMemoryMb: () => settings().diagnostics?.max_memory_mb ?? MAX_MEMORY_MB,
    trusted: (dir) => trustRef?.serversTrusted(dir).trusted ?? false,
    // Where the session's own commands run: inside its sandbox when that is
    // on. A sandbox this machine cannot give is no reason to run a server
    // outside one. Confined or not, it runs in a scope of its own with a
    // memory limit and the scope's lower weights, not in the daemon's unit.
    confine: (argv, perm, ws, memoryMb, own) => {
      const limit = ["-p", `MemoryMax=${memoryMb}M`];
      if (perm.sandbox === "off") return { argv: inScope(argv, limit) };
      const st = sandboxStatus();
      if (!st.available) return { refuse: `the session's commands run in a sandbox (${perm.sandbox}) and this machine cannot give one (${st.reason}), so no language server is started outside it` };
      const opts = readOptsFor(sandboxScope(ws));
      return { argv: inScope(confine(argv, perm, ws, undefined, own ? { ...opts, read: [...(opts.read ?? []), ...programPaths(argv)] } : opts), limit) };
    },
    env: (sessionId) => toolEnv(sessionId),
    wanted: (ws) => modeFor(ws) !== "off",
    onChange: (e) => {
      if (e.what === "failed") errors.capture("server", new Error(`language server ${e.id} failed: ${e.why}`), { at: "lsp", server: e.id, root: e.root, session: e.session });
      bus.emit({ t: "feature", name: "lsp", data: { what: e.what, id: e.id, root: e.root } });
    },
  });
  lsp = g.__keelLsp = m;
  g.__keelLspOff = bus.on((f) => {
    if (f.t === "session" && (f.session.archived || f.deleted)) m.release(f.session.id);
    else if (f.t === "feature" && f.name === "perm" && f.session_id) m.permChanged(f.session_id);
  });

  const permOf = (s: Session): Perm => {
    const p = gate?.perm(s.id);
    // No gate: nothing says the session runs commands by itself.
    return { mode: p?.mode ?? "ask", sandbox: p?.sandbox ?? "off", network: p?.network ?? true };
  };
  // A session whose tools run on another machine has its files there: no server here reads them.
  const here = (s: Session, call: ToolCall) => !s.machine && !call.ctx.dispatch;

  const record = (s: Session, call: ToolCall, t0: number, o: { servers: string[]; ms: number; timed_out: boolean; cold: boolean; late: boolean; answered: number }, r: { text: string; errors: number; warnings: number; fixed: number }) => {
    const tokens = r.text ? Math.ceil(utf8Bytes(r.text) / bytesPerToken(s.model)) : 0;
    if (!o.late) { stats.edits++; stats.wait_ms += o.ms; if (o.timed_out) stats.timed_out++; else stats.answered++; }
    else stats.late++;
    if (r.errors || r.warnings) stats.with_new++;
    stats.errors += r.errors; stats.warnings += r.warnings; stats.fixed += r.fixed; stats.tokens += tokens;
    tracer?.waited(s.id, "diagnostics", t0, t0 + o.ms, {
      call_id: call.id, tool: call.tool.name, server: o.servers.join(","), ms: o.ms, timed_out: o.timed_out, cold: o.cold, late: o.late,
      files: o.answered, count: r.errors + r.warnings, errors: r.errors, warnings: r.warnings, fixed: r.fixed, tokens,
    });
  };

  registerHooks({
    async beforeTool(s, call) {
      try {
        if (modeFor(s.workspace) === "off" || !here(s, call)) return;
        const cls = classifyCall(call);
        if (cls.kind !== "edit") return;
        await m.before(s, permOf(s), call.id, cls.paths);
      } catch (e) {
        errors.capture("server", e, { at: "diagnostics before an edit", session: s.id, tool: call.tool.name });
      }
    },
    toolFailed(_s, call) { m.drop(call.id); },
    async afterTool(s, call, result) {
      try {
        const mode = modeFor(s.workspace);
        if (mode === "off" || !here(s, call)) return void m.drop(call.id);
        const level: DiagLevel = mode === "warnings" ? "warnings" : "errors";
        // The result stays under its cap with the block in it: what it has left is the block's room.
        let room = roomUnder(result.content, call.tool.resultCap ?? OUTPUT_CAP);
        const add = (text: string) => { if (text) { append(result, text); room -= utf8Bytes(text) + 2; } };
        const cls = classifyCall(call);
        if (cls.kind !== "edit") {
          m.drop(call.id);
          // A command may have changed files a server holds a copy of.
          if (cls.kind !== "read" && cls.kind !== "control") m.markStale(s.workspace);
          // A late answer goes with the next call on its file, when that result has room for it.
          if (!m.hasLate(s.id) || room < BLOCK_MAX) return;
          const late = m.takeLate(s, namedPaths(call));
          if (!late.files.length && !late.clean.length) return;
          const r = renderDiagnostics(late.files, { server: late.servers.join(", "), level, late: true, clean: late.clean, room });
          record(s, call, Date.now(), { servers: late.servers, ms: 0, timed_out: false, cold: false, late: true, answered: late.files.length + late.clean.length }, r);
          return add(r.text);
        }
        // An edit that failed changed nothing.
        if (result.is_error) return void m.drop(call.id);
        const t0 = Date.now();
        // A result with no room for a block (a patch of hundreds of files) is not waited on: the answers go with a later result.
        if (room < BLOCK_MAX) return void (await m.after(s, call.id, 0, true));
        const out = await m.after(s, call.id, settings().diagnostics?.wait_ms ?? WAIT_MS);
        // What an earlier edit's late answer found comes first: it is older.
        const late = m.hasLate(s.id) && room >= 2 * BLOCK_MAX ? m.takeLate(s) : { files: [], clean: [], servers: [] };
        if (late.files.length || late.clean.length) {
          const r = renderDiagnostics(late.files, { server: late.servers.join(", "), level, late: true, clean: late.clean, room });
          record(s, call, t0, { servers: late.servers, ms: 0, timed_out: false, cold: false, late: true, answered: late.files.length + late.clean.length }, r);
          add(r.text);
        }
        if (!out) return;
        const r = renderDiagnostics(out.files, { server: out.servers.join(", "), level, pending: out.pending, unchecked: out.unchecked, room });
        record(s, call, t0, { servers: out.servers, ms: out.ms, timed_out: out.pending.length > 0, cold: out.cold, late: false, answered: out.answered }, r);
        add(r.text);
      } catch (e) {
        m.drop(call.id);
        errors.capture("server", e, { at: "diagnostics after an edit", session: s.id, tool: call.tool.name });
      }
    },
  });

  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  const dirOf = (raw: string | null | undefined) => {
    const cwd = resolve(raw || workspace);
    return existsSync(cwd) && statSync(cwd).isDirectory() ? cwd : null;
  };
  // Reading the page changes nothing: no trust is written by asking.
  const view = (cwd: string) => {
    const d = settings().diagnostics;
    const trust = trustRef?.serversTrusted(cwd) ?? { root: rootOf(cwd) ?? cwd, trusted: false };
    return {
      cwd, mode: d.mode, workspace_mode: d.workspaces?.[cwd] ?? d.workspaces?.[trust.root] ?? null, in_force: modeFor(cwd),
      wait_ms: d.wait_ms, idle_minutes: d.idle_minutes, trust,
      sandbox: sandboxStatus().available, servers: m.list(cwd), totals: m.totals(), stats: { ...stats },
    };
  };

  return {
    "/api/lsp": {
      GET: (req: Request) => {
        const cwd = dirOf(new URL(req.url).searchParams.get("cwd"));
        return cwd ? json(view(cwd)) : bad("cwd is not a directory");
      },
    },
    "/api/lsp/restart": {
      POST: async (req: Request) => {
        const b = await body(req);
        if (typeof b.id !== "string" || typeof b.root !== "string") return bad("id and root name the server");
        return json({ stopped: await m.restart(b.id, b.root) });
      },
    },
    "/api/lsp/trust": {
      POST: async (req: Request) => {
        // From a remote device, trusting a repository's programs takes the owner's passkey.
        if (presence && !presence.allows(req, "trust")) return json({ error: "this needs your passkey from a remote device", presence: { action: "trust" } }, 428);
        const b = await body(req);
        const cwd = dirOf(b.cwd);
        if (!cwd) return bad("cwd is not a directory");
        if (!trustRef) return bad("trust is not available on this daemon", 503);
        const t = trustRef.trustServers(cwd, b.trusted !== false);
        // What ran or waited under the old answer starts over under the new one.
        for (const s of m.list(cwd)) for (const r of s.running) await m.restart(s.id, r.root);
        bus.emit({ t: "feature", name: "lsp", data: { what: "trust", root: t.root } });
        return json(view(cwd));
      },
    },
  };
};
