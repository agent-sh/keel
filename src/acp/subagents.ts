// Keel's agent tree as ACP child sessions (docs/protocol/v1/subagents.mdx):
// what the bridge sends for an agent, as pure functions of what the daemon
// says of it. A child is announced with `subagent_update` on its parent's
// session; its own work goes under its own sessionId. Only for a client that
// advertised `clientCapabilities.subagents`.
import { dirname, isAbsolute } from "node:path";
import { INPUT_LABEL, inputKind } from "../core/inputs.ts";
import { contains } from "../core/paths.ts";
import { globBase } from "../safety/own-places.ts";

type Json = any;

// What the bridge reads of an agent: the record's frame (AgentBrief), the fields it uses.
export type AgentSeen = {
  id: string;
  parent_id: string;
  session_id: string;
  title: string;
  status: string; // running, waiting, completed, incomplete, failed, stopped
  end_reason?: string | null;
  worktree?: string | null;
  machine?: string | null;
  first_seq?: number;
  call_id?: string | null; // the parent's call that started it
  writes?: string | null; // its write scope as kept (src/automation/write-asks.ts): `{ places: [{ path, glob? }] }`
};

export const isLive = (a: Pick<AgentSeen, "status">) => a.status === "running" || a.status === "waiting";

// Keel's turn-end words as ACP stop reasons.
const STOP: Record<string, string> = { max_tokens: "max_tokens", refusal: "refusal", max_steps: "max_turn_requests", budget: "max_turn_requests" };

// The child's foreground state. `asking`: one of its calls waits on the owner's answer.
// An agent that waits on a wait of its own (a timer, its own agents) has no
// foreground work now and goes on by itself: idle with no stop reason.
export function agentState(a: Pick<AgentSeen, "status" | "end_reason">, asking = false): Json {
  if (a.status === "running") return asking ? { state: "requires_action" } : { state: "running" };
  if (a.status === "waiting") return asking ? { state: "requires_action" } : { state: "idle" };
  if (a.status === "stopped") return { state: "idle", stopReason: "cancelled" };
  if (a.status === "failed") return { state: "idle", stopReason: "error", error: { code: -32603, message: a.end_reason ? `the agent failed (${a.end_reason})` : "the agent failed" } };
  if (a.status === "incomplete") return { state: "idle", stopReason: STOP[a.end_reason ?? ""] ?? "end_turn" };
  return { state: "idle", stopReason: "end_turn" };
}

// Where a child works, as `cwd` and `additionalDirectories` (subagents.mdx,
// Working directories): a field left out is inherited from its parent.
// Its own worktree here is its folder. One on another machine works in its
// session's folder there (`workspace`, read from the daemon): it never shares
// the parent's. Either keeps none of the parent's other folders. The places
// its write scope names beyond its folder are its other folders, each as the
// folder that holds it (`dirOf`: a file's folder; the bridge looks on disk).
export type Dirs = { cwd?: string; additionalDirectories?: string[] };
export function childDirs(a: Pick<AgentSeen, "worktree" | "machine" | "writes">, o: { workspace?: string; dirOf?: (p: string) => string } = {}): Dirs {
  const cwd = a.machine ? o.workspace : a.worktree ?? undefined;
  const extra = a.machine ? [] : scopeDirs(a.writes, o.dirOf ?? dirname).filter((d) => !cwd || !contains(cwd, d));
  if (cwd) return { cwd, additionalDirectories: extra };
  return extra.length ? { additionalDirectories: extra } : {};
}
// The folders a kept write scope names, each once, none inside another.
export function scopeDirs(writes: string | null | undefined, dirOf: (p: string) => string): string[] {
  let places: { path?: unknown; glob?: unknown }[] = [];
  try { places = writes ? JSON.parse(writes)?.places ?? [] : []; } catch {}
  const dirs = [...new Set((Array.isArray(places) ? places : [])
    .filter((x) => typeof x?.path === "string" && isAbsolute(x.path))
    .map((x) => (x.glob ? globBase(String(x.path)) : dirOf(String(x.path)))))];
  return dirs.filter((d) => !dirs.some((o) => o !== d && contains(o, d)));
}

// The parent's `subagent_update` for one agent: every field the bridge knows,
// so each update is the child's whole label and state (a patch that leaves
// nothing stale). `cancel` while it works or waits: a stop then means something.
export function subagentUpdate(a: AgentSeen, o: { description?: string; asking?: boolean; dirs?: Dirs } = {}): Json {
  return {
    sessionUpdate: "subagent_update",
    sessionId: a.session_id,
    title: a.title || "Agent",
    ...(o.description ? { description: o.description } : {}),
    capabilities: isLive(a) ? { cancel: {} } : {},
    state: agentState(a, o.asking),
    ...(o.dirs ?? childDirs(a)),
  };
}

// The task's first line, for the child's description: from the spawn call's
// input (`prompt` of Agent, `message` of spawn_agent) or the task as stored.
export const TASK_LINE = 200;
export function taskLine(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > TASK_LINE ? line.slice(0, TASK_LINE - 1) + "…" : line;
}
export const spawnTask = (input: Json): string | undefined => taskLine(input?.prompt ?? input?.message ?? input?.task);

// A stored input of a child's session as the update in its own transcript.
// Its parent's task and messages are messages from the parent session
// (`session_message`, never a user message); a peer's names its sender when
// the bridge knows that agent's session, and no sender otherwise; the
// harness's own inputs (a report of the child's own agents, a wake) are said
// as the parent's replay says them; the owner's own words typed in the
// child's page are the user's.
export function childInput(e: { id: string; data: Json }, child: string, parent: string, peerSession?: (agentId: string) => string | undefined): Json[] {
  const d = e.data ?? {};
  const fromTree = d.kind === "task" || (d.kind === "steer" && typeof d.agent_id === "string");
  if (fromTree) {
    const sender = d.from_agent ? peerSession?.(String(d.from_agent)) : parent;
    return [{
      sessionUpdate: "session_message", messageId: e.id, recipientSessionId: child,
      ...(sender ? { senderSessionId: sender } : {}),
      content: [{ type: "text", text: String(d.text ?? "") }],
    }];
  }
  const input = inputKind(d);
  if (input) return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[${INPUT_LABEL[input]}]\n\n${d.text ?? ""}` }, _meta: { keel: { input } } }];
  return d.text ? [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: String(d.text) } }] : [];
}
