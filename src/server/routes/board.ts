// The board: every live session by what it needs from the owner. One row per
// top-level session with its state (needs you, working, done), why it needs
// him, and its latest activity in one line, so the page can show many sessions
// without loading their transcripts.
import { pendingQuestions } from "../../tools/interact.ts";
import type { RouteModule } from "../app.ts";
import { gate } from "./permissions.ts";

export type BoardState = "needs" | "working" | "done";
export type BoardRow = {
  id: string;
  title: string;
  workspace: string;
  model: string;
  updated: number;
  state: BoardState;
  needs?: { kind: "approval" | "question" | "error"; text: string; count: number };
  activity?: { text: string; ts: number; kind: "tool" | "reply" | "prompt" | "error" };
  turns: number;
};

const ONE_LINE = 160;
const line = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > ONE_LINE ? `${t.slice(0, ONE_LINE - 1)}…` : t;
};

// What a tool call is doing, in a few words.
function toolLine(name: string, input: any): string {
  const arg = input?.description ?? input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.query ?? input?.url ?? input?.prompt;
  return line(arg ? `${name} ${typeof arg === "string" ? arg : JSON.stringify(arg)}` : name);
}

export const boardRoutes: RouteModule = ({ store }) => {
  const lastOf = store.db.query<{ kind: string; data: string; ts: number }, [string]>(
    "SELECT kind, data, ts FROM events WHERE session_id = ? AND kind IN ('user', 'assistant', 'error') ORDER BY seq DESC LIMIT 1",
  );
  const turnsOf = store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE session_id = ? AND kind = 'turn_end'");

  const activity = (id: string): BoardRow["activity"] => {
    const e = lastOf.get(id);
    if (!e) return undefined;
    const d = JSON.parse(e.data);
    if (e.kind === "error") return { kind: "error", text: line(d.message ?? "failed"), ts: e.ts };
    if (e.kind === "user") return { kind: "prompt", text: line(d.text ?? ""), ts: e.ts };
    const blocks: any[] = d.blocks ?? [];
    const tool = [...blocks].reverse().find((b) => b.type === "tool_use");
    if (tool) return { kind: "tool", text: toolLine(tool.name, tool.input), ts: e.ts };
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    return text.trim() ? { kind: "reply", text: line(text), ts: e.ts } : undefined;
  };

  const rows = (): BoardRow[] => {
    const all = store.sessions();
    const pending = gate?.approvals({ pending: true }) ?? [];
    const byParent = new Map<string, string>();
    for (const s of all) if (s.parent_id) byParent.set(s.id, s.parent_id);
    const top = (id: string) => { let cur = id; for (let i = 0; i < 8 && byParent.has(cur); i++) cur = byParent.get(cur)!; return cur; };
    const asks = new Map<string, { summary: string; n: number; child: boolean }>();
    for (const a of pending) {
      const t = top(a.session_id);
      const cur = asks.get(t);
      asks.set(t, { summary: cur?.summary ?? a.summary, n: (cur?.n ?? 0) + 1, child: cur?.child ?? t !== a.session_id });
    }
    return all.filter((s) => !s.parent_id).map((s) => {
      const ask = asks.get(s.id);
      const questions = pendingQuestions(s.id).length;
      const act = activity(s.id);
      let needs: BoardRow["needs"];
      if (ask) needs = { kind: "approval", count: ask.n, text: line(`${ask.child ? "A subagent asks to run" : "Asks to run"}: ${ask.summary}`) };
      else if (questions) needs = { kind: "question", count: questions, text: "Waits for your answer" };
      else if (s.phase === "error") needs = { kind: "error", count: 1, text: act?.kind === "error" ? act.text : "The last turn failed" };
      const state: BoardState = needs ? "needs" : s.phase === "working" ? "working" : "done";
      return { id: s.id, title: s.title, workspace: s.workspace, model: s.model, updated: s.updated, state, needs, activity: act, turns: turnsOf.get(s.id)!.n };
    }).sort((a, b) => b.updated - a.updated);
  };

  return {
    "/api/board": { GET: () => Response.json({ rows: rows() }) },
  };
};
