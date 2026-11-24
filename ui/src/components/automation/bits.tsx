import { Square } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { auto, autoState, isLive, useAuto, type AgentRecord, type Alert } from "../../lib/automation.ts";
import { descendants } from "../../../../src/core/agent-tree.ts";
import { reportError } from "../../lib/store.ts";
import { ALERT_WORD, agentState, agentWhy, STATE_WORD, stateWords, type AgentLike, type Said } from "../../../../src/core/state-words.ts";
import { cn } from "../../lib/utils.ts";
import { useToldState, type SessionState, type Watch } from "../../lib/watch.ts";
import { confirmAction } from "../Confirm.tsx";
import { elapsed, Mark, span, useNow } from "../Mark.tsx";
import { beatOf } from "../../lib/clock.ts";

export { agentWhy };

// An agent's state, as every surface says it: its record and its session's served state, in one
// word (src/core/state-words.ts). The tree, the card, the list of background work and its own pane agree.
export type AgentSaid = Said & { state: SessionState; why?: string; title: string };
export function agentSaid(a: AgentLike, told: SessionState | undefined): AgentSaid {
  const state = agentState(a, told);
  const said = stateWords(state);
  const why = agentWhy(a);
  // What a hover and a screen reader get: the word with what it is with, then the reason in the daemon's words
  // (never the word again: "Stopped at the step budget", not that and "The step budget ran out").
  const more = why ?? state.text;
  const title = [said.phrase, said.what && state.watch === "stop" ? undefined : more].filter(Boolean).join(". ");
  return { ...said, state, why, title };
}
export function useAgentSaid(a: AgentRecord | undefined): AgentSaid | undefined {
  const told = useToldState(a?.session_id);
  return useMemo(() => (a ? agentSaid(a, told) : undefined), [a, told]);
}

// The mark of an agent's state: the session mark (a shape and a color a state), as its row in the list has it.
export function AgentMark({ w, className }: { w: Watch; className?: string }) {
  return <span className={cn("grid size-3.5 shrink-0 place-items-center", className)}><Mark w={w} className="size-2" /></span>;
}
// The ink of a state word beside its mark.
export const STATE_INK: Record<Watch, string> = {
  need: "text-st-need", work: "text-accent", wait: "text-warn", resume: "text-warn", fail: "text-danger", declined: "text-danger", stop: "text-faint", done: "text-faint", idle: "text-faint",
};

// Stop always asks first, with the keyboard on Cancel: a stop cannot be undone. The question says
// what stops and what is kept: how long it has worked, and whether it has a worktree of its own
// (what it changed there may not be saved).
export async function stopAgentAsking(a: AgentRecord, title: string) {
  const ran = Date.now() - a.created;
  // The agents below it at work stop with it (the stop goes down the tree).
  const below = descendants(Object.values(autoState().agents), a.session_id).filter(isLive).length;
  const ok = await confirmAction({
    title: `Stop "${title}"?`,
    body: `It has worked for ${span(ran)}. Its turn ends now and what it has so far is reported to the session that started it.${below ? (below === 1 ? " The agent below it stops too, and waits for you to resume it." : ` The ${below} agents below it stop too, and wait for you to resume them.`) : ""}${a.worktree ? " Its worktree keeps the files it changed; work it did not save there is not recovered." : ""}`,
    action: "Stop agent", danger: true,
  });
  if (ok) await auto.stopAgent(a);
}
// The Stop control of an agent, named with the agent it stops.
export function StopAgent({ a, title, testid }: { a: AgentRecord; title: string; testid: string }) {
  return <IconButton title={`Stop agent: ${title}`} danger onClick={() => stopAgentAsking(a, title).catch(reportError)} testid={testid}><StopIcon /></IconButton>;
}

export const ALERT_LABEL = ALERT_WORD as Record<Alert["kind"], string>;

export const CHANNEL_NAME: Record<string, string> = { desktop: "Desktop", command: "Command hook", push: "Phone" };

// What each alert kind means in the Bridge's state colors: violet needs you,
// amber is work (an agent speaking, a limit closing in), red failed, sea green done.
export const ALERT_STATE: Record<Alert["kind"], Watch> = {
  approval: "need", question: "need", limit: "work", agent: "work", failed: "fail", loop_failed: "fail", finished: "done", snooze_over: "idle", regression: "fail", refused: "work", declined: "fail", machine: "idle", outage: "wait", review: "done", mcp: "need",
};

// An alert's mark is its state's own shape, the one the rail, the panes and the start page draw:
// the word beside it says the kind. (A glyph a kind was a second vocabulary of seven pictures.)
// One alert's state: a turn that ended while a command of its session still runs is work, not done.
export const alertState = (a: { kind: Alert["kind"]; data?: { live?: unknown } | null }): Watch =>
  a.kind === "finished" && a.data?.live ? "work" : (ALERT_STATE as Record<string, Watch>)[a.kind] ?? "idle";
export function AlertIcon({ kind, read, declined, live }: { kind: Alert["kind"]; read?: boolean; declined?: boolean; live?: boolean }) {
  // (A turn the model declined is filed as a finish until it has a kind of its own: it is drawn as declined.)
  const w: Watch = declined ? "declined" : alertState({ kind, data: live ? { live } : null });
  return <span className="k-alert-icon" data-watch={w} data-read={read || undefined} data-testid="alert-icon"><Mark w={w} /></span>;
}

// What a live agent is doing now (src/automation/now.ts): the newest sentence of its thinking or the
// call it runs, then its steps, how long its task has run and what it spent. The daemon tells a
// line at most every 15 s; the time counts here, on the page's one clock.
// A spend that leaves out calls with no listed price (a plan, a local model) says so.
export function nowMeta(l: { steps: number; since: number; usd: number; unpriced?: number }, now: number) {
  const usd = l.usd >= 0.005 ? `$${l.usd.toFixed(2)}${l.unpriced ? " and unpriced calls" : ""}` : l.unpriced ? "no price listed" : "";
  return [`${l.steps} step${l.steps === 1 ? "" : "s"}`, elapsed(now - l.since), ...(usd ? [usd] : [])].join(" · ");
}
export function AgentNow({ a, className }: { a: AgentRecord; className?: string }) {
  const line = useAuto((s) => s.now[a.id]);
  const shown = !!line && isLive(a);
  const now = useNow(shown, beatOf(line?.since));
  if (!shown) return null;
  return (
    <span className={cn("k-agent-now", className)} data-testid="agent-now" data-from={line.from} data-need={line.need || undefined}>
      {/* (Its state word beside it already says it needs the owner: here it is said to a screen reader, and the line takes the state's ink.) */}
      {line.need && <span className="sr-only" data-testid="agent-now-need">{STATE_WORD.need}:</span>}
      {line.text && <span className="k-agent-now-text" data-testid="agent-now-text" title={line.text}>{line.text}</span>}
      <span className="k-agent-now-meta" data-testid="agent-now-meta">{nowMeta(line, now)}</span>
    </span>
  );
}

export function IconButton({ title, onClick, children, danger, testid }: { title: string; onClick: () => void; children: ReactNode; danger?: boolean; testid?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid={testid}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn("grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-hover", danger ? "hover:text-danger" : "hover:text-fg")}
    >
      {children}
    </button>
  );
}

export function StopIcon() {
  return <Square className="size-3 fill-current" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="k-empty px-3 py-4">{children}</p>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
      <span className="k-label">{children}</span>
      <span className="ml-auto">{right}</span>
    </div>
  );
}
