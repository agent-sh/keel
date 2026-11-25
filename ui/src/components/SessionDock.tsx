// Above the composer, two lines. The first: the session's plan, its agents and its background commands. The second
// (DockNow.tsx): what the turn does now, its folder and project, and what it changed (with the landing when its
// branch is ready).
import { Collapsible } from "@base-ui/react/collapsible";
import { Popover } from "@base-ui/react/popover";
import { ChevronRight, FileDiff, ListChecks, Square, SquareTerminal } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { readyToLand, toLand } from "../../../src/board/rules.ts";
import { rootOf } from "../lib/agent-tree.ts";
import { useBoard, useTreeMark } from "../lib/board.ts";
import { useChanged, type Changed } from "../lib/session-changes.ts";
import { branchLine } from "../lib/rows.ts";
import { actions, api, liveNow, onFeature, reportError, reportUnlessGone, useStore, type JobView } from "../lib/store.ts";
import { splitId } from "../lib/fleet-ids.ts";
import { stopKind } from "../../../src/core/stops.ts";
import { loadSkillCommands } from "../lib/tools-ui.ts";
import { planLine, planState, turnsSince, useMinute } from "../lib/plan-age.ts";
import { PLAN_TOOLS, planItems, toolKind } from "../lib/tools.ts";
import { useUI } from "../lib/ui.ts";
import { PlanCard } from "./ToolCall.tsx";
import { openPanel } from "./SidePanel.tsx";
import { DockNow } from "./DockNow.tsx";

// The tree review (land, send back or drop each area), the one action the work board offers for landing.
const TreeReviewDialog = lazy(() => import("./TreeReview.tsx").then((m) => ({ default: m.TreeReviewDialog })));
import { AgentsDock, useAgentsTally } from "./automation/AgentsDock.tsx";

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


// What the session changed, as the last part of the bottom line: its files and lines, which open the Changes panel.
// Where the session is in a tree with agents and its branch has nothing left but the landing (its own, or every branch of a
// coordinator's tree that waits to land), it says so and offers the board's own action: the tree review.
function ChangesPart({ changed, ready, land }: { changed: Changed | null; ready: boolean; land?: Session }) {
  const [landing, setLanding] = useState(false);
  if (!changed && !ready) return null;
  return (
    <span className="k-now-changes" data-testid="dock-changes" data-ready={ready || undefined}>
      {changed && (
        <button type="button" className="k-now-seg" data-testid="dock-changes-open" title="The files this session changed, with a revert for each" aria-label={`${changed.files} ${changed.files === 1 ? "file" : "files"} changed, ${changed.added} lines added, ${changed.removed} removed: open the changes`} onClick={() => openPanel("changes")}>
          <FileDiff className="k-docket-glyph" aria-hidden="true" />
          <span className="k-now-count" data-testid="dock-changes-count">
            <span className="k-now-files">{changed.files} {changed.files === 1 ? "file" : "files"}</span>
            <span className="font-mono text-micro text-ok">+{changed.added}</span>
            <span className="font-mono text-micro text-danger">-{changed.removed}</span>
          </span>
        </button>
      )}
      {ready && <span className="k-now-ready" data-testid="dock-ready">Ready to land</span>}
      {ready && land && <button type="button" className="k-docket-act" data-testid="dock-land" title="Every agent's branch as one diff by area: land, send back or drop each area" onClick={() => setLanding(true)}>Land</button>}
      {landing && land && <Suspense fallback={null}><TreeReviewDialog session={land} onClose={() => setLanding(false)} /></Suspense>}
    </span>
  );
}

// The work board's say, read only where the session has agents in its tree (or is one), as the Board panel reads
// it, so a session with none costs no board.
function BoardChangesPart({ sessionId, root, changed }: { sessionId: string; root: string; changed: Changed | null }) {
  const b = useBoard(root);
  const rootSession = useStore((s) => s.sessions[root]);
  // An agent's own branch; a coordinator's whole tree (what is left to land, and all of it ready).
  const rows = b ? (root === sessionId ? b.rows.filter((r) => toLand(r)) : b.rows.filter((r) => r.session_id === sessionId)) : [];
  const ready = rows.length > 0 && rows.every((r) => readyToLand(r));
  return <ChangesPart changed={changed} ready={ready} land={rootSession} />;
}

