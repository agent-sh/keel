// Above the composer: the session's current plan and its background jobs.
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, ListChecks, Square, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { branchLine } from "../lib/rows.ts";
import { actions, api, liveNow, onFeature, reportError, reportUnlessGone, useStore, type JobView } from "../lib/store.ts";
import { splitId } from "../lib/fleet-ids.ts";
import { stopKind } from "../../../src/core/stops.ts";
import { loadSkillCommands } from "../lib/tools-ui.ts";
import { PLAN_TOOLS, planItems, toolKind } from "../lib/tools.ts";
import { cn } from "../lib/utils.ts";
import { useUI } from "../lib/ui.ts";
import { PlanCard } from "./ToolCall.tsx";

const since = (t: number) => {
  const s = Math.max(0, Math.round((liveNow() - t) / 1000)); // stopped while the daemon is unreachable
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

// The session's background commands. For a session of this daemon the list
// is read when the session is shown, when the daemon says it changed (a
// command started, went on in the background or ended: the "jobs" frame) and
// at a reconnect: a turn at work costs no read by itself. Only while a
// background command runs is it read again every two seconds, for the line it
// last printed. A session on another machine gets the same frame through
// that machine's relay; its list is also read as its turn starts and ends,
// for a daemon there that does not send the frame yet.
function useJobs(sessionId: string, working: boolean) {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const turn = !!splitId(sessionId) && working;
  useEffect(() => {
    let stop = false;
    let timer: Timer | undefined;
    let asked = 0;
    const load = async () => {
      clearTimeout(timer);
      const mine = ++asked;
      try {
        const r = await actions.jobs(sessionId);
        if (stop || mine !== asked) return; // a newer read is out
        // A session placed on another machine answers from there, perhaps without the list.
        const list = r.jobs ?? [];
        setJobs(list);
        if (list.some((j) => j.running && j.background)) timer = setTimeout(load, 2000);
      } catch (e) { reportError(e, { at: "jobs" }); }
    };
    load();
    const off = onFeature({ frame: (f) => { if (f.name === "jobs" && f.session_id === sessionId) void load(); }, reconnect: () => void load() });
    return () => { stop = true; clearTimeout(timer); off(); };
  }, [sessionId, turn]);
  return jobs.filter((j) => j.background && (j.running || (j.ended ?? 0) > Date.now() - 60_000));
}

// `panel`: this pane has the side panel. While its Tasks tab is open the plan
// is read there, and the strip here gives way: the plan shows once.
export function SessionDock({ sessionId, panel }: { sessionId: string; panel?: boolean }) {
  const inPanel = useUI((s) => !!panel && s.panel === "tasks");
  const events = useStore((s) => s.events[sessionId]);
  const head = useStore((s) => s.sessions[sessionId]?.head);
  const working = useStore((s) => s.sessions[sessionId]?.phase === "working");
  const workspace = useStore((s) => s.sessions[sessionId]?.workspace);
  useEffect(() => { if (workspace) loadSkillCommands(workspace); }, [workspace]);
  // The calls a daemon restart cut: a command of one may have gone on by itself.
  const cut = useMemo(() => new Set((events ?? []).flatMap((e) => (e.kind === "tool_result" ? e.data.results.filter((r: { content: unknown }) => stopKind(r.content) === "cut").map((r: { tool_use_id: string }) => r.tool_use_id) : []))), [events]);
  // The newest plan the tool accepted on the branch the next reply goes to:
  // a rejected update (or one still on its way) leaves the one before standing.
  const held = useMemo(() => {
    if (!events) return null;
    const line = branchLine(sessionId, events, head ?? null);
    const accepted = new Set<string>();
    for (const e of line) if (e.kind === "tool_result") for (const r of e.data.results) if (!r.is_error) accepted.add(r.tool_use_id);
    for (let i = line.length - 1; i >= 0; i--) {
      const e = line[i]!;
      if (e.kind !== "assistant") continue;
      for (let k = e.data.blocks.length - 1; k >= 0; k--) {
        const b = e.data.blocks[k];
        if (b.type === "tool_use" && toolKind(b.name) === "plan" && accepted.has(b.id)) return { plan: planItems(b.name, b.input), before: 0 };
      }
    }
    // The page holds the end of the branch: a plan accepted before that part is asked for.
    return { plan: null, before: line.length && line[0]!.parent !== null ? line[0]!.seq : 0 };
  }, [events, head]);
  const [older, setOlder] = useState<{ key: string; plan: ReturnType<typeof planItems> | null } | null>(null);
  const key = held?.before ? `${sessionId} ${held.before}` : "";
  useEffect(() => {
    if (!key) return;
    let stop = false;
    api<{ call: { name: string; input: unknown } | null }>(`/api/sessions/${sessionId}/last-call?names=${PLAN_TOOLS.join(",")}&before=${held!.before}`)
      .then((r) => { if (!stop) setOlder({ key, plan: r.call ? planItems(r.call.name, r.call.input) : null }); })
      .catch((e) => reportUnlessGone(e, { at: "dock plan" }));
    return () => { stop = true; };
  }, [key]);
  const plan = held?.plan ?? (older?.key === key ? older.plan : null);
  const jobs = useJobs(sessionId, working);
  const active = !inPanel && plan && plan.some((p) => p.status !== "completed" && p.status !== "cancelled");
  if (!active && !jobs.length) return null;
  const done = plan?.filter((p) => p.status === "completed").length ?? 0;
  const now = plan?.find((p) => p.status === "in_progress");
  return (
    <div className="mb-2 flex flex-col gap-1.5 max-md:mb-1" data-testid="session-dock">
      {active && plan && (
        // On a phone the plan is one slim line over the box, not a card of its own.
        <Collapsible.Root className="group/plan rounded-lg border border-line bg-raised shadow-1 max-md:rounded-none max-md:border-x-0 max-md:border-b-0 max-md:bg-transparent max-md:shadow-none max-md:data-[open]:border-b">
          <Collapsible.Trigger className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-caption outline-none max-md:px-1 max-md:py-1" data-testid="dock-plan">
            <ListChecks className="size-3.5 text-muted" />
            <span className="font-medium">{done}/{plan.length}</span>
            <span className="min-w-0 truncate text-muted">{now ? (now.active ?? now.text) : "Plan"}</span>
            <div className="ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${(100 * done) / plan.length}%` }} />
            </div>
            <ChevronRight className="size-3.5 text-faint transition-transform group-data-[open]/plan:rotate-90" />
          </Collapsible.Trigger>
          <Collapsible.Panel className="border-t border-line">
            <PlanCard items={plan} live />
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
            {j.running ? since(j.started) : j.stop_reason === "was stopped by the owner" ? "Stopped by you" : j.stop_reason ? j.stop_reason.replace(/^was /, "") : j.signal ? `killed by ${j.signal}`
              // Its call was cut by a restart and the command went on without it: said as that, not as a bare exit code beside "cut".
              : j.call_id && cut.has(j.call_id) ? (j.exit_code == null ? "went on after the restart, then ended" : j.exit_code === 0 ? "went on after the restart and finished" : `went on after the restart and failed (exit ${j.exit_code})`)
              : j.exit_code == null ? "ended, exit unknown" : `exit ${j.exit_code}`}
          </span>
          {j.running && (
            <button
              type="button"
              title="Stop"
              data-testid="dock-job-stop"
              onClick={() => actions.stopJob(sessionId, j.id).catch(reportError)}
              className="grid size-ctl-sm place-items-center rounded-md text-faint hover:bg-danger-soft hover:text-danger"
            >
              <Square className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
