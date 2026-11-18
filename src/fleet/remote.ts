// The calling side of peer hands: one tool call sent to a machine's daemon over
// the paired link, recorded as a step on that machine for the transcript.
import { isAbsolute, resolve } from "node:path";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import type { MachineRow } from "./db.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError, linkFetch } from "./link.ts";

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
  fleet.step(ctx.sessionId, ctx.callId, m.id);
  try {
    const p = await fleet.peer(m.id);
    const r = await linkFetch(p, "/api/fleet/hands", {
      method: "POST",
      body: JSON.stringify({ session: ctx.sessionId, tool: call.tool, input: call.input, cwd, root, sandbox: !!call.sandbox }),
      signal: ctx.signal,
      timeout: CALL_MS,
    });
    const body = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) return { content: `Error [PEER]: ${m.name} answered: ${body.error ?? `HTTP ${r.status}`}`, is_error: true };
    return { content: body.content ?? "", is_error: body.is_error };
  } catch (e) {
    if (ctx.signal.aborted) return { content: "Interrupted.", is_error: true };
    if (!(e instanceof LinkError)) throw e;
    return { content: `Error [PEER_UNREACHABLE]: ${m.name}: ${(e as Error).message}. Nothing ran there, or its result was lost; check before retrying.`, is_error: true };
  }
}
