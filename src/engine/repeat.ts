// A call that keeps coming back the same: the same tool, the same input and
// the same result, several times in a row within a turn. Asking again will not
// change the answer, and in a long unattended session such a loop burns the
// turn's budget on nothing. On the third identical answer the result carries a
// note saying so (and which wait tool waits for a change without asking); on
// the sixth such call it is refused before it runs. Any other call, or a
// changed result, resets the count. Factory's Droid nudges at three identical
// calls and stops at six; OpenCode asks the owner on a repeated call.
import { createHash } from "node:crypto";
import type { ToolResultBlock } from "../core/types.ts";

export const NUDGE_AT = 3;
export const REFUSE_AT = 6;

// Tools whose job is to wait: a repeat is how they work.
const WAITS = new Set(["WaitFor", "wait_for", "ScheduleWakeup", "schedule_wakeup", "Monitor", "monitor", "wait_agent", "write_stdin", "TaskOutput"]);

type Run = { key: string; result: string; count: number };
const runs = new Map<string, Run>();

const digest = (v: unknown) => createHash("sha1").update(typeof v === "string" ? v : JSON.stringify(v) ?? "").digest("hex");
const keyOf = (name: string, input: unknown) => `${name}\0${digest(input)}`;
const resultOf = (r: ToolResultBlock) => digest([r.is_error ?? false, r.content]);

// Before a call: refused when it is the same call that returned the same
// result REFUSE_AT - 1 times in a row.
export function refuse(sessionId: string, name: string, input: unknown): string | null {
  if (WAITS.has(name)) return null;
  const r = runs.get(sessionId);
  if (!r || r.key !== keyOf(name, input) || r.count < REFUSE_AT - 1) return null;
  return `Not run: this exact ${name} call returned the same result ${r.count} times in a row this turn, and asking again will not change it. Change the approach, or wait for the change with a wait tool instead of asking again.`;
}

// After a call: the note to append when this answer repeats NUDGE_AT times.
export function observe(sessionId: string, name: string, input: unknown, result: ToolResultBlock, waitTools: string): string | null {
  if (WAITS.has(name)) return void runs.delete(sessionId), null;
  const key = keyOf(name, input);
  const res = resultOf(result);
  const r = runs.get(sessionId);
  const count = r && r.key === key && r.result === res ? r.count + 1 : 1;
  runs.set(sessionId, { key, result: res, count });
  if (count !== NUDGE_AT) return null;
  return `[harness] This call returned the same result ${count} times in a row. Repeating it will not change the answer: change the approach${waitTools ? `, or wait for the change with ${waitTools}` : ""}.`;
}

export const reset = (sessionId: string) => void runs.delete(sessionId);
