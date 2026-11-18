import { Bell, Bot, CircleAlert, CircleCheck, CircleSlash, Clock, Gauge, Hand, MessageCircleQuestion, Repeat, Square } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentRecord, Alert } from "../../lib/automation.ts";
import { cn } from "../../lib/utils.ts";

export function AgentStatus({ status, className }: { status: AgentRecord["status"]; className?: string }) {
  const c = cn("size-3.5 shrink-0", className);
  if (status === "running") return <span className={cn("grid size-3.5 shrink-0 place-items-center", className)}><span className="size-1.5 rounded-full bg-brass animate-pulse-dot" /></span>;
  if (status === "waiting") return <Clock className={cn(c, "text-warn")} />;
  if (status === "completed") return <CircleCheck className={cn(c, "text-ok")} />;
  if (status === "failed") return <CircleAlert className={cn(c, "text-danger")} />;
  return <CircleSlash className={cn(c, "text-faint")} />;
}

export const STATUS_LABEL: Record<AgentRecord["status"], string> = {
  running: "Running", waiting: "Waiting", completed: "Done", failed: "Failed", stopped: "Stopped",
};

const ALERT_ICON: Record<Alert["kind"], typeof Bell> = {
  approval: Hand, question: MessageCircleQuestion, finished: CircleCheck, failed: CircleAlert, limit: Gauge, loop_failed: Repeat, agent: Bot,
};
export const ALERT_LABEL: Record<Alert["kind"], string> = {
  approval: "Approval", question: "Question", finished: "Finished", failed: "Failed", limit: "Usage limit", loop_failed: "Loop failed", agent: "From the agent",
};

export function AlertIcon({ kind }: { kind: Alert["kind"] }) {
  const Icon = ALERT_ICON[kind] ?? Bell;
  const tone = kind === "failed" || kind === "loop_failed" ? "bg-danger-soft text-danger" : kind === "finished" ? "bg-panel text-ok" : kind === "limit" ? "bg-panel text-warn" : "bg-accent-soft text-accent";
  return <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", tone)}><Icon className="size-3.5" /></span>;
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
