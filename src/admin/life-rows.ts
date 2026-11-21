// The record of a daemon start and its words: when the daemon before it went
// down, how, the turns that cut and what became of each. The same sentences
// in `keel status`, the Activity row, the log and Settings > Daemon. Kept
// apart from life.ts so the page can load this file.
import type { CutState, CutTurn } from "../engine/hooks.ts";

// How the daemon before this one ended. `killed`: it left no end (a kill, a
// crash, the machine went down); its time is its last sign of life.
export type Before = { pid: number; started_ms: number; down_ms: number; how: "killed" | "restart" | "stop" };
// `left`: nothing went on with it (its session is archived, say); it is as the cut left it.
export type RestartTurn = CutTurn & { session_id: string; title: string; parent_id?: string | null; state: "pending" | CutState | "left"; why?: string };
export type Restart = {
  id: string;
  up_ms: number;
  pid: number;
  before: Before;
  turns: RestartTurn[];
  settled_ms?: number; // every cut turn was decided, and the Activity row written
};

// The time of day, with the date when it is not the day of `beside`.
const clock = (ms: number, beside = ms) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hourCycle: "h23" });
  return d.toDateString() === new Date(beside).toDateString() ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
};
function span(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}
const HOW: Record<Before["how"], string> = { killed: "went down without stopping (killed or crashed)", restart: "stopped for a restart", stop: "was stopped" };
const title = (t: string) => { const s = t.replace(/\s+/g, " ").trim(); return s ? `"${s.length > 48 ? `${s.slice(0, 47)}…` : s}"` : "an untitled session"; };

// "3 continued, 1 held", in a fixed order.
export function tally(turns: RestartTurn[]): string {
  const n = (st: RestartTurn["state"]) => turns.filter((t) => t.state === st).length;
  return [
    n("continued") ? `${n("continued")} continued` : "", n("held") ? `${n("held")} held for the owner` : "",
    n("moved") ? `${n("moved")} went on by other means` : "", n("left") ? `${n("left")} left as cut` : "", n("pending") ? `${n("pending")} not decided yet` : "",
  ].filter(Boolean).join(", ");
}

// One sentence: when it went down, how, when it came back, and what that cut.
export function restartSummary(r: Restart): string {
  const b = r.before;
  const cut = r.turns.length ? `${r.turns.length} turn${r.turns.length > 1 ? "s were" : " was"} cut: ${tally(r.turns)}` : "no turn was cut";
  return `The daemon ${HOW[b.how]} at ${b.how === "killed" ? "about " : ""}${clock(b.down_ms, r.up_ms)} and came back at ${clock(r.up_ms)} (down ${span(Math.max(0, r.up_ms - b.down_ms))}); ${cut}.`;
}

// Where a turn was cut: the step, what it was at, and how long it had run.
export const cutWhere = (t: CutTurn): string => t.unstarted ? "before its turn began"
  : `at step ${t.step}, ${t.tools.length ? `during ${t.tools.slice(0, 3).join(", ")}${t.tools.length > 3 ? ` and ${t.tools.length - 3} more` : ""}` : t.waiting ? "waiting for an approval" : "waiting for the model"}, after ${span(t.ran_ms)}`;

// One line a cut turn: where it was cut and what became of it.
export function restartTurnLine(t: RestartTurn): string {
  const where = cutWhere(t);
  const became = { continued: "continued", held: "held for the owner", moved: "went on by other means", left: "left as cut", pending: "not decided yet" }[t.state];
  return `${title(t.title)}${t.parent_id ? " (an agent)" : ""} cut ${where}: ${became}`;
}
