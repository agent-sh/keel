// What a rewind cannot take back (src/safety/not-undone.ts) and the agents the rewound turns started, for the
// rewind dialog's preview and the Changes panel's by-turn list. The stored calls are read and judged on the read
// thread; the loop asks git which of the folder's paths a snapshot never held, and the daemon's own records for
// the agents. No model is asked.
//
// What is said of a turn that ended never changes: it is kept for the session (the events after it are the only
// ones read again), the way a turn's changed files are in the checkpoints.
import { join } from "node:path";
import * as agents from "../../automation/agents.ts";
import { rootSession } from "../../automation/agents.ts";
import { workBoard } from "./board.ts";
import { ignoredLine, type Touched, type Undone } from "../../safety/not-undone.ts";
import type { Checkpoints } from "../../safety/checkpoints.ts";
import { toolFacts } from "../../tools/registry.ts";
import { RUN_CODE } from "../../tools/codemode.ts";
import { catalogReady } from "../../tools/catalog.ts";
import type { Store } from "../../core/store.ts";
import type { Session } from "../../core/types.ts";
import { readsOf } from "../reads.ts";
import { gate } from "./permissions.ts";

// What the page says of a line: where it came from and in which turn.
export type NotUndone = { kind: Undone["kind"]; line: string; turn: number; n: number; call: string; tool: string };
// An agent a rewound turn started, as the owner needs it to choose: whether it still works, where its work is, whether it landed.
export type StartedAgent = {
  id: string; title: string; status: string; stopped_by: string | null; end_reason: string | null; running: boolean;
  worktree: string | null; branch: string | null; landed: "yes" | "no" | "nothing" | "unknown" | null; ahead: number | null; head: string | null;
  uncommitted: boolean | null; turn: number; n: number; call: string;
};

type Kept = { workspace: string; from: number; through: number; items: Undone[]; touched: Touched[]; held: Map<string, boolean> };

