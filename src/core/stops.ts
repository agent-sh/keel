// What a tool call's result says when the call did not fail but was ended
// under it: the owner stopped the turn, or a daemon restart cut it. The engine
// writes these texts, and the page reads them back to say "stopped" or "cut"
// instead of "failed".

// A call cut while its tool ran.
export const RESTART_CUT = "Interrupted by a daemon restart while this tool ran. It may have partly run: check its effects before running it again.";
// A call cut while it ran a command whose fate is known (src/tools/jobs.ts
// cutCommand): the result starts with this and says what became of the
// command: it runs on, it was stopped, or it ended and how.
export const RESTART_RAN = "The daemon restarted while this command ran.";
// A question a restart cut that could not be put back on its card (the
// session's model no longer has the tool). Nothing was answered: the inbox
// files it as a decision the owner still owes.
export const QUESTION_CUT = "No answer was recorded before the daemon restarted: the question expired. Ask it again if the decision still matters.";
// A call cut while it waited for the owner's approval never ran.
export const APPROVAL_CUT = "The daemon restarted while this call waited for the owner's approval: it did not run. Call it again if it is still needed.";
// The owner's stop reached the call.
export const STOPPED_BEFORE = "Interrupted by the user before this tool ran.";
export const STOPPED_WHILE = "Interrupted by the user while this tool ran.";

const CUT: readonly string[] = [RESTART_CUT, QUESTION_CUT, APPROVAL_CUT];
export const stopKind = (content: unknown): "stopped" | "cut" | undefined =>
  typeof content !== "string" ? undefined : content === STOPPED_BEFORE || content === STOPPED_WHILE ? "stopped" : CUT.includes(content) || content.startsWith(RESTART_RAN) ? "cut" : undefined;
