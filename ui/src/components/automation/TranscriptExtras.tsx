import { Collapsible } from "@base-ui/react/collapsible";
import { AlertTriangle, Bot, ChevronRight, CornerDownRight, ExternalLink, Flag, FolderLock, GitBranch, GitMerge, Mail, Network, Radio, RotateCcw, ScanSearch, Repeat, Sprout, Timer, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StoredEvent, ToolResultBlock, ToolUseBlock } from "../../../../src/core/types.ts";
import { auto, isLive, openSession, useAuto, type AgentRecord } from "../../lib/automation.ts";
import { machineName } from "../../lib/fleet.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { resultText } from "../../lib/tools.ts";
import { CALL_FAILED, CALL_STOPPED, agentTask, callState, failureLine, type CallState } from "../../lib/work.ts";
import { Apart, Under } from "../ToolCall.tsx";
import { savePref } from "../../lib/ui.ts";
import { cn } from "../../lib/utils.ts";
import { STATE_WORD } from "../../../../src/core/state-words.ts";
import { Markdown } from "../Markdown.tsx";
import { Seg } from "../Seg.tsx";
import { ChannelEvent } from "../ChannelEvent.tsx";
import { AgentMark, AgentNow, agentSaid, IconButton, STATE_INK, StopAgent, useAgentSaid, type AgentSaid } from "./bits.tsx";

export const AGENT_TOOLS = new Set(["Agent", "spawn_agent"]);
export { SYSTEM_INPUT } from "../../../../src/core/owner.ts";
import { SYSTEM_INPUT } from "../../../../src/core/owner.ts";

type Report = { id: string; title: string; status: AgentRecord["status"]; said: AgentSaid; text: string; key: string; task?: string };

// The daemon escapes only a frame's own tag inside it (core.ts inert): only
// that is undone here, so a report's own "&lt;" stays as it was written.
const unframe = (text: string, tag: string) => text.replace(new RegExp(`&lt;(\\s*/?\\s*${tag})`, "gi"), "<$1");
const attrOf = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

// `meta`: the input's meta; each report takes its report_id from the parts in
// order (an input can carry two reports of one agent, one per task). Older
// inputs have none: agent and position stand in.
function reports(text: string, meta?: Record<string, any>): Report[] {
  const out: Report[] = [];
  const parts = ((meta?.parts ?? [meta ?? {}]) as Record<string, any>[]).filter((p) => p.kind === "subagent");
  const used = new Set<number>();
  const re = /<subagent_result agent_id="([^"]*)" title="([^"]*)" status="([^"]*)"([^>]*)>\n?([\s\S]*?)\n?<\/subagent_result>/g;
  for (const m of text.matchAll(re)) {
    const status = m[3] as Report["status"];
    const at = parts.findIndex((p, i) => !used.has(i) && p.agent_id === m[1]);
    if (at >= 0) used.add(at);
    const key = (at >= 0 && parts[at]!.report_id) || `${m[1]}#${out.length}`;
    // How it ended, in the word its tree row and its card use (src/core/state-words.ts).
    out.push({ id: m[1]!, key, title: m[2]!, status, text: unframe(m[5]!, "subagent_result"), said: agentSaid({ status, stopped_by: attrOf(m[4]!, "stopped_by"), end_reason: attrOf(m[4]!, "ended") }, undefined) });
  }
  // One agent with more than one report here: each says which task it answers.
  for (const r of out) {
    const same = out.filter((o) => o.id === r.id);
    if (same.length > 1) r.task = same.at(-1) === r ? "latest task" : "earlier task";
  }
  return out;
}