export function rewindReach(store: Store, c: Checkpoints) {
  const kept = new Map<string, Kept>();

  // Every item of the session's calls from `from` (a turn's start) on, with the candidates resolved against the folder's ignore files.
  async function ledger(s: Session, from: number): Promise<{ items: Undone[]; truncated: boolean }> {
    if (s.machine || !gate) return { items: [], truncated: false };
    let k = kept.get(s.id);
    if (k && (k.workspace !== s.workspace || k.from > from)) k = undefined;
    const spawned = store.db.query<{ call_id: string }, [string]>("SELECT call_id FROM agents WHERE parent_id = ? AND call_id IS NOT NULL").all(s.id).map((r) => r.call_id);
    // The session's MCP tools as they are known now, without waiting on a connection.
    const mcp = await Promise.race([catalogReady(undefined, s.id), new Promise<[]>((r) => setTimeout(() => r([]), 50))]).catch(() => []);
    const got = await readsOf(store).run("rewind.ledger", {
      session: s.id, ...gate.markFacts(s), tools: toolFacts(), runCode: RUN_CODE, mcpCall: "mcp_call",
      mcp: mcp.map((t) => ({ qualified: t.qualified, name: t.name, readOnly: !!t.readOnly, hinted: !!t.hinted_read })),
      jobs: join(store.stateDir, "spill", s.id, "jobs"), spawned, from: k ? k.through + 1 : from,
    });
    const before = k?.items ?? [], touchedBefore = k?.touched ?? [];
    const items = [...before, ...got.items], touched = [...touchedBefore, ...got.touched];
    const held = k?.held ?? new Map<string, boolean>();
    const fresh = [...new Set(touched.map((t) => t.path))].filter((p) => !held.has(p)).slice(0, 400);
    if (fresh.length) {
      const ignored = await c.shadow(s.workspace).ignored(fresh).catch(() => new Set<string>());
      for (const p of fresh) held.set(p, ignored.has(p));
    }
    // What a turn that ended says is kept (what a live turn says is read again).
    const entry: Kept = { workspace: s.workspace, from: k?.from ?? from, through: Math.max(got.through, k?.through ?? 0), items: items.filter((i) => i.seq <= got.through || i.seq <= (k?.through ?? 0)), touched: touched.filter((t) => t.seq <= got.through || t.seq <= (k?.through ?? 0)), held };
    kept.set(s.id, entry);
    if (kept.size > 24) kept.delete(kept.keys().next().value!);
    const own = touched.filter((t) => held.get(t.path)).map((t): Undone => ({ n: t.n, turn: t.turn, seq: t.seq, call: t.call, tool: t.tool, kind: "ignored", line: ignoredLine(t) }));
    return { items: [...items, ...own].sort((a, b) => a.seq - b.seq), truncated: got.more };
  }

  // The first turn a rewind of the session's files can reach back to: where its checkpoints start.
  const first = (s: Session): number | undefined => c.list(s.id).find((x) => x.at === "start")?.turn;

  // Agents, as the daemon's records and the work board say them now.
  async function startedBy(s: Session, items: Undone[]): Promise<StartedAgent[]> {
    const spawns = items.filter((i) => i.kind === "agent");
    if (!spawns.length) return [];
    const recs = new Map(agents.list(s.id).map((a) => [a.call_id ?? "", a]));
    const board = await workBoard()?.read(rootSession(s.id)).catch(() => undefined);
    const rows = new Map((board?.rows ?? []).map((r) => [r.id, r]));
    const out: StartedAgent[] = [];
    for (const i of spawns) {
      const a = recs.get(i.call);
      if (!a) continue;
      const r = rows.get(a.id);
      out.push({
        id: a.id, title: a.title, status: a.status, stopped_by: a.stopped_by ?? null, end_reason: a.end_reason ?? null,
        running: a.status === "running" || a.status === "waiting",
        worktree: a.worktree ?? null, branch: a.branch ?? null,
        landed: a.branch ? (r?.landed?.state ?? "unknown") : null, ahead: r?.ahead ?? null, head: r?.head ?? null,
        uncommitted: r?.work ? !!r.work.uncommitted : null,
        turn: i.turn, n: i.n, call: i.call,
      });
    }
    return out;
  }

  const brief = (i: Undone): NotUndone => ({ kind: i.kind, line: i.line, turn: i.turn, n: i.n, call: i.call, tool: i.tool });

  return {
    // The by-turn list: each turn's lines (its agents are the rewind dialog's).
    async byTurn(s: Session, nOf: (turn: number) => number | undefined): Promise<Map<number, NotUndone[]>> {
      const out = new Map<number, NotUndone[]>();
      const from = first(s);
      if (from === undefined) return out;
      const { items } = await ledger(s, from);
      const push = (turn: number, x: NotUndone) => out.set(turn, [...(out.get(turn) ?? []), x]);
      for (const i of items) if (i.kind !== "agent") push(i.turn, brief(i));
      for (const l of c.leftOut(s, from)) push(l.turn, { kind: "skipped", line: `${l.path} grew past the size cap, so the checkpoint left it out`, turn: l.turn, n: nOf(l.turn) ?? 0, call: "", tool: "" });
      return out;
    },
    // A rewind to before a prompt (the event's place in the history): what the turns after it did that it cannot take back, and the agents they started.
    async fromPrompt(s: Session, seq: number): Promise<{ not_undone: NotUndone[]; agents: StartedAgent[] }> {
      // (From the prompt at the latest: a turn that only started agents has no checkpoint, and its agents count.)
      const { items } = await ledger(s, Math.min(first(s) ?? seq, seq));
      const after = items.filter((i) => i.turn > seq);
      const agentsOf = await startedBy(s, after);
      const gone = (k: number) => store.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM events INDEXED BY events_bare WHERE session_id = ? AND kind = 'turn_start' AND seq <= ?").get(s.id, k)?.n;
      const lines = after.filter((i) => i.kind !== "agent").map(brief);
      for (const l of c.leftOut(s, seq)) lines.push({ kind: "skipped", line: `${l.path} grew past the size cap, so the checkpoint left it out`, turn: l.turn, n: gone(l.turn) ?? 0, call: "", tool: "" });
      return { not_undone: lines, agents: agentsOf };
    },
  };
}
