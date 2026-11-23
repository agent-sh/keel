// The calling side of peer hands: one tool call sent to a machine's daemon over
// the paired link, recorded as a step on that machine for the transcript.
import { isAbsolute, resolve } from "node:path";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import type { MachineRow } from "./db.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError } from "./link.ts";
import { vault } from "../safety/secrets.ts";
import { whoOf } from "../tools/heavy.ts";

// What is sent to another machine names a secret, never holds its value: that
// machine puts back one it holds under the same name, or refuses by name.
function placeholders<T>(m: MachineRow, input: T, sessionId: string): { value: T } | { refused: ToolOutput } {
  const r = vault.forPeer(input, sessionId);
  return "error" in r ? { refused: { content: `Error [SECRET_NOT_SENT]: nothing ran on ${m.name}: ${r.error}.`, is_error: true } } : { value: r.value };
}

// A remote tool is bounded by its own timeout there; the link waits as long as
// the call may run (the longest shell timeout a family allows is 10 minutes;
// background jobs return at once) plus a margin. Interrupt aborts it.
const CALL_MS = 15 * 60_000;

export async function remoteRun(
  fleet: Fleet,
  m: MachineRow,
  ctx: ToolContext,
  call: { tool: string; input: any; cwd?: string; sandbox?: boolean },
): Promise<ToolOutput> {
  const root = m.workspace_root!;
  const cwd = call.cwd ? (isAbsolute(call.cwd) ? call.cwd : resolve(root, call.cwd)) : root;
  const p0 = placeholders(m, call.input, ctx.sessionId);
  if ("refused" in p0) return p0.refused;
  const input = p0.value;
  fleet.step(ctx.sessionId, ctx.callId, m.id);
  // Detached there: a dropped link does not stop it, the same call id asked
  // again reattaches to it, and only Interrupt (a cancel) ends it.
  const callId = ctx.callId ?? crypto.randomUUID();
  const cancel = () => { fleet.hands(m.id, "/api/fleet/hands/cancel", { method: "POST", body: JSON.stringify({ session: ctx.sessionId, call: callId }) }).catch(() => {}); };
  ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    const r = await fleet.hands(m.id, "/api/fleet/hands", {
      method: "POST",
      body: JSON.stringify({ session: ctx.sessionId, call: callId, detach: true, tool: call.tool, input, cwd, root, sandbox: !!call.sandbox, who: whoOf(ctx) }),
      signal: ctx.signal,
      timeout: CALL_MS,
      retryMs: CALL_MS,
    });
    const body = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) return { content: `Error [PEER]: ${m.name} answered: ${body.error ?? `HTTP ${r.status}`}`, is_error: true };
    return { content: body.content ?? "", is_error: body.is_error };
  } catch (e) {
    if (ctx.signal.aborted) return { content: "Interrupted.", is_error: true };
    if (!(e instanceof LinkError)) throw e;
    return { content: `Error [PEER_UNREACHABLE]: ${m.name}: ${(e as Error).message}. Nothing ran there, or its result was lost; check before retrying.`, is_error: true };
  } finally {
    ctx.signal.removeEventListener("abort", cancel);
  }
}

// One command on a machine, with no tool state (keel__run_on): its own shell,
// started in the directory asked for, bounded like a shell call, and confined
// there as the session's own shell commands are confined here.
export async function remoteExec(fleet: Fleet, m: MachineRow, ctx: ToolContext, command: string, cwdIn?: string): Promise<ToolOutput> {
  const root = m.workspace_root!;
  const cwd = cwdIn ? (isAbsolute(cwdIn) ? cwdIn : resolve(root, cwdIn)) : root;
  const p0 = placeholders(m, { script: command, cwd }, ctx.sessionId);
  if ("refused" in p0) return p0.refused;
  const sent = p0.value;
  fleet.step(ctx.sessionId, ctx.callId, m.id);
  try {
    const r = await fleet.hands(m.id, "/api/fleet/hands/exec", { method: "POST", body: JSON.stringify({ script: sent.script, cwd: sent.cwd, root, confined: ctx.confined, session: ctx.sessionId, who: whoOf(ctx) }), signal: ctx.signal, timeout: CALL_MS });
    const b = (await r.json().catch(() => ({}))) as { code?: number; out?: string; error?: string };
    if (!r.ok || b.error) return { content: `Error [PEER]: ${m.name} answered: ${b.error ?? `HTTP ${r.status}`}`, is_error: true };
    const out = (b.out ?? "").trimEnd();
    return { content: `${out || "(no output)"}${b.code ? `\nExit code ${b.code}` : ""}`, is_error: !!b.code };
  } catch (e) {
    if (ctx.signal.aborted) return { content: "Interrupted.", is_error: true };
    if (!(e instanceof LinkError)) throw e;
    return { content: `Error [PEER_UNREACHABLE]: ${m.name}: ${(e as Error).message}. It may or may not have run there; check before retrying.`, is_error: true };
  }
}