// The session's background commands: one chip in the line of the plan and the agents that opens each command, its
// last line and its end, with Stop for one that runs.
function JobsChip({ sessionId, jobs, cut }: { sessionId: string; jobs: JobView[]; cut: Set<string> }) {
  const running = jobs.filter((j) => j.running).length;
  const words = `${jobs.length} ${jobs.length === 1 ? "command" : "commands"}`;
  return (
    <Popover.Root>
      <Popover.Trigger className="k-docket-line k-docket-jobs" data-testid="dock-jobs" data-running={running > 0 || undefined} aria-label={`${words}${running ? `, ${running} running` : ""}`} title={words}>
        <SquareTerminal className="k-docket-glyph" aria-hidden="true" />
        <span className="k-docket-jobs-n k-face-figure">{jobs.length}</span>
        <span className="k-docket-jobs-word">{jobs.length === 1 ? "command" : "commands"}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" side="top" className="z-50 outline-none">
          <Popover.Popup data-testid="dock-jobs-popup" className="w-[min(30rem,calc(100vw-1rem))] max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-raised py-1 shadow-3 outline-none">
            {jobs.map((j) => <JobRow key={j.id} sessionId={sessionId} j={j} cut={cut} />)}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function JobRow({ sessionId, j, cut }: { sessionId: string; j: JobView; cut: Set<string> }) {
  return (
    <div className="k-docket-line k-docket-job" data-testid="dock-job" data-running={j.running || undefined}>
      {/* A command at work is drawn in work's color; one that ended steps back. */}
      <SquareTerminal className="k-docket-glyph" />
      <span className="min-w-0 max-w-[40%] shrink-0 truncate text-fg max-md:max-w-none max-md:shrink max-md:flex-1 max-md:whitespace-normal max-md:break-words" title={j.id}>{j.description ?? j.command}</span>
      {/* On a phone what it last wrote, its id and its time are a line under its name. */}
      <span className="k-job-meta">
        <span className="min-w-0 flex-1 truncate font-mono text-micro text-faint max-md:whitespace-normal max-md:break-all" title={j.last} data-testid="dock-job-last">{j.last}</span>
        {/* Its id is the tooltip of its name at a desk; a phone opens no tooltip, so there it is a word. */}
        <span className="shrink-0 font-mono text-micro text-faint md:hidden" data-testid="dock-job-id">{j.id}</span>
        <span className="k-face-figure shrink-0 text-micro text-faint">
          {j.running ? since(j.started) : j.stop_reason === "was stopped by the owner" ? "Stopped by you" : j.stop_reason ? j.stop_reason.replace(/^was /, "") : j.signal ? `killed by ${j.signal}`
            // Its call was cut by a restart and the command went on without it: said as that, not as a bare exit code beside "cut".
            : j.call_id && cut.has(j.call_id) ? (j.exit_code == null ? "went on after the restart, then ended" : j.exit_code === 0 ? "went on after the restart and finished" : `went on after the restart and failed (exit ${j.exit_code})`)
            : j.exit_code == null ? "ended, exit unknown" : `exit ${j.exit_code}`}
        </span>
      </span>
      {j.running && (
        <button
          type="button"
          title={`Stop ${j.id}`}
          data-testid="dock-job-stop"
          onClick={() => actions.stopJob(sessionId, j.id).catch(reportError)}
          className="k-job-stop -mr-1 grid size-ctl-sm place-items-center rounded-md text-faint hover:bg-danger-soft hover:text-danger"
        >
          <Square className="size-3" />
        </button>
      )}
    </div>
  );
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
        if (b.type === "tool_use" && toolKind(b.name) === "plan" && accepted.has(b.id)) return { plan: planItems(b.name, b.input), at: e.ts, before: 0 };
      }
    }
    // The page holds the end of the branch: a plan accepted before that part is asked for.
    return { plan: null, at: 0, before: line.length && line[0]!.parent !== null ? line[0]!.seq : 0 };
  }, [events, head]);
  const [older, setOlder] = useState<{ key: string; plan: ReturnType<typeof planItems> | null; at: number; turns: number } | null>(null);
  const key = held?.before ? `${sessionId} ${held.before}` : "";
  useEffect(() => {
    if (!key) return;
    let stop = false;
    api<{ call: { name: string; input: unknown } | null; ts?: number; turns?: number }>(`/api/sessions/${sessionId}/last-call?names=${PLAN_TOOLS.join(",")}&before=${held!.before}`)
      .then((r) => { if (!stop) setOlder({ key, plan: r.call ? planItems(r.call.name, r.call.input) : null, at: r.ts ?? 0, turns: r.turns ?? 0 }); })
      .catch((e) => reportUnlessGone(e, { at: "dock plan" }));
    return () => { stop = true; };
  }, [key]);
  const plan = held?.plan ?? (older?.key === key ? older.plan : null);
  const jobs = useJobs(sessionId, working);
  const changed = useChanged(sessionId);
  const root = useStore((s) => rootOf((id) => s.sessions[id]?.parent_id, sessionId));
  const tree = useTreeMark(root);
  const agents = useAgentsTally(sessionId);
  // A plan the session left alone while it went on is one quiet line (lib/plan-age.ts); a finished or
  // marked-finished one is not shown. (An older plan whose age is not known yet is shown as it stands.)
  const clock = useMinute();
  const doneMs = useStore((s) => s.sessions[sessionId]?.settings.done_ms);
  const archived = useStore((s) => !!s.sessions[sessionId]?.archived);
  const known = held?.plan ? { at: held.at, turns: events ? turnsSince(events, held.at) : 0 } : older?.key === key && older.at ? { at: older.at, turns: older.turns + (events ? turnsSince(events, 0) : 0) } : null;
  const state = plan && known ? planState({ ...known, now: clock, working, items: plan, endedAt: archived ? Number.MAX_SAFE_INTEGER : doneMs }) : "live";
  const active = !inPanel && plan && plan.some((p) => p.status !== "completed" && p.status !== "cancelled") && state !== "ended";
  const done = plan?.filter((p) => p.status === "completed").length ?? 0;
  const now = plan?.find((p) => p.status === "in_progress");
  const planLineEl = active && plan ? (
    <Collapsible.Trigger className="k-docket-line k-docket-planline" data-testid="dock-plan">
      <ListChecks className="k-docket-glyph" />
      {state === "stale" && known ? (
        <span className="min-w-0 truncate text-faint max-md:whitespace-normal max-md:break-words" data-testid="dock-plan-stale">{planLine("stale", { ...known, now: clock, items: plan })}</span>
      ) : (
        <>
          <span className="k-face-figure k-docket-n">{done}/{plan.length}</span>
          <span className="min-w-0 truncate max-md:whitespace-normal max-md:break-words">{now ? (now.active ?? now.text) : "Plan"}</span>
          <span className="k-docket-track" aria-hidden="true"><span style={{ width: `${(100 * done) / plan.length}%` }} /></span>
        </>
      )}
      <ChevronRight className="k-docket-more transition-transform group-data-[open]/plan:rotate-90" />
    </Collapsible.Trigger>
  ) : null;
  const row = (planLineEl || agents || jobs.length > 0) ? (
    <div className="k-docket-row">
      {planLineEl}
      {agents && <AgentsDock sessionId={sessionId} />}
      {jobs.length > 0 && <JobsChip sessionId={sessionId} jobs={jobs} cut={cut} />}
    </div>
  ) : null;
  return (
    // A quiet ledger over the box, two lines set on the page with their words lined up with the box's: the plan and the
    // agents (and the commands that run on their own) above; below, what the turn does now, where, and what it changed.
    // Only the plan, opened, is a surface of its own (styles.css, .k-docket-top).
    <div className="k-docket" data-testid="session-dock">
      {active && plan ? (
        <Collapsible.Root className="k-docket-top group/plan" data-testid="dock-top">
          {row}
          <Collapsible.Panel className="k-docket-panel">
            <PlanCard items={plan} live />
          </Collapsible.Panel>
        </Collapsible.Root>
      ) : row && <div className="k-docket-top" data-testid="dock-top">{row}</div>}
      <DockNow sessionId={sessionId} changes={tree ? <BoardChangesPart sessionId={sessionId} root={root} changed={changed} /> : <ChangesPart changed={changed} ready={false} />} />
    </div>
  );
}
