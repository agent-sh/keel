// The record of a daemon start and its words: when the daemon before it went
// down, how, the turns that cut and what became of each. The same sentences
// in `keel status`, the Activity row, the log and Settings > Daemon. Kept
// apart from life.ts so the page can load this file.
import { localDay, localTime, zonedPair, zoneLabel } from "../core/clock.ts";
import type { CutState, CutTurn } from "../engine/hooks.ts";

// How the daemon before this one ended. `killed`: it left no end (a kill, the
// runtime or the machine went down); its time is its last sign of life.
// `crash`: the process ended itself on a failure (`code`: its exit code).
// `signal`: a stop signal from outside (SIGTERM, SIGINT) stopped it: nobody asked Keel to stop.
// `within_ms`: a killed daemon that was idle wrote its sign of life this far apart: it went down at `down_ms` or within this long after.
// `drain_ms`: a stop it made itself: when it stopped taking work. It answered requests until `down_ms`.
export type Before = { pid: number; started_ms: number; down_ms: number; how: "killed" | "restart" | "stop" | "crash" | "signal"; code?: number; within_ms?: number; drain_ms?: number };
// `left`: nothing went on with it (its session is archived, say); it is as the cut left it.
// `why`: for a held turn the reason; for one that went on by other means, what the means were.
// `earlier`: an earlier stop cut it, and it was still waiting to be decided when this start came.
export type RestartTurn = CutTurn & { session_id: string; title: string; parent_id?: string | null; state: "pending" | CutState | "left"; why?: string; earlier?: true };
export type Restart = {
  id: string;
  up_ms: number; // the process's start
  // When it began to answer: up_ms and the time its modules took to load. Absent in a record from before it was kept.
  listening_ms?: number;
  pid: number;
  // Null: nothing is known of the daemon before this one, for the reason in `unknown`.
  before: Before | null;
  unknown?: string;
  turns: RestartTurn[];
  settled_ms?: number; // every cut turn was decided
  // What each session with cut agents was told of them, once the line was stored: by parent, each
  // agent's session and the fate said (src/automation/restart-told.ts). A parent not here is still owed.
  told?: Record<string, Record<string, string>>;
};

// The time of day, with the date when it is not the day of `beside`: the reader's own zone (see clock.ts).
const clock = (ms: number, beside = ms) => (localDay(ms) === localDay(beside) ? localTime(ms) : `${localDay(ms)} ${localTime(ms)}`);
function span(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}
const HOW: Record<Before["how"], string> = { killed: "went down without stopping (killed, or the machine went down)", crash: "ended on a failure", restart: "stopped for a restart", stop: "was stopped", signal: "was stopped by a signal" };
const title = (t: string) => { const s = t.replace(/\s+/g, " ").trim(); return s ? `"${s.length > 48 ? `${s.slice(0, 47)}…` : s}"` : "an untitled session"; };

// "3 resumed, 1 held", in a fixed order.
export function tally(turns: RestartTurn[]): string {
  const n = (st: RestartTurn["state"]) => turns.filter((t) => t.state === st).length;
  return [
    n("continued") ? `${n("continued")} resumed` : "", n("held") ? `${n("held")} held for the owner` : "",
    n("moved") ? `${n("moved")} went on by other means` : "", n("left") ? `${n("left")} left as cut` : "", n("pending") ? `${n("pending")} not decided yet` : "",
  ].filter(Boolean).join(", ");
}

// Whether a start is worth the owner's eye by itself: the daemon did not
// choose to go down, or a turn was not continued. A planned restart that
// continued everything is in the log and the Daemon page, not a row each time.
export const restartNeedsEye = (r: Restart): boolean =>
  r.before?.how === "killed" || r.before?.how === "crash" || r.turns.some((t) => t.state === "held" || t.state === "left");

// When a start came back: when it began to answer, else (a record from before that was kept) its process's start.
export const backAt = (r: Restart): number => r.listening_ms ?? r.up_ms;
// How long nothing answered: from the end of the daemon before (its last answer) to this one listening.
export const downMs = (r: Restart): number => (r.before ? Math.max(0, backAt(r) - r.before.down_ms) : 0);
// How long the daemon before took from the start of its drain (when it stopped taking work) to its end.
export const drainMs = (r: Restart): number | undefined => (r.before?.drain_ms !== undefined ? Math.max(0, r.before.down_ms - r.before.drain_ms) : undefined);

// One sentence: when it went down, how, when it came back, and what that cut.
export function restartSummary(r: Restart): string {
  const b = r.before;
  const own = r.turns.filter((t) => !t.earlier), earlier = r.turns.filter((t) => t.earlier);
  const cut = own.length ? `${own.length} turn${own.length > 1 ? "s were" : " was"} cut: ${tally(own)}` : "no turn was cut";
  // Turns an earlier stop cut, which the daemon before this one had not decided before it went down too.
  const old = earlier.length ? ` ${earlier.length} turn${earlier.length > 1 ? "s" : ""} an earlier stop cut ${earlier.length > 1 ? "were" : "was"} still waiting: ${tally(earlier)}.` : "";
  // The sentence is read alone (a log line, an Activity row, a terminal): it says its zone, once, after its last time.
  if (!b) return `The daemon started at ${clock(backAt(r))} ${zoneLabel(backAt(r))}. How the one before it ended is not known: ${r.unknown ?? "nothing is known"}; ${r.turns.length ? `${r.turns.length} turn${r.turns.length > 1 ? "s were" : " was"} found cut: ${tally(r.turns)}` : "no turn was found cut"}.`;
  const how = b.how === "crash" && b.code !== undefined ? `${HOW.crash} (exit code ${b.code})` : HOW[b.how];
  const back = backAt(r);
  const [down, up] = zonedPair(b.down_ms, back, (ts) => clock(ts, back));
  // (A drain with nothing to wait for ends within a moment: not worth the words.)
  const drain = (drainMs(r) ?? 0) >= 1000 ? drainMs(r) : undefined;
  return `The daemon ${how} at ${b.how === "killed" ? "about " : ""}${down}${b.how === "killed" && b.within_ms ? ` (it was idle: within ${span(b.within_ms)} after)` : ""} and came back at ${up} (down ${span(downMs(r))}${drain !== undefined ? `, after a drain of ${span(drain)} that took no new work` : ""}); ${cut}.${old}`;
}

// Where a turn was cut: the step, what it was at, and how long it had run.
export const cutWhere = (t: CutTurn): string => t.unstarted ? "before its turn began"
  : `at step ${t.step}, ${t.tools.length ? `during ${t.tools.slice(0, 3).join(", ")}${t.tools.length > 3 ? ` and ${t.tools.length - 3} more` : ""}` : t.waiting ? "waiting for the owner's answer" : "waiting for the model"}, after ${span(t.ran_ms)}`;

// One line a cut turn: where it was cut and what became of it.
export function restartTurnLine(t: RestartTurn): string {
  const became = { continued: "resumed", held: "held for the owner", moved: t.why || "went on by other means", left: "left as cut", pending: "not decided yet" }[t.state];
  return `${title(t.title)}${t.parent_id ? " (an agent)" : ""} cut ${t.earlier ? "by an earlier stop " : ""}${cutWhere(t)}: ${became}`;
}
