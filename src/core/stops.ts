// What a tool call's result says when the call did not fail but was ended
// under it: the owner stopped the turn, or a daemon restart cut it. The engine
// writes these texts, and the page reads them back to say "stopped" or "cut"
// instead of "failed". Pure: the page loads this file.
import { ownerStop, stopSays } from "./stoppers.ts";

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
// A stop reached the call. The owner's own Stop is said as the user's, the
// words models are trained on; any other stopper is named in its own words
// (src/core/stoppers.ts): a model told "the user" stopped it when the API, a
// parent or a hook did would take that for the owner's wish.
export const STOPPED_BEFORE = "Interrupted by the user before this tool ran.";
export const STOPPED_WHILE = "Interrupted by the user while this tool ran.";
const BEFORE = "Interrupted before this tool ran: the turn ";
const WHILE = "Interrupted while this tool ran: the turn ";
// `by`: the stopper's word, as Engine.interrupt was given it. None known: the user's words, as before stops were named.
export const stoppedBefore = (by?: string): string => (by === undefined || ownerStop(by) ? STOPPED_BEFORE : `${BEFORE}${stopSays(by)}.`);
export const stoppedWhile = (by?: string): string => (by === undefined || ownerStop(by) ? STOPPED_WHILE : `${WHILE}${stopSays(by)}.`);
// Whether the words are the user's own stop (the owner's Stop, or a stop from before stops were named).
export const stoppedByUser = (content: unknown): boolean => content === STOPPED_BEFORE || content === STOPPED_WHILE;
// Who stopped a call, as a line under it says it: "you" for the owner's own
// stop (and one from before stops were named), else what the turn's stop
// was ("stopped by its parent"). Nothing for a result that is not a stop.
export const stoppedByWords = (content: unknown): string | undefined =>
  stoppedByUser(content) ? "you"
    : typeof content === "string" && (content.startsWith(BEFORE) || content.startsWith(WHILE)) ? content.slice((content.startsWith(BEFORE) ? BEFORE : WHILE).length).replace(/\.$/, "") : undefined;
// What a command's output pane says when the command printed nothing and its
// call has ended: who stopped it or that a restart cut it, else that it printed nothing.
export const quietEnd = (content: unknown): string => {
  if (stopKind(content) === "cut") return "Nothing printed before a daemon restart cut it.";
  const by = stoppedByWords(content);
  return by === "you" ? "Nothing printed before you stopped the turn." : by ? `Nothing printed before the stop: the turn ${by}.` : "No output.";
};
// Whether a stop reached the call while it ran (it may have partly run), whoever stopped it.
export const stoppedRunning = (content: unknown): boolean => content === STOPPED_WHILE || (typeof content === "string" && content.startsWith(WHILE));

const CUT: readonly string[] = [RESTART_CUT, QUESTION_CUT, APPROVAL_CUT];
export const stopKind = (content: unknown): "stopped" | "cut" | undefined =>
  typeof content !== "string" ? undefined
    : content === STOPPED_BEFORE || content === STOPPED_WHILE || content.startsWith(BEFORE) || content.startsWith(WHILE) ? "stopped"
      : CUT.includes(content) || content.startsWith(RESTART_RAN) ? "cut" : undefined;

// A call the turn never ran for a reason of the turn's own: its reply was cut at the
// output limit inside the call (its input may be incomplete), or the step budget was
// spent. Neither ran nor failed: the page and an agent's report say "not run" and why.
export const CUT_CALL = "Not run: this call was cut at the output limit, so its input may be incomplete. Send it again whole if it is still needed.";
export const BUDGET_SPENT = "Not run: the step budget of this turn is spent.";
// A call of the step an agent's spent budget leaves for its report.
export const AGENT_BUDGET_SPENT = "Not run: the agent's budget is spent; this step is for its report.";
// A call of the step a session's reached dollar cap leaves for its report (src/automation/caps.ts).
export const CAP_SPENT = "Not run: the dollar cap is reached; this step is for the report.";
const NOT_RUN: Record<string, string> = { [CUT_CALL]: "cut at the output limit", [BUDGET_SPENT]: "the step budget was spent", [AGENT_BUDGET_SPENT]: "the agent's budget was spent", [CAP_SPENT]: "the dollar cap was reached" };
// Why the call was not run, in a few words, or nothing when it is not such a call.
export const notRun = (content: unknown): string | undefined => (typeof content === "string" ? NOT_RUN[content] : undefined);

// What the model gets for a call the owner denied on its card. The page reads
// it back: a denial is the owner's own act, not a failure of the call, and
// the words after the colon are the owner's reason.
export const OWNER_DENIED = "The owner denied this call";
export const ownerDenial = (why?: string) => (why ? `${OWNER_DENIED}: ${why}` : `${OWNER_DENIED}. Do not retry it; take another way or ask.`);
// What the model gets for a call a PreToolUse hook of the owner's blocked,
// followed by the hook's reason. The call never ran.
export const HOOK_BLOCKED = "A hook blocked this call";
// How a call that never ran was turned away, by its result's own words: the
// owner denied it, or the policy, the reviewer, the judge or a hook refused it.
export const turnedAway = (content: unknown): "denied" | "refused" | undefined =>
  typeof content !== "string" ? undefined
    : content.startsWith(OWNER_DENIED) ? "denied"
      : content.startsWith(`${HOOK_BLOCKED}: `) || /^(Refused: |Refused by |The reviewer refused this call|This session is (read-only|in plan mode)\b)/.test(content) ? "refused" : undefined;
// The reason the owner gave with a denial; empty when they gave none.
export const denialReason = (content: string): string => (content.startsWith(`${OWNER_DENIED}: `) ? content.slice(OWNER_DENIED.length + 2) : "");
