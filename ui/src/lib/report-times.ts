// When an agent finished a task and when its report reached the parent, said
// apart in the report's details. `finished` is stamped once with the report id
// (src/automation/agents.ts reportMeta) and rides every send of it unchanged;
// `reached` is the time of the stored input that carried it. Nothing here
// orders the transcript: the report stays where its input is. `fmt`: the
// page's clock and wait formats (lib/utils.ts clock and fmtWait), given by the
// caller so this stays pure.
export type ReportWait = "restart" | "held" | "settle";

const WHY: Record<ReportWait, string> = {
  held: "held while the session was stopped",
  restart: "kept across a restart",
  settle: "waited for the other agents' reports",
};

// A wait under this is the delivery's own coalescing, not worth a word.
export const LATE_MS = 1_000;

export type TimeFmt = { time: (ts: number) => string; span: (ms: number) => string };
export function reportTimes(fmt: TimeFmt, finished: unknown, reached: number, waited?: unknown): string | undefined {
  if (typeof finished !== "number" || !Number.isFinite(finished)) return undefined; // an input from before the stamp
  const late = reached - finished;
  const at = `Its task ended ${fmt.time(finished)}`;
  if (late < LATE_MS) return `${at}, reached this session at once`;
  const why = typeof waited === "string" && waited in WHY ? `, ${WHY[waited as ReportWait]}` : "";
  return `${at}, reached this session ${fmt.time(reached)} (${fmt.span(late)} later${why})`;
}
