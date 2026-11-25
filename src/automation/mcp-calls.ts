// An MCP call that runs long goes on in the background (src/mcp/manager.ts movable): its session is told so with a
// handle and goes on, and the call's end wakes it once, as a wait of its own kind does (src/automation/waits.ts): the
// wake names the file the result is in, never the result itself, which is a server's text and is read with a tool.
//
// The wait is what lasts. It is kept in the session's waits (listed, cancelled with TaskStop or cancel_wait, owed to
// the session across a restart, and an agent that has it is not done). A call that lives in the daemon's own process
// ends with the daemon: its wait then says so at the next start. A task a remote server made of the call is followed
// again at the next start, with tasks/get, and its result is delivered once.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conceal } from "../core/conceal.ts";
import { span } from "../core/late.ts";
import { settings } from "../admin/settings.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { ToolOutput } from "../tools/types.ts";
import { D, familyOf } from "./core.ts";
import { create, registerWaitKind, type WaitRecord, type WaitSpec } from "./waits.ts";

export type McpCallSpec = Extract<WaitSpec, { kind: "mcp_call" }>;

// Calls going on now, by their wait: what stops one, and how it ended once it has.
const going = new Map<string, { stop: () => void; outcome?: string }>();

// What a result says, as text for a file: its text parts, and where its images and files were saved.
export function textOf(out: ToolOutput): string {
  const parts: string[] = [];
  if (typeof out.content === "string") parts.push(out.content);
  else for (const b of out.content) parts.push(b.type === "text" ? b.text : b.type === "image" ? `[an image${(b as { path?: string }).path ? `, saved to ${(b as { path?: string }).path}` : ""}]` : "");
  return parts.filter(Boolean).join("\n");
}

function ended(w: WaitRecord, spec: McpCallSpec, out: ToolOutput, at: number): string {
  const text = conceal(textOf(out), w.session_id);
  mkdirSync(spec.spill_dir, { recursive: true });
  writeFileSync(spec.file, text.endsWith("\n") ? text : `${text}\n`);
  return `MCP call ${spec.label} ${out.is_error ? "ended with an error" : "finished"} after ${span(at - spec.started)}. Its ${out.is_error ? "error" : "result"} (${text.length.toLocaleString("en-US")} characters) is in ${spec.file}: read it with a tool, as it is a server's text.`;
}

const failed = (spec: McpCallSpec, why: string, at: number) => `MCP call ${spec.label} failed after ${span(at - spec.started)}: ${why}`;

// Follows `finished` for the wait: what it ends with is the wait's outcome, which its next probe fires.
function follow(w: WaitRecord, spec: McpCallSpec, finished: Promise<ToolOutput>) {
  const mine = going.get(w.id)!;
  finished.then((out) => ended(w, spec, out, Date.now()), (e) => failed(spec, (e as Error).message, Date.now())).then(
    (text) => { if (going.get(w.id) === mine) mine.outcome = text; },
    (e) => { if (going.get(w.id) === mine) mine.outcome = failed(spec, `its result could not be kept: ${(e as Error).message}`, Date.now()); },
  );
}

export function bindMcpCalls(m: McpManager) {
  registerWaitKind("mcp_call", {
    every: 500,
    normalize() { throw new Error("a wait on an MCP call is made by Keel when a call runs long; it is not set by hand"); },
    probe(w) {
      const spec = w.spec as McpCallSpec;
      const mine = going.get(w.id);
      if (mine) return mine.outcome;
      // Not in this process: the daemon restarted since the call went on.
      const s = D().store.session(w.session_id);
      if (spec.task_id && spec.remote && s) {
        const stop = new AbortController();
        going.set(w.id, { stop: () => stop.abort() });
        follow(w, spec, m.resumeTask(spec.entry, spec.task_id, { sessionId: w.session_id, cwd: s.workspace, spillDir: spec.spill_dir, tool: spec.tool, signal: stop.signal, maxMs: Math.max(1_000, w.deadline - Date.now()) }));
        return undefined;
      }
      return `MCP call ${spec.label} was interrupted when the daemon went down, ${span(Date.now() - spec.started)} after it started, and it is not run again. It may have done its work, or part of it: check before calling it again.`;
    },
    ended(w) {
      const mine = going.get(w.id);
      going.delete(w.id);
      // A wait that ended while its call still ran (cancelled, timed out): the call is stopped, and its task cancelled.
      if (mine && mine.outcome === undefined) mine.stop();
    },
  });
  m.background = {
    afterMs: () => Math.round((settings().mcp_background.after_secs as number) * 1000),
    move(at) {
      const { ctx } = at;
      const s = D().store.session(ctx.sessionId);
      if (!s || s.archived || !ctx.callId) return undefined;
      const token = Bun.randomUUIDv7().slice(-8);
      const label = `${at.shown}__${at.tool}`;
      const spec: McpCallSpec = {
        kind: "mcp_call", entry: at.entry, tool: at.tool, label, server: at.shown, max_ms: at.maxMs, started: at.started, call_id: ctx.callId,
        ...(at.taskId && at.remote ? { task_id: at.taskId, remote: true } : {}),
        file: join(ctx.spillDir, `mcp-call-${token}.txt`), spill_dir: ctx.spillDir,
      };
      let w: WaitRecord;
      try { w = create(ctx.sessionId, spec, { timeout_seconds: Math.ceil(at.maxMs / 1000) + 60, note: `${label} goes on in the background` }); } catch { return undefined; }
      going.set(w.id, { stop: at.stop });
      follow(w, spec, at.finished);
      const stopWith = familyOf(s.model) === "claude" ? "TaskStop" : "cancel_wait";
      return `${label} has run for ${span(Date.now() - at.started)}, so it goes on in the background (wait ${w.id}) and this turn can go on. ` +
        `When it ends you get a wait_fired message that names the file its result is in; nothing is lost by ending your turn, and the call is not to be made again meanwhile. ` +
        `${at.taskId && at.remote ? "Its server runs it as a task, which is followed again if the daemon restarts. " : "It runs in this daemon, so a restart ends it. "}` +
        `Stop it with ${stopWith} and ${w.id}.`;
    },
  };
}