// The failure notice inside an input (src/automation/failures.ts): its entries,
// the lines after them, and the input's text without it.
const FAILURES = /\[harness\] Failures in this session's work[^\n]*\n<failures>\n([\s\S]*?)\n<\/failures>((?:\n(?!\n)[^\n]*)*)/g;
function failuresOf(text: string, meta: Record<string, any>) {
  const part = ((meta.parts ?? [meta]) as Record<string, any>[]).find((p) => p.kind === "failures");
  if (!part) return undefined;
  // The last one: the notice goes after what it comes with, so a report that quotes one is not taken for it.
  const m = [...text.matchAll(FAILURES)].at(-1);
  if (!m) return undefined;
  // What the entries name: a failure left to a report in the same input is not counted here.
  const groups = ((part.groups ?? []) as { owed: number; said?: number }[]).map((g) => g.said ?? g.owed ?? 0).filter((n) => n > 0);
  const n = groups.reduce((s, g) => s + g, 0);
  return {
    body: unframe(m[1]!, "failures"),
    after: m[2]!.trim(),
    rest: (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim(),
    sub: `${n} failure${n === 1 ? "" : "s"}, ${groups.length} cause${groups.length === 1 ? "" : "s"}`,
  };
}

// An input's parts that have cards of their own, and its text without them:
// what a loop run, a goal's input or another message said in the same input.
const hasCard = (p: Record<string, any>) => p.kind === "subagent" || p.kind === "wait" || p.kind === "failures" || (p.kind === "harness" && p.status === "waiting");
const CARDED = /(?:Reports from agents you started follow\.[^\n]*\n)?<subagent_result [^>]*>[\s\S]*?<\/subagent_result>(?:\n(?!\n)[^\n]*)*|<wait_fired [^>]*>[\s\S]*?<\/wait_fired>|<monitor_event [^>]*>[\s\S]*?<\/monitor_event>|^\[harness\] Agent \S+ (?:parked on|\("[^\n]*"\) waits for) [^\n]*$/gm;
const withoutCards = (text: string) => text.replace(CARDED, "").replace(/\n{3,}/g, "\n\n").trim();

// Each wake with its own header: a monitor's note (or short id) beside its batch number.
function wakes(text: string) {
  const out: { label: string; body: string }[] = [];
  const re = /<wait_fired id="[^"]*" kind="([^"]*)" outcome="([^"]*)">\n?([\s\S]*?)\n?<\/wait_fired>|<monitor_event id="([^"]*)" batch="(\d+)"([^>]*)>\n?([\s\S]*?)<\/monitor_event>/g;
  for (const m of text.matchAll(re)) {
    if (m[5]) out.push({ label: `${attrOf(m[6]!, "note") || `monitor ${m[4]!.slice(-6)}`} · batch ${m[5]}`, body: unframe(m[7]!, "monitor_event").trimEnd() });
    else out.push({ label: m[2] === "fired" ? `${m[1]} fired` : m[2] === "timeout" ? `${m[1]} timed out` : `${m[1]} ${m[2]}`, body: unframe(m[3]!, "wait_fired") });
  }
  return out;
}

// What a wait waits for, then where: the condition comes first so two waits
// on the same target read differently.
export function waitWhat(k: any): string {
  switch (k.kind) {
    case "timer": return k.seconds !== undefined ? `timer ${k.seconds}s` : "timer";
    case "file": return k.contains !== undefined ? `contains "${k.contains}" · ${k.path}` : `exists · ${k.path}`;
    case "log": return `line /${k.match}/ · ${k.path}`;
    case "http": return `HTTP ${k.status ?? "2xx/3xx"} · ${k.url}`;
    case "process": return `process ${k.pid} ends`;
    case "pr_checks": return `checks done · ${k.repo}#${k.pr_number}`;
    default: return `${k.kind ?? "wait"} ${k.path ?? k.url ?? k.pid ?? ""}`.trim();
  }
}

// One line for the automation tools' cards.
export function toolSummary(name: string, input: any): string | undefined {
  switch (name) {
    case "WaitFor": case "wait_for":
      return `${waitWhat(input)}${input.note ? ` · ${input.note}` : ""}`;
    case "Monitor": case "monitor":
      return `${input.description ? `${input.description} · ` : ""}${input.command ?? ""}`;
    case "ScheduleWakeup": case "schedule_wakeup":
      return input.stop ? "stop the loop" : `next run in ${input.delaySeconds ?? input.delay_seconds ?? "?"}s${input.reason ? ` · ${input.reason}` : ""}`;
    case "CronCreate": case "schedule_create":
      return `${input.cron ?? input.schedule} · ${input.prompt ?? ""}`;
    case "CronDelete": case "schedule_delete": case "TaskStop": case "cancel_wait": case "close_agent":
      return input.id ?? input.task_id ?? input.wait_id ?? input.target;
    case "SendMessage": case "send_input":
      return `${input.to ?? input.target} · ${input.summary ?? input.message ?? ""}`;
    case "PushNotification": case "notify":
      return input.message ?? input.text;
    case "CronList": case "schedule_list":
      return "scheduled tasks, waits and agents";
    case "advisor":
      return input.question ? `question: ${input.question}` : "a check of where things stand";
    default:
      return undefined;
  }
}

// `kind` gives the line's glyph its ink (transcript.css): a wake, a goal and a loop read apart at a glance.
function Shell({ icon: Icon, label, sub, children, testid, defaultOpen, tone, kind }: { icon: typeof Bot; label: string; sub?: string; children?: React.ReactNode; testid: string; defaultOpen?: boolean; tone?: "danger"; kind?: "wake" | "goal" | "loop" }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="k-heard group/in animate-in" data-tone={tone} data-kind={kind} data-testid={testid}>
      <Collapsible.Trigger className="k-heard-line">
        <Icon />
        <span className="k-heard-who">{label}</span>
        {sub && <span className="k-heard-what truncate">{sub}</span>}
        <ChevronRight className="k-heard-chev group-data-[open]/in:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="k-heard-body">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

// What a report of an agent with a branch of its own leads to: its branch reviewed (the Review
// panel, findings back to that agent), and its session. The report says where the work is; these
// are the ways to it from the report itself. (Landing it is the owner's, from there.)
function ReportActions({ a }: { a?: AgentRecord }) {
  if (!a?.branch || isLive(a)) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-caption" data-testid="agent-report-actions">
      <span className="k-line-chip" data-code="" title={a.worktree ? `Its own worktree: ${a.worktree}` : undefined}><GitBranch className="size-3" />{a.branch}</span>
      {!a.machine && (
        <button type="button" className="k-btn" data-testid="agent-report-review" onClick={() => auto.reviewAgent(a).then(() => savePref("panel", "review")).catch(reportError)}>
          <ScanSearch className="size-3.5" /> Review the branch
        </button>
      )}
      <button type="button" className="k-btn" data-testid="agent-report-open" onClick={() => openSession(a.session_id)}>
        <ExternalLink className="size-3.5" /> Open its session
      </button>
    </div>
  );
}

// A message the harness put in the conversation: an agent's report, a wake, a
// loop run, a task. Shown as what it is, never as the owner's words.
export function InputNotice({ e }: { e: StoredEvent }) {
  const kind = e.data.kind as string;
  const text = String(e.data.text ?? "");
  const sessions = useStore((s) => s.sessions);
  const agents = useAuto((s) => s.agents);
  const rs = useMemo(() => reports(text, e.data), [text, e.data]);
  const ws = useMemo(() => wakes(text), [text]);
  const fails = useMemo(() => failuresOf(text, e.data), [text, e.data]);

  // One input can carry agents' reports and wakes together: every part shows.
  const reportCards = rs.length > 0 && (kind === "subagent" || kind === "wake") && (
    <div className="flex flex-col gap-0.5 animate-in" data-testid="agent-reports">
      {rs.map((r) => (
        <Collapsible.Root key={r.key} className="k-heard group/rep" data-testid="agent-report" data-status={r.status}>
          <Collapsible.Trigger className="k-heard-line">
            <CornerDownRight />
            <AgentMark w={r.said.watch} />
            {/* The agent by its title; its id is on hover. */}
            <span className="k-heard-who min-w-[3rem] shrink truncate" title={`${r.title} (agent ${r.id})`}>{r.title}</span>
            {/* The word first and whole: what gives way in a narrow pane is the rest of the line. */}
            <span className={cn("shrink-0 whitespace-nowrap", STATE_INK[r.said.watch])} data-testid="agent-report-state">{r.said.phrase}</span>
            {/* The rest gives way: cut at its end while "· reported" has room, and gone whole where it has not. */}
            <span className="k-report-rest text-faint"><span data-testid="agent-report-status">· reported{r.task ? ` · ${r.task}` : ""}{r.said.why ? ` · ${r.said.why}` : ""}</span></span>
            <ChevronRight className="k-heard-chev group-data-[open]/rep:rotate-90" />
          </Collapsible.Trigger>
          <Collapsible.Panel className="k-heard-body text-ui text-fg">
            <Markdown text={r.text} />
            <ReportActions a={agents[r.id]} />
          </Collapsible.Panel>
        </Collapsible.Root>
      ))}
    </div>
  );
  const wakeCard = (kind === "wait" || (kind === "wake" && ws.length > 0)) && (
    <Shell icon={kind === "wait" && e.data.outcome === "event" ? Radio : Timer} label={`Woken: ${ws.map((w) => w.label).join(", ") || "a wait ended"}`} testid="wake-notice" kind="wake">
      <div className="flex max-h-60 flex-col gap-2 overflow-auto rounded-md bg-code p-2.5 font-mono text-caption text-muted">
        {ws.length ? ws.map((w, i) => (
          <div key={i} data-testid="wake-part">
            <div className="text-faint">{w.label}</div>
            <pre className="whitespace-pre-wrap">{w.body}</pre>
          </div>
        )) : <pre className="whitespace-pre-wrap">{text}</pre>}
      </div>
    </Shell>
  );
  const parks = ((e.data.parts ?? [e.data]) as Record<string, any>[]).filter((p) => p.kind === "harness" && p.status === "waiting" && typeof p.waiting_on === "string");
  // An agent that waits is named by its title, as its row and its card name it; its id stands at the end.
  const parkCards = parks.map((p) => {
    const a = agents[p.agent_id as string];
    const title = (a && sessions[a.session_id]?.title) || a?.title || (typeof p.title === "string" && p.title) || `Agent ${p.agent_id}`;
    return (
      <Shell key={p.agent_id} icon={Timer} label={`Agent ${STATE_WORD.wait.toLowerCase()}`} sub={title} testid="agent-park-notice">
        <p className="whitespace-pre-wrap text-ui text-muted">{title} waits for {p.waiting_on}. It has not ended. <span className="text-faint" data-testid="agent-park-id">Agent {p.agent_id}</span></p>
      </Shell>
    );
  });
  // What failed around the session, one entry per cause: open, since it is what needs a look.
  const failCard = fails && (
    <Shell icon={AlertTriangle} tone="danger" label="Failures, grouped by cause" sub={fails.sub} testid="failure-notice" defaultOpen>
      <div className="flex max-h-80 flex-col gap-2 overflow-auto rounded-md bg-code p-2.5 font-mono text-caption text-muted">
        {/* An entry's first line hangs; who failed, each with its own failure, sits under it, and stays there when a line wraps. */}
        <div data-testid="failure-entries">
          {fails.body.split("\n").map((line, i) => (
            <div key={i} className={cn("whitespace-pre-wrap break-words", line.startsWith("- ") ? "pl-4 -indent-4 text-fg" : "pl-8 text-muted", i > 0 && line.startsWith("- ") && "mt-1.5")}>{line.trimStart()}</div>
          ))}
        </div>
        {fails.after && <p className="whitespace-pre-wrap font-sans text-faint">{fails.after}</p>}
      </div>
    </Shell>
  );
  if (kind === "channel") return <ChannelEvent e={e} />;
  if (reportCards || wakeCard || parkCards.length || (failCard && !fails.rest)) {
    // A part with no card of its own in the same input (a loop run, a goal's
    // input, a steer that brought reports along): as it reads, first, since it
    // is what started the turn.
    const others = ((e.data.parts ?? []) as Record<string, any>[]).filter((p) => !hasCard(p));
    const rest = others.length ? withoutCards(fails ? fails.rest : text) : "";
    const own = rest ? <InputNotice e={{ ...e, data: others.length === 1 ? { ...others[0], text: rest } : { ...e.data, text: rest, parts: others } }} /> : null;
    return <div className="flex flex-col gap-2">{own}{reportCards}{wakeCard}{parkCards}{failCard}</div>;
  }
  // With another input that has no card of its own: that one as it reads, then the failures.
  if (failCard) {
    const others = ((e.data.parts ?? []) as Record<string, any>[]).filter((p) => p.kind !== "failures");
    const data = others.length === 1 ? { ...others[0], text: fails.rest } : { ...e.data, text: fails.rest, parts: others };
    return <div className="flex flex-col gap-2"><InputNotice e={{ ...e, data }} />{failCard}</div>;
  }
  // An agent's question about a write outside the paths it was given (src/automation/write-asks.ts): open, since its
  // parent's answer is what it waits for.
  if (kind === "write_asks") {
    return (
      <Shell icon={FolderLock} label="An agent asks to write outside its paths" testid="write-ask-notice" defaultOpen>
        <p className="whitespace-pre-wrap text-ui text-muted">{text.replace(/^\[harness\]\s*/, "")}</p>
      </Shell>
    );
  }
  if (kind === "loop") {
    return (
      <Shell icon={Repeat} label="Loop run" sub={e.data.loop_name} testid="loop-notice" kind="loop">
        <p className="whitespace-pre-wrap text-ui text-muted">{text}</p>
      </Shell>
    );
  }
  if (kind === "landing") {
    return (
      <Shell icon={GitMerge} label="Landing queue" testid="landing-notice" defaultOpen>
        <p className="whitespace-pre-wrap text-ui text-muted">{text.replace(/^\[harness\] Landing queue:\s*/, "")}</p>
      </Shell>
    );
  }
  if (kind === "goal") {
    const label = e.data.goal === "start" ? "Goal set" : e.data.goal === "resume" ? "Goal resumed" : "Goal not met yet: next turn";
    return (
      <Shell icon={Flag} label={label} testid="goal-notice" kind="goal" defaultOpen={e.data.goal === "start"}>
        <p className="whitespace-pre-wrap text-ui text-muted">{text.replace(/^\[harness\]\s*/, "")}</p>
      </Shell>
    );
  }
  if (kind === "task") {
    const parentId = sessions[e.session_id]?.parent_id;
    // The parent's words start at task_at; an older record without it shows the whole text.
    const at = e.data.task_at;
    const task = typeof at === "number" && at >= 0 && at <= text.length ? text.slice(at) : text;
    return (
      <div className="k-heard animate-in" data-testid="task-notice">
        <div className="k-heard-line">
          <Bot /> <span className="k-heard-who">Task from</span>
          {parentId ? (
            <button type="button" onClick={() => openSession(parentId)} className="flex min-h-ctl-sm items-center gap-1 font-medium text-fg hover:text-accent">
              {sessions[parentId]?.title || "the parent session"} <ExternalLink className="size-3" />
            </button>
          ) : <span className="font-medium text-fg">the parent session</span>}
        </div>
        <p className="k-heard-body whitespace-pre-wrap text-read leading-relaxed text-fg">{task}</p>
      </div>
    );
  }
  return (
    <Shell icon={Zap} label={kind === "steer" ? "Message from the parent session" : "Harness note"} testid="harness-notice" defaultOpen={kind === "steer"}>
      <p className="whitespace-pre-wrap text-ui text-muted">{text}</p>
    </Shell>
  );
}


// The card of an Agent / spawn_agent call: the child's live state, open, stop.
const ENDED_WORD: Partial<Record<CallState, string>> = { error: CALL_FAILED, denied: "denied by you", refused: "refused", stopped: CALL_STOPPED, cut: "cut by a restart" };

// The words the agent tools take for their default type (src/automation/tools.ts), and none.
const DEFAULT_TYPES = new Set(["", "general-purpose", "default", "worker"]);

export function AgentCall({ use, result, live }: { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean }) {
  const input: any = use.input ?? {};
  const out = resultText(result);
  const agents = useAuto((s) => s.agents);
  const title = agentTask(use);
  // The child this call started: the one its result names, or the one recorded
  // with this call's id. Never a guess by title: two agents can share one.
  const agent = useMemo(() => {
    const id = out.match(/agent[_ ](?:id=")?([0-9a-f]{12})|"agent_id":"([0-9a-f]{12})"/);
    if (id) return agents[id[1] ?? id[2]!];
    return Object.values(agents).find((a) => a.call_id === use.id);
  }, [agents, out, use.id]);
  // Its type is said when the call picked one: the default type on every line said nothing a line needs.
  const named = String(input.subagent_type ?? input.agent_type ?? "");
  const type = DEFAULT_TYPES.has(named.toLowerCase()) ? "" : named;
  // Its state in the word its tree row and the background list use (src/core/state-words.ts).
  const st = useAgentSaid(agent);
  const asking = st?.watch === "need";
  const aside = agent?.background && isLive(agent) && !asking;
  // An agent that failed says so beside its name, with the reason under its line.
  const failedAgent = !!agent && !isLive(agent) && agent.status !== "completed" && agent.status !== "stopped";
  const why = st?.why;
  const name = agent?.title ?? title;
  // With no agent the page knows of: how the call itself ended.
  const ended = !agent && result?.is_error ? callState(result) : undefined;

  return (
    <Collapsible.Root className="k-tool-call group/agent" data-testid="agent-call" data-state={failedAgent || (!agent && ended === "error") ? "error" : undefined}>
      {/* A line of the rail, as every call is: what it is, how it stands, its task; it opens to the task and the
          report. What can be done with the agent stands at the line's end, quiet until the line is pointed at. */}
      <div className="k-line-agent">
        <Collapsible.Trigger className="k-line">
          {/* (The words carry the title's name: what is cut, when the line is too narrow, is these words.) */}
          <span className="k-line-text" data-testid="agent-call-title">
            <span className="k-line-verb">Agent</span>{" "}
            {/* How it stands, beside the verb as on every line: it asks the owner, it runs, it failed, it was stopped.
                A finished agent needs no word on the page (it is said to a screen reader). */}
            {/* (The word is the one its row under the session and the list of background work say.) */}
            {agent && st && (
              <span className={st.watch === "done" ? "sr-only" : "k-line-state"} data-tone={asking ? "need" : failedAgent ? "fail" : "idle"} data-testid="agent-call-status" data-watch={st.watch} data-asking={asking || undefined} title={st.title}>
                <span data-testid="agent-call-state">{st.phrase}</span>{aside ? ", in background" : ""}{why ? <span className="sr-only"> · {why}</span> : null}
              </span>
            )}
            {/* A call that started no agent the page knows of says how it ended, by its result's own words. */}
            {!agent && ended && <span className="k-line-state" data-tone={ended === "error" ? "fail" : ended === "denied" ? "own" : ended === "stopped" ? "idle" : "warn"} data-testid="agent-call-ended">{ENDED_WORD[ended]}</span>}
            {" "}<span className="k-line-what" data-words="">{name}</span>
          </span>
          {/* What its parent sent and it has not read yet, kept in its queue. On a
              narrow line its words go before the agent's title is cut: it shrinks
              to the icon and the count, and its tooltip says the rest. */}
          {!!agent?.messages_waiting && (
            <span
              className="k-line-chip k-line-chip-gives"
              data-testid="agent-call-waiting"
              title={`${agent.messages_waiting === 1 ? "1 message" : `${agent.messages_waiting} messages`} sent to this agent and kept in its queue: it reads ${agent.messages_waiting === 1 ? "it" : "them"} at its next step, or when it goes on`}
            >
              <Mail className="size-3 shrink-0" /><span className="shrink-0">{agent.messages_waiting}</span><span className="min-w-0 truncate">{agent.messages_waiting === 1 ? "message waiting" : "messages waiting"}</span>
            </span>
          )}
          <span className="k-line-end">
            <Apart />
            {/* Where its last follow-up started (src/engine/follow-up.ts): said when it did not go on in its context. */}
            {agent?.start && agent.start.way !== "carry" && (
              <span className="k-line-chip" data-testid="agent-call-start" data-way={agent.start.way} title={agent.start.why}>
                <Sprout className="size-3 shrink-0" />{START_CHIP[agent.start.way]}
              </span>
            )}
            {/* Contexts its task lost, each taken up by a fresh one (src/automation/successor.ts). */}
            {!!agent?.lost?.length && (
              <span className="k-line-chip" data-testid="agent-call-successor" title={agent.lost.map((l, i) => `Context ${i + 1}: ${LOSS_WORDS[l.kind]}${l.category ? ` (${l.category})` : ""}, on ${l.model}`).join("\n")}>
                <RotateCcw className="size-3 shrink-0" />{agent.lost.length === 1 ? "fresh context" : `${agent.lost.length} fresh contexts`}
              </span>
            )}
            {type && <span className="k-line-chip" data-testid="agent-call-type">{type}</span>}
            {agent?.branch && <span className="k-line-chip k-line-branch" data-code="" data-testid="agent-call-branch" title={`${agent.branch}, in its own worktree: ${agent.worktree}`}><GitBranch className="size-3" />{agent.branch}</span>}
            {(agent?.machine || input.machine) && <span className="k-line-chip" data-testid="agent-call-machine" title="Its tools run on this machine"><Network className="size-3" />{machineName(agent?.machine) ?? String(input.machine)}</span>}
            {agent?.structured && <span className="k-line-chip" data-code="" data-testid="agent-call-structured">json</span>}
            {(agent ? isLive(agent) && !asking : live) && <span className="k-line-run" aria-hidden="true" />}
          </span>
        </Collapsible.Trigger>
        {agent && (
          <span className="k-line-acts">
            {/* (A stop is not undone: it asks first, as on the agent's row.) */}
            {isLive(agent) && <StopAgent a={agent} title={agent.title} testid="agent-call-stop" />}
            {!isLive(agent) && agent.branch && !agent.machine && (
              <IconButton title={`Review the work of agent ${name}`} onClick={() => auto.reviewAgent(agent).then(() => savePref("panel", "review")).catch(reportError)} testid="agent-call-review"><ScanSearch className="size-3.5" /></IconButton>
            )}
            <IconButton title={`Open the session of agent ${name}`} onClick={() => openSession(agent.session_id)} testid="agent-call-open"><ExternalLink className="size-3.5" /></IconButton>
          </span>
        )}
      </div>
      {/* What it is doing now, under its line while it is live (at most a line every 15 s). */}
      {agent && isLive(agent) && <div className="k-under"><AgentNow a={agent} /></div>}
      {/* Why it ended as it did, under its line: a failure's reason in its ink, a stop's quietly. */}
      {agent && !isLive(agent) && why && <div className="k-under"><Under tone={failedAgent ? "fail" : "note"} testid="agent-call-why">{why}</Under></div>}
      {!agent && ended === "error" && <div className="k-under"><Under code tone="fail" testid="agent-call-why">{failureLine(result)}</Under></div>}
      <Collapsible.Panel className="k-tool-panel overflow-hidden">
        <div className="k-label px-3 pt-2.5">Task</div>
        <p className="px-3 pt-1 text-ui whitespace-pre-wrap text-muted">{input.prompt ?? input.message}</p>
        <AgentReport agent={agent} out={out} />
        {!!agent?.lost?.length && <LostContexts agent={agent} />}
        {agent && <FollowUps agent={agent} />}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

// The contexts the agent's task lost, oldest first: why each ended, on which
// model, and its session, kept as it was.
const LOSS_WORDS = {
  refusal: "the model declined to go on",
  context: "its context could not be made to fit",
  provider: "its provider kept failing",
} as const;
function LostContexts({ agent }: { agent: AgentRecord }) {
  return (
    <div className="px-3 pb-2" data-testid="agent-lost">
      <div className="k-label pt-1">Earlier contexts</div>
      <ol className="pt-1 text-ui text-muted">
        {agent.lost!.map((l, i) => (
          <li key={l.session} className="flex items-center gap-2" data-testid="agent-lost-row" data-kind={l.kind}>
            <span className="min-w-0 truncate">{i + 1}. {LOSS_WORDS[l.kind]}{l.category ? ` (${l.category})` : ""}, on {l.model}</span>
            <IconButton title="Open the session of that context" onClick={() => openSession(l.session)} testid="agent-lost-open"><ExternalLink className="size-3.5" /></IconButton>
          </li>
        ))}
      </ol>
      <p className="pt-1 text-caption text-faint">Each was taken up by a fresh context from a capsule of its work, in the same worktree.</p>
    </div>
  );
}

// Where a follow-up to the finished agent starts: what its last one did and
// why, and the owner's choice for the next ones (Keel decides by price unless
// the owner names a way).
const START_CHIP = { carry: "in its context", summary: "from a summary", capsule: "fresh start" } as const;
type Force = "auto" | keyof typeof START_CHIP;
function FollowUps({ agent }: { agent: AgentRecord }) {
  const s = agent.start;
  const force: Force = agent.start_force ?? "auto";
  return (
    <div className="px-3 pb-3" data-testid="agent-follow-ups">
      <div className="k-label pt-1">Follow-ups</div>
      {s && (
        <p className="pt-1 text-ui text-muted" data-testid="agent-start-why" data-way={s.way}>
          {s.why}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <span className="text-caption text-muted">Next ones start</span>
        <Seg<Force>
          label="Where this agent's follow-ups start"
          testid="agent-start-force"
          value={force}
          onChange={(v) => auto.setAgentStart(agent, v).catch(reportError)}
          options={[
            { value: "auto", label: "Cheapest", title: "Keel prices each way and takes the cheapest", testid: "agent-start-auto" },
            { value: "carry", label: "In its context", title: "Always go on in its whole context", testid: "agent-start-carry" },
            { value: "summary", label: "From a summary", title: "Replace its context with a summary first", testid: "agent-start-summary" },
            { value: "capsule", label: "Fresh", title: "Start fresh from a capsule of its work: its task, its report, the files and commands of its work", testid: "agent-start-capsule" },
          ]}
        />
      </div>
    </div>
  );
}

// An ended agent's report, read when its card is opened (the panel is not there while it is closed):
// the page's list of agents leaves the reports out. Kept per agent and end, so opening again reads nothing.
const readReports = new Map<string, string | null>();
const reportKey = (a: AgentRecord) => `${a.id}:${a.ended ?? 0}:${a.tasks}:${a.report_chars}`;
function AgentReport({ agent, out }: { agent?: AgentRecord; out: string }) {
  const ended = !!agent && !isLive(agent) && agent.report_chars > 0;
  const key = ended ? reportKey(agent) : "";
  const [, loaded] = useState(0);
  useEffect(() => {
    if (!ended || readReports.has(key)) return;
    let on = true;
    auto.agentReport(agent!).then((r) => { readReports.set(key, r); if (on) loaded((n) => n + 1); }).catch(reportError);
    return () => { on = false; };
  }, [key]);
  const report = ended ? readReports.get(key) ?? undefined : undefined;
  // (Until it is read, the call's own result says what it can: a foreground agent's report is in it.)
  if (!report && !out) return <div className="h-2.5" />;
  return (
    <>
      <div className="k-label px-3 pt-3">Report</div>
      <div className="px-3 pt-1 pb-3 text-ui" data-testid="agent-call-report">
        {agent?.structured && report && agent.status === "completed"
          ? <pre data-testid="agent-call-json" className="overflow-x-auto rounded-md bg-code px-3 py-2 font-mono text-caption">{report.split("\n\n")[0]}</pre>
          : <Markdown text={report ?? out} />}
        {agent?.structured && report && agent.status === "completed" && report.includes("\n\n") && <p className="pt-2 text-caption text-muted">{report.slice(report.indexOf("\n\n") + 2)}</p>}
      </div>
    </>
  );
}
