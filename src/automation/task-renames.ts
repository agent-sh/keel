import * as goals from "./goals.ts";
import type { Task, TaskStatus } from "./goals.ts";

// A row the owner renamed keeps its identity through a plan the model wrote
// before it was told. The model's plan names rows by their text, so a plan
// still in flight when the owner renames "A" to "B" says "A": read as it
// stands it would add "A" again beside "B". Until the model is told of the
// owner's changes, such a plan is read with the row's new words.
//
// Kept in memory: a plan in flight belongs to a running turn, and a turn the
// daemon's stop cut is told of the owner's changes before its next request.

type Renamed = { from: string; to: string; pos: number }; // from: the words the model's plan still has
const renames = new Map<string, Map<string, Renamed>>(); // session -> task id

// The owner's edit of a row (the panel's PATCH), with a change of its words
// remembered. Its words and its status only: the session a row was taken into
// is set by the launch alone (task-out.ts), never named by a request.
export function edit(sessionId: string, id: string, p: { text?: string; status?: TaskStatus; was?: string }): Task {
  const before = goals.tasks(sessionId).find((t) => t.id === id);
  const after = goals.editTask(sessionId, id, { text: p.text, status: p.status, was: p.was });
  if (before && after.text !== before.text) {
    const mine = renames.get(sessionId) ?? renames.set(sessionId, new Map()).get(sessionId)!;
    mine.set(id, { from: mine.get(id)?.from ?? before.text, to: after.text, pos: before.pos });
  }
  return after;
}

// The model was told of the owner's changes: its next plan has the rows as they read.
export const told = (sessionId: string) => void renames.delete(sessionId);

const FIELD: Record<string, [list: string, text: string]> = { update_plan: ["plan", "step"], write_todos: ["todos", "description"], TodoWrite: ["todos", "content"] };
// A plan item's words as the list keeps them (goals.fromPlanTool).
const words = (v: unknown) => String(v ?? "").replace(/\s*\((?:added by the owner|owner)\)\s*$/i, "").trim().slice(0, 500);

// The plan with each renamed row's earlier words replaced by its words now.
// Items of one text stand for the rows that had it, in list order, so of two
// tasks that read the same only the renamed one is read anew. A renamed row
// the owner then removed is read by its last words, which the list knows as removed.
export function current(sessionId: string, tool: string, input: any, rows: Task[]): any {
  const mine = renames.get(sessionId);
  const field = FIELD[tool];
  if (!mine?.size || !field || !Array.isArray(input?.[field[0]])) return input;
  const had = new Map<string, { pos: number; now?: string }[]>(); // the plan's words -> the rows that had them
  const add = (text: string, pos: number, now?: string) => void (had.get(text) ?? had.set(text, []).get(text)!).push({ pos, now });
  for (const r of rows) {
    const was = mine.get(r.id);
    add(was?.from ?? r.text, r.pos, was && was.from !== r.text ? r.text : undefined);
  }
  for (const [id, was] of mine) if (!rows.some((r) => r.id === id) && was.from !== was.to) add(was.from, was.pos, was.to);
  for (const list of had.values()) list.sort((a, b) => a.pos - b.pos);
  const taken = new Map<string, number>();
  const items = (input[field[0]] as any[]).map((item) => {
    const text = words(item?.[field[1]]);
    const n = taken.get(text) ?? 0;
    taken.set(text, n + 1);
    const now = had.get(text)?.[n]?.now;
    return now === undefined ? item : { ...item, [field[1]]: now };
  });
  return { ...input, [field[0]]: items };
}

// The model's plan tool wrote the list.
export const fromPlan = (sessionId: string, tool: string, input: any) => goals.fromPlanTool(sessionId, tool, current(sessionId, tool, input, goals.tasks(sessionId)));
