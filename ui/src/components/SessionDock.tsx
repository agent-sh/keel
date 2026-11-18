// Above the composer: the session's current plan and its background jobs.
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, ListChecks, Square, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { actions, reportError, useStore, type JobView } from "../lib/store.ts";
import { planItems, toolKind } from "../lib/tools.ts";
import { cn } from "../lib/utils.ts";
import { PlanCard } from "./ToolCall.tsx";

function useJobs(sessionId: string, working: boolean) {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const events = useStore((s) => s.events[sessionId]);
  useEffect(() => {
    let stop = false;
    let timer: Timer | undefined;
    const load = async () => {
      try {
        const r = await actions.jobs(sessionId);
        if (stop) return;
        setJobs(r.jobs);
        if (working || r.jobs.some((j) => j.running && j.background)) timer = setTimeout(load, 2000);
      } catch (e) { reportError(e, { at: "jobs" }); }
    };
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [sessionId, working, events?.length]);
  return jobs.filter((j) => j.background && (j.running || (j.ended ?? 0) > Date.now() - 60_000));
}

export function SessionDock({ sessionId }: { sessionId: string }) {
  const events = useStore((s) => s.events[sessionId]);
  const working = useStore((s) => s.sessions[sessionId]?.phase === "working");
  const plan = useMemo(() => {
    for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
      const e = events![i]!;
      if (e.kind !== "assistant") continue;
      for (let k = e.data.blocks.length - 1; k >= 0; k--) {
        const b = e.data.blocks[k];
        if (b.type === "tool_use" && toolKind(b.name) === "plan") return planItems(b.name, b.input);
      }
    }
    return null;
  }, [events]);
  const jobs = useJobs(sessionId, working);
  const active = plan && plan.some((p) => p.status !== "completed" && p.status !== "cancelled");
  if (!active && !jobs.length) return null;
  const done = plan?.filter((p) => p.status === "completed").length ?? 0;
  const now = plan?.find((p) => p.status === "in_progress");
  return (
    <div className="mb-2 flex flex-col gap-1.5" data-testid="session-dock">
      {active && plan && (
        <Collapsible.Root className="group/plan rounded-lg border border-line bg-raised shadow-1">
          <Collapsible.Trigger className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption outline-none" data-testid="dock-plan">
            <ListChecks className="size-3.5 text-muted" />
            <span className="font-medium">{done}/{plan.length}</span>
            <span className="min-w-0 truncate text-muted">{now ? (now.active ?? now.text) : "Plan"}</span>
            <div className="ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${(100 * done) / plan.length}%` }} />
            </div>
            <ChevronRight className="size-3.5 text-faint transition-transform group-data-[open]/plan:rotate-90" />
          </Collapsible.Trigger>
          <Collapsible.Panel className="border-t border-line">
            <PlanCard items={plan} compact />
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
      {jobs.map((j) => (
        <div key={j.id} className="flex items-center gap-2 rounded-lg border border-line bg-raised shadow-1 px-3 py-1.5 text-caption" data-testid="dock-job">
          <SquareTerminal className={cn("size-3.5", j.running ? "text-accent" : "text-faint")} />
          <span className="font-mono text-micro text-faint">{j.id}</span>
          <span className="min-w-0 truncate">{j.description ?? j.command}</span>
          <span className="ml-auto shrink-0 text-micro tabular-nums text-faint">
            {j.running ? `${Math.round((Date.now() - j.started) / 1000)}s` : `exit ${j.exit_code ?? j.signal}`}
          </span>
          {j.running && (
            <button
              type="button"
              title="Stop"
              data-testid="dock-job-stop"
              onClick={() => actions.stopJob(sessionId, j.id).catch(reportError)}
              className="grid size-5 place-items-center rounded-md text-faint hover:bg-danger-soft hover:text-danger"
            >
              <Square className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
