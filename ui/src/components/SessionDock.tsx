// Above the composer: the session's current plan and its background jobs.
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, ListChecks, Square, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { lineage } from "../../../src/core/tree.ts";
import { actions, reportError, useStore, type JobView } from "../lib/store.ts";
import { loadSkillCommands } from "../lib/tools-ui.ts";
import { planItems, toolKind } from "../lib/tools.ts";
import { cn } from "../lib/utils.ts";
import { PlanCard } from "./ToolCall.tsx";

const since = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function useJobs(sessionId: string, working: boolean) {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const events = useStore((s) => s.events[sessionId]);
  useEffect(() => {
    let stop = false;
    let timer: Timer | undefined;
    let misses = 0;
    const load = async () => {
      try {
        const r = await actions.jobs(sessionId);
        if (stop) return;
        // A session placed on another machine answers from there, perhaps without the list.
        const list = r.jobs ?? [];
        setJobs(list);
        if (working || list.some((j) => j.running && j.background)) timer = setTimeout(load, 2000);
      } catch (e) { reportError(e, { at: "jobs" }); }
    };
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [sessionId, working, events?.length]);
  return jobs.filter((j) => j.background && (j.running || (j.ended ?? 0) > Date.now() - 60_000));
}

export function SessionDock({ sessionId }: { sessionId: string }) {
  const events = useStore((s) => s.events[sessionId]);
  const head = useStore((s) => s.sessions[sessionId]?.head);
  const working = useStore((s) => s.sessions[sessionId]?.phase === "working");
  const workspace = useStore((s) => s.sessions[sessionId]?.workspace);
  useEffect(() => { if (workspace) loadSkillCommands(workspace); }, [workspace]);
  // The newest plan the tool accepted on the branch the next reply goes to:
  // a rejected update (or one still on its way) leaves the one before standing.
  const plan = useMemo(() => {
    if (!events) return null;
    const line = lineage(events, head ?? null);
    const accepted = new Set<string>();
    for (const e of line) if (e.kind === "tool_result") for (const r of e.data.results) if (!r.is_error) accepted.add(r.tool_use_id);
    for (let i = line.length - 1; i >= 0; i--) {
      const e = line[i]!;
      if (e.kind !== "assistant") continue;
      for (let k = e.data.blocks.length - 1; k >= 0; k--) {
        const b = e.data.blocks[k];
        if (b.type === "tool_use" && toolKind(b.name) === "plan" && accepted.has(b.id)) return planItems(b.name, b.input);
      }
    }
    return null;
  }, [events, head]);
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
          <span className="min-w-0 max-w-[40%] shrink-0 truncate">{j.description ?? j.command}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-micro text-muted" title={j.last} data-testid="dock-job-last">{j.last}</span>
          <span className="shrink-0 text-micro tabular-nums text-faint">
            {j.running ? since(j.started) : j.stop_reason === "was stopped by the owner" ? "Stopped by you" : j.stop_reason ? j.stop_reason.replace(/^was /, "") : j.signal ? `killed by ${j.signal}` : j.exit_code == null ? "ended, exit unknown" : `exit ${j.exit_code}`}
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
