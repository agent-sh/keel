// "Is anything stuck": one answer across sessions. A running turn is stuck
// when the step it is on has made no progress for too long. Progress is what
// the step itself shows:
//   - a model request: its last output, else the last bytes the provider
//     sent (a keep-alive), else the request's start;
//   - a shell command: the last time it wrote output, else its start;
//   - any other tool (an MCP call, a reader run): nothing to read, so it is
//     timed from its start and called a long step, not a silent one.
// A step that waits is not stuck: a turn blocked on an agent it started or on
// a wait it called is that agent's or that wait's time, and what waits on the
// owner reads Needs you. So one piece of work is listed once, where it is.
// The daemon marks a session's state when its step passes the limit
// (src/automation/state.ts), and the page, the route and the command line
// read that mark.
import { span, type StuckMark } from "./watch.ts";

// How long without progress is too long, by what the turn waits on. A model
// that streams gives output every second or two and its longest pauses are
// well under two minutes; a command is given ten, the time a build or a test
// suite commonly takes between lines. The owner sets both (the `stuck`
// section of the daemon settings, seconds), and a request can name its own.
export type After = { model: number; tool: number };
export const STUCK_AFTER: After = { model: 120_000, tool: 600_000 };

// The running step and when it last made progress.
export type Progress = StuckMark;

export function stuckOf(p: Progress | null | undefined, now: number, after: After = STUCK_AFTER): StuckMark | null {
  if (!p) return null;
  const limit = p.what === "stream" || p.what === "model" ? after.model : after.tool;
  return now - p.since < limit ? null : p;
}

// One stuck step with whose it is. `agent`: the session is an agent's, of `parent_title`.
export type StuckItem = StuckMark & { session_id: string; title: string; agent: boolean; parent_id?: string; parent_title?: string; elapsed_ms: number };

const mins = (ms: number) => span(ms).replace(/^(\d+)m$/, "$1 min").replace(/^(\d+)s$/, "$1 s");
const lower = (t: string) => `${t.charAt(0).toLowerCase()}${t.slice(1)}`;

// What an item says of itself: a silence says for how long, a step with no sign of progress how long it has run.
export function stuckSaid(i: Pick<StuckItem, "what" | "text" | "elapsed_ms">): string {
  const t = span(i.elapsed_ms);
  return i.what === "stream" ? `${i.text} for ${t}`
    : i.what === "model" ? `No answer from the model for ${t}`
    : i.what === "tool" ? `${i.text}, no output for ${t}`
    : `Long step: ${i.text}, running for ${t}`;
}

// The answer as text, a line an item: for a terminal or a model.
export function stuckText(items: StuckItem[], after: After = STUCK_AFTER): string {
  const limits = after.model === after.tool ? `${mins(after.model)}` : `${mins(after.model)} for a model, ${mins(after.tool)} for a tool`;
  if (!items.length) return `Nothing is stuck: no turn, tool or agent has gone ${limits} without progress.`;
  const lines = items.map((i) => {
    const who = i.agent ? `agent ${i.title || "(untitled)"} of ${i.parent_title || "its parent"}` : i.title || "(untitled)";
    return `${i.session_id}  ${who}: ${lower(stuckSaid(i))}`;
  });
  return [`${items.length} stuck (no progress for ${limits}), longest first:`, ...lines].join("\n");
}
