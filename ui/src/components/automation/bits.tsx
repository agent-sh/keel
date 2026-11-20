import { AlarmClock, Bell, Bot, CircleAlert, CircleCheck, CircleDashed, CircleSlash, Clock, Gauge, Hand, MessageCircleQuestion, Repeat, ShieldX, Square, TrendingDown } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentRecord, Alert } from "../../lib/automation.ts";
import { cn } from "../../lib/utils.ts";
import type { Watch } from "../../lib/watch.ts";

export function AgentStatus({ status, className }: { status: AgentRecord["status"]; className?: string }) {
  const c = cn("size-3.5 shrink-0", className);
  if (status === "running") return <span className={cn("grid size-3.5 shrink-0 place-items-center", className)}><span className="size-1.5 rounded-full bg-brass animate-pulse-dot" /></span>;
  if (status === "waiting") return <Clock className={cn(c, "text-warn")} />;
  if (status === "completed") return <CircleCheck className={cn(c, "text-ok")} />;
  if (status === "failed") return <CircleAlert className={cn(c, "text-danger")} />;
  if (status === "incomplete") return <CircleDashed className={cn(c, "text-warn")} />;
  return <CircleSlash className={cn(c, "text-faint")} />;
}

export const STATUS_LABEL: Record<AgentRecord["status"], string> = {
  running: "Running", waiting: "Waiting", completed: "Done", incomplete: "Did not finish", failed: "Failed", stopped: "Stopped",
};

// Who stopped an agent, and why one did not finish, as the owner reads it.
export const STOPPED_BY: Record<string, string> = {
  owner: "You stopped this agent", parent: "Its parent agent stopped it", parent_turn: "Stopped with its parent's turn",
  time_limit: "Its time limit passed", parent_archived: "Its parent session was archived",
};
export const ENDED: Record<string, string> = {
  refusal: "The model declined; the report is partial", max_tokens: "Output limit reached; the report is partial", max_steps: "Step budget spent; the report is partial",
};
export const agentWhy = (a: { status: string; stopped_by?: string | null; end_reason?: string | null }) =>
  a.status === "stopped" ? (a.stopped_by ? STOPPED_BY[a.stopped_by] : undefined) : a.status === "incomplete" ? (a.end_reason ? ENDED[a.end_reason] : undefined) : undefined;

const ALERT_ICON: Record<Alert["kind"], typeof Bell> = {
  approval: Hand, question: MessageCircleQuestion, finished: CircleCheck, failed: CircleAlert, limit: Gauge, loop_failed: Repeat, agent: Bot, snooze_over: AlarmClock, regression: TrendingDown, refused: ShieldX,
};
export const ALERT_LABEL: Record<Alert["kind"], string> = {
  approval: "Approval", question: "Question", finished: "Finished", failed: "Failed", limit: "Usage limit", loop_failed: "Loop failed", agent: "From the agent", snooze_over: "Snooze over", regression: "Regression", refused: "Refused call",
};

export const CHANNEL_NAME: Record<string, string> = { desktop: "Desktop", command: "Command hook", push: "Phone" };

// What each alert kind means in the Bridge's state colors: violet needs you,
// amber is work (an agent speaking, a limit closing in), red failed, sea green done.
export const ALERT_STATE: Record<Alert["kind"], Watch> = {
  approval: "need", question: "need", limit: "work", agent: "work", failed: "fail", loop_failed: "fail", finished: "done", snooze_over: "idle", regression: "fail", refused: "work",
};

export function AlertIcon({ kind, read }: { kind: Alert["kind"]; read?: boolean }) {
  const Icon = ALERT_ICON[kind] ?? Bell;
  return <span className="k-alert-icon" data-watch={ALERT_STATE[kind] ?? "idle"} data-read={read || undefined} data-testid="alert-icon"><Icon /></span>;
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
  return <p className="px-3 py-6 text-center text-ui text-faint">{children}</p>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
      <span className="text-micro font-semibold uppercase tracking-[0.06em] text-faint">{children}</span>
      <span className="ml-auto">{right}</span>
    </div>
  );
}
