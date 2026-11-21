// "Is anything stuck": one answer across sessions. A running turn is stuck
// when the step it is on has made no progress for longer than that step may
// take: a model that gives no output (none yet, or a stream that went
// silent), a tool that has not returned. An agent's session counts like any
// other and is named with its parent. What waits on the owner is not stuck:
// it reads Needs you. The answer is read from each session's state
// (src/core/watch.ts), so the page, the route and the command line agree.
import { span, type SessionState } from "./watch.ts";

// How long without progress is too long, by what the turn waits on. A model
// that streams gives output every second or two and its longest pauses are
// well under two minutes; a command is given ten, the time a build or a test
// suite commonly takes. Both can be set per request (`after`).
export type After = { model: number; tool: number };
export const STUCK_AFTER: After = { model: 120_000, tool: 600_000 };

export type Stuck = { what: "stream" | "model" | "tool"; text: string; since: number };

export function stuckOf(st: SessionState | undefined, now: number, after: After = STUCK_AFTER): Stuck | null {
  if (!st || st.watch !== "work" || !st.since) return null;
  const what = st.why === "stalled" ? "stream" : st.why === "model" || st.why === "tool" ? st.why : null;
  if (!what || now - st.since < (what === "tool" ? after.tool : after.model)) return null;
  return { what, text: st.text ?? "", since: st.since };
}

// One stuck step with whose it is. `agent`: the session is an agent's, of `parent_title`.
export type StuckItem = Stuck & { session_id: string; title: string; agent: boolean; parent_id?: string; parent_title?: string; elapsed_ms: number };

const mins = (ms: number) => span(ms).replace(/^(\d+)m$/, "$1 min").replace(/^(\d+)s$/, "$1 s");

// The answer as text, a line an item: for a terminal or a model.
export function stuckText(items: StuckItem[], after: After = STUCK_AFTER): string {
  const limits = after.model === after.tool ? `${mins(after.model)}` : `${mins(after.model)} for a model, ${mins(after.tool)} for a tool`;
  if (!items.length) return `Nothing is stuck: no turn, tool or agent has gone ${limits} without progress.`;
  const lines = items.map((i) => {
    const who = i.agent ? `agent ${i.title || "(untitled)"} of ${i.parent_title || "its parent"}` : i.title || "(untitled)";
    const said = i.what === "stream" ? `${i.text} for ${span(i.elapsed_ms)}` : `${i.text}, for ${span(i.elapsed_ms)}`;
    return `${i.session_id}  ${who}: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  });
  return [`${items.length} stuck (no progress for ${limits}), longest first:`, ...lines].join("\n");
}
